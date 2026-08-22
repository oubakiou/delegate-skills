import { spawnSync } from 'node:child_process'
import path from 'node:path'
import type { Env } from './build-request.ts'
import type { CliResult } from './cli-result.ts'
import { recordUsage } from './observe-store.ts'
import {
  OPENCODE_CAPTURE_MAX_BYTES,
  OPENCODE_CAPTURE_MAX_LINE_BYTES,
  estimatedUsage,
  summarizeOpencodeCapture,
  usageFromOpencodeCapture,
} from './observe-usage.ts'
import { promptConstraints } from './prompt-constraints.ts'
import {
  completeResponse,
  effortFailure,
  finishWithoutChild,
  finalizeResponse,
  makeWrapperContext,
  parseWrapperArgs,
  quietly,
  responderSessionIdOf,
  workerPrompt,
  wrapperResult,
  writePromptFile,
  type WrapperContext,
} from './wrapper-common.ts'
import {
  buildResponseFromStdoutText,
  buildFailedResponseFromStdoutText,
  reportModeForBackend,
  requestPromptStep,
  requestInlineMax,
  type RequestPromptStep,
} from './wrapper-report.ts'
import { executablePaths, spawnWorker, waitWithHeartbeat, type WaitResult } from './wrapper-wait.ts'

const OPENCODE_SELECTOR = 'opencode/'
const OPENCODE_VERSION_TIMEOUT_MS = 10_000
const OPENCODE_VERSION_MAX_BYTES = 16_384
const PURE_TASK_TYPES = new Set(['explore', 'review', 'htmldoc'])

const opencodePromptTailLines = [
  '3. 作業完了後、最終応答として front-matter 付き Markdown だけを返す。先頭に',
  '   ---',
  '   status: <completed | partial | failed | needs_input のいずれか>',
  '   ---',
  '   の front-matter を置き、その下に見出し Summary / Changed files / Commands / Verification / Findings / Blockers / Error の本文を書く。',
  '   report は簡潔に書く: Summary は 5 行以内。Findings は重要なものに絞る。コマンドの生ログは貼らず、Verification は実行コマンドと結果（exit code / pass・fail）のみ。該当が無い見出しは省く。',
  '   JSON やコードフェンスで全体をラップせず、md2idx / jq / build-response.sh によるレスポンス生成はしない。',
] as const

const opencodeTextEvent = (text: string): string => JSON.stringify({ type: 'text', part: { text } })

const versionOutputOf = (candidate: string, env: Env, timeoutMs: number): string | null => {
  const result = spawnSync(candidate, ['--version'], {
    encoding: 'utf8',
    env: { ...env },
    killSignal: 'SIGKILL',
    maxBuffer: OPENCODE_VERSION_MAX_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  })
  if (result.error || result.status !== 0) {
    return null
  }
  const output = (result.stdout ?? '').trim()
  if (output === '') {
    return null
  }
  return output
}

export const resolveOpencode = (
  env: Env,
  timeoutMs = OPENCODE_VERSION_TIMEOUT_MS
): string | null => {
  for (const candidate of executablePaths('opencode', env)) {
    if (versionOutputOf(candidate, env, timeoutMs) !== null) {
      return candidate
    }
  }
  return null
}

export const stripOpencodeSelector = (model: string): string => {
  if (model.startsWith(OPENCODE_SELECTOR)) {
    return model.slice(OPENCODE_SELECTOR.length)
  }
  return model
}

export const opencodePureEnabled = (env: Env): boolean => {
  const value = (env.DELEGATE_OPENCODE_PURE ?? '').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

const usePureMode = (context: WrapperContext): boolean =>
  PURE_TASK_TYPES.has(context.args.taskType) || opencodePureEnabled(context.env)

export const opencodeConfigContent = (taskType: string): string => {
  const config: Record<string, unknown> = {}
  if (taskType === 'explore' || taskType === 'review') {
    config.permission = { edit: 'deny' }
  }
  return JSON.stringify(config)
}

export const opencodeCliArgs = (context: WrapperContext, cliModel: string): string[] => {
  const args = ['run', '--format', 'json', '-m', cliModel]
  if (context.effort !== '') {
    args.push('--variant', context.effort)
  }
  if (usePureMode(context)) {
    args.push('--pure')
  }
  return args
}

export const lastTextFromCapture = (captureFile: string): string | null => {
  const summary = summarizeOpencodeCapture(captureFile)
  if (summary === null || !summary.sawTextEvent) {
    return null
  }
  return summary.lastText
}

const opencodeCapturedText = (context: WrapperContext, wait: WaitResult): string | null => {
  if (wait.childStatus !== 0) {
    return null
  }
  return lastTextFromCapture(context.stdoutCapture)
}

// A missing provider cost is distinct from a free-model cost of zero, so the generic
// price-table fallback must not add an estimate to opencode's measured usage.
const OPENCODE_EMPTY_PRICE_TABLE = { models: [], aliases: [] }

const recordOpencodeUsage = (context: WrapperContext): void => {
  quietly(() => {
    recordUsage({
      observeFile: context.args.observeFile,
      runDir: context.workDir,
      backend: context.backend,
      model: context.args.originalModel,
      requestFile: context.args.requestFile,
      responseFile: context.args.responseFile,
      source: 'opencode_step_finish',
      measured: usageFromOpencodeCapture(context.stdoutCapture, {
        model: context.args.originalModel,
        backend: context.backend,
      }),
      pricesTable: OPENCODE_EMPTY_PRICE_TABLE,
    })
  })
}

const opencodeChildEnv = (context: WrapperContext): Record<string, string | undefined> => ({
  ...context.env,
  OPENCODE_CONFIG_CONTENT: opencodeConfigContent(context.args.taskType),
  TMPDIR: path.join(context.workDir, 'tmp'),
})

interface InlineFailureTarget {
  responderSessionId: string
  responseFile: string
  runDir: string
}

const inlineFailureTarget = (context: WrapperContext): InlineFailureTarget => ({
  responderSessionId: `wrapper:${context.backend}:${path.basename(context.args.responseFile, '.json')}`,
  responseFile: context.args.responseFile,
  runDir: context.workDir,
})

const sessionModeFailureReport = (message: string): string =>
  [
    '---',
    'status: failed',
    '---',
    '# Summary',
    'OpenCode session reuse is unavailable.',
    '',
    '# Error',
    message,
    '',
  ].join('\n')

const finishSessionModeFailure = (
  context: WrapperContext,
  exitCode: number,
  message: string
): CliResult => {
  const result = finishWithoutChild(context, exitCode, message)
  buildResponseFromStdoutText(
    sessionModeFailureReport(message),
    inlineFailureTarget(context),
    context.env
  )
  return result
}

const sessionModeFailure = (context: WrapperContext): CliResult | null => {
  const { sessionMode } = context.args
  if (sessionMode !== '' && sessionMode !== 'resumable' && sessionMode !== 'followup') {
    return finishWithoutChild(
      context,
      2,
      `ERROR: session_mode must be empty, resumable, or followup: ${sessionMode}`
    )
  }
  if (sessionMode === 'resumable' || sessionMode === 'followup') {
    return finishSessionModeFailure(
      context,
      5,
      'ERROR: opencode backend の session reuse は未実装です。'
    )
  }
  return null
}

const inlineFailureReport = (context: WrapperContext): string => {
  const limit = requestInlineMax(context.env)
  return [
    '---',
    'status: failed',
    '---',
    '# Summary',
    'OpenCode request delivery stopped before child CLI startup.',
    '',
    '# Error',
    `Cause: request exceeds DELEGATE_REQUEST_INLINE_MAX (${limit} bytes).`,
    'Workaround: request を分割する / 他 backend を使う。',
    '',
  ].join('\n')
}

const finishInlineFailure = (context: WrapperContext): CliResult => {
  const limit = requestInlineMax(context.env)
  const result = finishWithoutChild(
    context,
    1,
    `ERROR: request exceeds DELEGATE_REQUEST_INLINE_MAX (${limit} bytes); request を分割するか、他 backend を使ってください。`
  )
  buildResponseFromStdoutText(
    inlineFailureReport(context),
    inlineFailureTarget(context),
    context.env
  )
  return result
}

interface OpencodeLaunch {
  command: string
  requestStep: RequestPromptStep
}

const launchValidationFailure = (context: WrapperContext): CliResult | null => {
  const effortError = effortFailure(context)
  if (effortError !== null) {
    return effortError
  }
  return sessionModeFailure(context)
}

const requestStepForOpencode = (context: WrapperContext): RequestPromptStep | CliResult => {
  const requestStep = requestPromptStep(context.args.requestFile, {
    scriptsDir: context.scriptsDir,
    env: context.env,
  })
  if (!requestStep.inline) {
    return finishInlineFailure(context)
  }
  return requestStep
}

const prepareOpencodeLaunch = (context: WrapperContext): OpencodeLaunch | CliResult => {
  const validationFailure = launchValidationFailure(context)
  if (validationFailure !== null) {
    return validationFailure
  }
  const requestStep = requestStepForOpencode(context)
  if ('exitCode' in requestStep) {
    return requestStep
  }
  const command = resolveOpencode(context.env)
  if (command === null) {
    return finishWithoutChild(
      context,
      3,
      'ERROR: opencode CLI が見つからないか、--version に応答しません。'
    )
  }
  return { command, requestStep }
}

const finalizeOpencodeRun = (
  context: WrapperContext,
  cliModel: string,
  wait: WaitResult
): CliResult => {
  if (wait.childStatus !== 0) {
    buildFailedResponseFromStdoutText(
      {
        responderSessionId: responderSessionIdOf(context, cliModel),
        responseFile: context.args.responseFile,
        runDir: context.workDir,
      },
      context.env
    )
  }
  completeResponse(
    context,
    {
      responderSessionId: responderSessionIdOf(context, cliModel),
      reportMode: reportModeForBackend('opencode'),
      collectStdoutText: () => opencodeCapturedText(context, wait),
    },
    wait
  )
  const outcome = finalizeResponse(context, wait.childStatus)
  recordOpencodeUsage(context)
  return wrapperResult(context, outcome)
}

const runOpencodeChild = async (
  context: WrapperContext,
  launch: OpencodeLaunch
): Promise<CliResult> => {
  const cliModel = stripOpencodeSelector(context.baseModel)
  const prompt = workerPrompt(context, launch.requestStep.step, {
    constraints: promptConstraints(context.args.taskType, '', 'stdout'),
    tailLines: opencodePromptTailLines,
  })
  const promptFile = writePromptFile(context, prompt)
  const worker = spawnWorker({
    command: launch.command,
    args: opencodeCliArgs(context, cliModel),
    cwd: context.repoRoot,
    env: opencodeChildEnv(context),
    stdinFile: promptFile,
    stdoutCapture: context.stdoutCapture,
    stderrCapture: context.stderrCapture,
  })
  const wait = await waitWithHeartbeat({
    observeFile: context.args.observeFile,
    runDir: context.workDir,
    backend: context.backend,
    worker,
    stdoutCapture: context.stdoutCapture,
    stderrCapture: context.stderrCapture,
    responseFile: context.args.responseFile,
    env: context.env,
  })
  return finalizeOpencodeRun(context, cliModel, wait)
}

interface TestContextOptions {
  model?: string
  taskType?: string
  env?: Env
}

const makeTestContext = (dir: string, options: TestContextOptions = {}): WrapperContext => {
  const model = options.model ?? 'opencode/opencode-go/glm-5.2@high'
  const taskType = options.taskType ?? 'chore'
  const env = options.env ?? {}
  const args = parseWrapperArgs(
    [
      model,
      taskType,
      path.join(dir, 'request.json'),
      path.join(dir, 'response.json'),
      dir,
      path.join(dir, 'observe.json'),
    ],
    'delegate-opencode.sh'
  )
  if ('exitCode' in args) {
    throw new Error('unexpected wrapper argument failure')
  }
  return makeWrapperContext(args, { env, scriptsDir: dir })
}

const wrapperOpencodeWithContext = async (context: WrapperContext): Promise<CliResult> => {
  const launch = prepareOpencodeLaunch(context)
  if ('exitCode' in launch) {
    return launch
  }
  return runOpencodeChild(context, launch)
}

export const runWrapperOpencode = async (
  argv: readonly string[],
  env: Env,
  io: { scriptsDir: string }
): Promise<CliResult> => {
  const args = parseWrapperArgs(argv, 'delegate-opencode.sh')
  if ('exitCode' in args) {
    return args
  }
  const context = makeWrapperContext(args, { env, scriptsDir: io.scriptsDir })
  return wrapperOpencodeWithContext(context)
}

const usageForOpencodeObserveCase = (
  files: { requestFile: string; responseFile: string },
  input: { parseFailed: boolean; costUsd: number | null }
): Record<string, unknown> => {
  if (input.parseFailed) {
    return estimatedUsage({
      requestFile: files.requestFile,
      responseFile: files.responseFile,
      model: 'opencode/opencode-go/glm-5.2@high',
      backend: 'opencode',
      source: 'chars_4',
    })
  }
  const usage: Record<string, unknown> = {
    input_tokens: 10,
    output_tokens: 2,
    total_tokens: 12,
    cached_input_tokens: 30,
    cache_write_tokens: 2,
    reasoning_tokens: 7,
    measurement: 'measured',
    source: 'opencode_step_finish',
    model: 'opencode/opencode-go/glm-5.2@high',
    backend: 'opencode',
  }
  if (input.costUsd !== null) {
    usage.cost_usd = input.costUsd
  }
  return usage
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  const { chmodSync, existsSync, readFileSync, writeFileSync } = await import('node:fs')
  const { isRecord } = await import('./jq-compat.ts')
  const { createTestScratchDir } = await import('./test-scratch.ts')

  const writeExecutable = (dir: string, name: string, source: string): string => {
    const file = path.join(dir, name)
    writeFileSync(file, source)
    chmodSync(file, 0o755)
    return file
  }

  const readTestJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'))

  const OPENCODE_OBSERVE_EPOCH_MS = 1_787_360_343_099

  const opencodeObserveEvent = (type: string, part: Record<string, unknown>, offset = 0): string =>
    JSON.stringify({ type, timestamp: OPENCODE_OBSERVE_EPOCH_MS + offset, part })

  const opencodeObserveEventLines = (mode: string): string[] => {
    const reportText = '---\nstatus: completed\n---\n# Summary\nlast'
    const text = opencodeObserveEvent('text', { text: reportText })
    const tool = opencodeObserveEvent('tool_use', {}, 1)
    const tokens = { input: 10, output: 2, reasoning: 7, cache: { read: 30, write: 2 } }
    if (mode === 'observe-missing-step') {
      return [text, tool]
    }
    const part: Record<string, unknown> = { tokens }
    if (mode === 'observe-measured') {
      part.cost = 0.25
    }
    return [text, tool, opencodeObserveEvent('step_finish', part, 2)]
  }

  const expectMonotonicTimingField = (value: unknown): void => {
    expect(value).toEqual(expect.any(Number))
    expect(Number(value)).toBeGreaterThanOrEqual(0)
    expect(Number(value)).toBeLessThan(OPENCODE_OBSERVE_EPOCH_MS)
  }

  describe('opencodePureEnabled / opencodeConfigContent', () => {
    it('accepts only the documented pure values and injects permission selectively', () => {
      expect(opencodePureEnabled({ DELEGATE_OPENCODE_PURE: ' TRUE ' })).toBe(true)
      expect(opencodePureEnabled({ DELEGATE_OPENCODE_PURE: '1' })).toBe(true)
      expect(opencodePureEnabled({ DELEGATE_OPENCODE_PURE: 'yes' })).toBe(true)
      expect(opencodePureEnabled({ DELEGATE_OPENCODE_PURE: '' })).toBe(false)
      expect(opencodePureEnabled({ DELEGATE_OPENCODE_PURE: 'on' })).toBe(false)
      expect(JSON.parse(opencodeConfigContent('explore'))).toEqual({
        permission: { edit: 'deny' },
      })
      expect(JSON.parse(opencodeConfigContent('review'))).toEqual({
        permission: { edit: 'deny' },
      })
      expect(JSON.parse(opencodeConfigContent('implement'))).toEqual({})
    })
  })

  describe('opencodeCliArgs', () => {
    it('strips the selector once and keeps the prompt out of argv', () => {
      const dir = createTestScratchDir('wrapper-opencode-args-test')
      const context = makeTestContext(dir, { taskType: 'explore' })
      expect(stripOpencodeSelector(context.baseModel)).toBe('opencode-go/glm-5.2')
      expect(opencodeCliArgs(context, 'opencode-go/glm-5.2')).toEqual([
        'run',
        '--format',
        'json',
        '-m',
        'opencode-go/glm-5.2',
        '--variant',
        'high',
        '--pure',
      ])
      expect(opencodeCliArgs(context, 'opencode-go/glm-5.2').join(' ')).not.toContain('---')
    })

    it('adds pure for the task types that disable plugins and for the explicit flag', () => {
      const dir = createTestScratchDir('wrapper-opencode-pure-test')
      expect(
        opencodeCliArgs(makeTestContext(dir, { taskType: 'htmldoc' }), 'provider/model')
      ).toContain('--pure')
      expect(
        opencodeCliArgs(
          makeTestContext(dir, {
            taskType: 'implement',
            env: { DELEGATE_OPENCODE_PURE: ' yes ' },
          }),
          'provider/model'
        )
      ).toContain('--pure')
      expect(opencodeCliArgs(makeTestContext(dir), 'provider/model')).not.toContain('--pure')
    })
  })

  describe('resolveOpencode', () => {
    it('accepts a PATH candidate with a bounded version response', () => {
      const dir = createTestScratchDir('wrapper-opencode-resolver-test')
      const candidate = writeExecutable(dir, 'opencode', '#!/bin/sh\nprintf "%s\\n" "1.0.0"\n')
      expect(resolveOpencode({ PATH: dir }, 500)).toBe(path.resolve(candidate))
    })
  })

  describe('lastTextFromCapture', () => {
    it('ignores non-JSON lines and selects the last text event', () => {
      const dir = createTestScratchDir('wrapper-opencode-capture-test')
      const capture = path.join(dir, 'stdout.capture')
      writeFileSync(
        capture,
        `noise\n${JSON.stringify({ type: 'text', part: { text: 'first' } })}\n${JSON.stringify({ type: 'error', error: { message: 'bad' } })}\n${JSON.stringify({ type: 'text', part: { text: 'last' } })}\n`
      )
      expect(lastTextFromCapture(capture)).toBe('last')
    })

    it('does not fall back to an earlier text event when the last text payload is invalid', () => {
      const dir = createTestScratchDir('wrapper-opencode-invalid-text-test')
      const capture = path.join(dir, 'stdout.capture')
      writeFileSync(
        capture,
        `${JSON.stringify({ type: 'text', part: { text: 'valid' } })}\n${JSON.stringify({ type: 'text', part: { text: 42 } })}\n`
      )
      expect(lastTextFromCapture(capture)).toBeNull()
    })

    it('rejects a capture that exceeds the total byte limit', () => {
      const dir = createTestScratchDir('wrapper-opencode-capture-limit-test')
      const capture = path.join(dir, 'stdout.capture')
      writeFileSync(capture, Buffer.alloc(OPENCODE_CAPTURE_MAX_BYTES + 1, 120))
      expect(lastTextFromCapture(capture)).toBeNull()
    })

    it('rejects a JSONL line that exceeds the line byte limit', () => {
      const dir = createTestScratchDir('wrapper-opencode-line-limit-test')
      const capture = path.join(dir, 'stdout.capture')
      writeFileSync(capture, `${'x'.repeat(OPENCODE_CAPTURE_MAX_LINE_BYTES + 1)}\n`)
      expect(lastTextFromCapture(capture)).toBeNull()
    })
  })

  interface FakeRunFixture {
    argsFile: string
    cli: string
    configFile: string
    dir: string
    observeFile: string
    promptFile: string
    requestFile: string
    responseFile: string
  }

  const makeFakeRunFixture = (dir: string): FakeRunFixture => {
    const files = {
      argsFile: path.join(dir, 'args.log'),
      configFile: path.join(dir, 'config.log'),
      observeFile: path.join(dir, 'observe.json'),
      promptFile: path.join(dir, 'prompt.log'),
      requestFile: path.join(dir, 'request.json'),
      responseFile: path.join(dir, 'response.json'),
    }
    const first = opencodeTextEvent('---\nstatus: completed\n---\n# Summary\nfirst')
    const last = opencodeTextEvent('---\nstatus: completed\n---\n# Summary\nlast')
    const cli = writeExecutable(
      dir,
      'opencode',
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '1.0.0'
  exit 0
fi
printf '%s\\n' "$@" > "$OPENCODE_TEST_ARGS"
printf '%s' "$OPENCODE_CONFIG_CONTENT" > "$OPENCODE_TEST_CONFIG"
cat > "$OPENCODE_TEST_PROMPT"
if [ "$OPENCODE_TEST_OUTPUT_MODE" = "oversized-line" ]; then
  head -c ${OPENCODE_CAPTURE_MAX_LINE_BYTES + 1} /dev/zero | tr '\\0' 'x'
  printf '\\n'
  exit 0
fi
if [ "$OPENCODE_TEST_OUTPUT_MODE" = "oversized-capture" ]; then
  i=0
  while [ "$i" -lt ${Math.floor(OPENCODE_CAPTURE_MAX_BYTES / 65_536) + 1} ]; do
    head -c 65536 /dev/zero | tr '\\0' 'x'
    printf '\\n'
    i=$((i + 1))
  done
  exit 0
fi
if [ -n "$OPENCODE_TEST_EVENTS_FILE" ]; then
  cat "$OPENCODE_TEST_EVENTS_FILE"
  exit 0
fi
printf '%s\\n' '${first}'
printf '%s\\n' '${last}'
if [ "$OPENCODE_TEST_EXIT_MODE" = "signal" ]; then
  kill -TERM $$
fi
if [ -n "$OPENCODE_TEST_EXIT_CODE" ]; then
  exit "$OPENCODE_TEST_EXIT_CODE"
fi
`
    )
    writeFileSync(
      files.requestFile,
      JSON.stringify({ task_type_chain: ['chore'], sections: ['# Objective\nDo this'] })
    )
    return { ...files, cli, dir }
  }

  const runFake = async (
    fixture: FakeRunFixture,
    options: { env?: Env; sessionArgs?: readonly string[] } = {}
  ): Promise<CliResult> =>
    runWrapperOpencode(
      [
        'opencode/opencode-go/glm-5.2@high',
        'chore',
        fixture.requestFile,
        fixture.responseFile,
        fixture.dir,
        fixture.observeFile,
        ...(options.sessionArgs ?? []),
      ],
      {
        PATH: `${fixture.dir}:${process.env.PATH ?? ''}`,
        OPENCODE_TEST_ARGS: fixture.argsFile,
        OPENCODE_TEST_PROMPT: fixture.promptFile,
        OPENCODE_TEST_CONFIG: fixture.configFile,
        ...options.env,
      },
      { scriptsDir: fixture.dir }
    )

  describe('runWrapperOpencode', () => {
    const expectFailedResponse = (fixture: FakeRunFixture): void => {
      const response = readTestJson(fixture.responseFile)
      expect(response).toMatchObject({ status: 'failed' })
      expect(JSON.stringify(response)).toContain('# Error')
    }

    it('passes the prompt through stdin and assembles the final text response', async () => {
      const dir = createTestScratchDir('wrapper-opencode-run-test')
      const fixture = makeFakeRunFixture(dir)
      const result = await runFake(fixture)
      expect(result.exitCode).toBe(0)
      expect(readFileSync(fixture.argsFile, 'utf8')).not.toContain('# Objective')
      expect(readFileSync(fixture.promptFile, 'utf8')).toContain('<request>')
      expect(readTestJson(fixture.configFile)).toEqual({})
      expect(JSON.stringify(readTestJson(fixture.responseFile))).toContain('last')
    })

    it.each([
      { mode: 'resumable', sessionArgs: ['resumable', '', ''] },
      { mode: 'followup', sessionArgs: ['followup', 'session-1', '/tmp/session-1'] },
    ])('fails closed before child startup for the $mode session mode', async ({ sessionArgs }) => {
      const dir = createTestScratchDir(`wrapper-opencode-${sessionArgs[0]}-test`)
      const fixture = makeFakeRunFixture(dir)
      const result = await runFake(fixture, { sessionArgs })
      expect(result.exitCode).toBe(5)
      expect(existsSync(fixture.argsFile)).toBe(false)
      expectFailedResponse(fixture)
      expect(JSON.stringify(readTestJson(fixture.responseFile))).toContain(
        'opencode backend の session reuse は未実装'
      )
    })

    it('forces a failed response when the child exits non-zero after writing text', async () => {
      const dir = createTestScratchDir('wrapper-opencode-child-error-test')
      const fixture = makeFakeRunFixture(dir)
      const result = await runFake(fixture, { env: { OPENCODE_TEST_EXIT_CODE: '7' } })
      expect(result.exitCode).toBe(7)
      expectFailedResponse(fixture)
    })

    it('forces a failed response when the child receives a signal after writing text', async () => {
      const dir = createTestScratchDir('wrapper-opencode-child-signal-test')
      const fixture = makeFakeRunFixture(dir)
      const result = await runFake(fixture, { env: { OPENCODE_TEST_EXIT_MODE: 'signal' } })
      expect(result.exitCode).toBe(143)
      expectFailedResponse(fixture)
    })

    it.each(['oversized-line', 'oversized-capture'])(
      'creates a failed response for a %s stdout capture',
      async (outputMode) => {
        const dir = createTestScratchDir(`wrapper-opencode-${outputMode}-test`)
        const fixture = makeFakeRunFixture(dir)
        const result = await runFake(fixture, { env: { OPENCODE_TEST_OUTPUT_MODE: outputMode } })
        expect(result.exitCode).toBe(1)
        expectFailedResponse(fixture)
      }
    )

    it('fails before CLI resolution when the request cannot fit inline', async () => {
      const dir = createTestScratchDir('wrapper-opencode-inline-gate-test')
      const requestFile = path.join(dir, 'request.json')
      const responseFile = path.join(dir, 'response.json')
      const observeFile = path.join(dir, 'observe.json')
      writeFileSync(
        requestFile,
        JSON.stringify({ task_type_chain: ['chore'], sections: ['# Objective\nlarge'] })
      )
      const result = await runWrapperOpencode(
        ['opencode/opencode-go/glm-5.2', 'chore', requestFile, responseFile, dir, observeFile],
        { PATH: '/nonexistent', DELEGATE_REQUEST_INLINE_MAX: '1' },
        { scriptsDir: dir }
      )
      const response = JSON.stringify(readTestJson(responseFile))
      expect(result.exitCode).toBe(1)
      expect(response).toContain('request を分割する')
      expect(response).toContain('他 backend')
    })
  })

  describe('runWrapperOpencode observe JSON', () => {
    const expectedObserveEvents = (
      fixture: FakeRunFixture,
      parseFailed: boolean
    ): Record<string, unknown>[] => {
      const created = {
        kind: 'run_created',
        ts: expect.any(String),
        run_dir: fixture.dir,
        request_file: fixture.requestFile,
        response_file: fixture.responseFile,
      }
      if (!parseFailed) {
        return [created]
      }
      return [
        created,
        {
          kind: 'usage_parse_failed',
          ts: expect.any(String),
          backend: 'opencode',
          source: 'opencode_step_finish',
          message: 'measured usage was not available',
        },
      ]
    }

    const expectPinnedObserve = (
      fixture: FakeRunFixture,
      input: { usage: Record<string, unknown>; modelTurns: number | null; parseFailed: boolean }
    ): void => {
      const doc = readTestJson(fixture.observeFile)
      expect(doc).toEqual({
        schema_version: 1,
        run: {
          task_type: 'chore',
          model: 'opencode/opencode-go/glm-5.2@high',
          backend: 'opencode',
          request_file: fixture.requestFile,
          response_file: fixture.responseFile,
          run_dir: fixture.dir,
          requester_session_id: '',
        },
        state: {
          phase: 'prepared',
          dispatcher_pid: null,
          started_at: null,
          ended_at: null,
          exit_code: null,
          duration_ms: null,
          response_present: false,
        },
        heartbeat: {
          ts: expect.any(String),
          backend: 'opencode',
          child_pid: expect.any(Number),
          stdout_bytes: expect.any(Number),
          stderr_bytes: 0,
          last_stream_change_at: expect.any(String),
        },
        events: expectedObserveEvents(fixture, input.parseFailed),
        streams: {
          stdout: {
            bytes: expect.any(Number),
            truncated: false,
            content: expect.stringContaining('"type":"text"'),
          },
          stderr: { bytes: 0, truncated: false, content: '' },
        },
        timing: {
          total_ms: expect.any(Number),
          time_to_first_useful_event_ms: expect.any(Number),
          report_ready_at_ms: expect.any(Number),
          model_turns: input.modelTurns,
          tool_calls: 1,
          structured_output_parse: null,
          measurement_source: 'opencode_json',
        },
        usage: input.usage,
      })
      if (!isRecord(doc) || !isRecord(doc.timing)) {
        throw new Error('observe timing is missing')
      }
      expectMonotonicTimingField(doc.timing.total_ms)
      expectMonotonicTimingField(doc.timing.time_to_first_useful_event_ms)
      expectMonotonicTimingField(doc.timing.report_ready_at_ms)
    }

    it.each([
      { mode: 'observe-measured', modelTurns: 1, parseFailed: false, costUsd: 0.25 },
      { mode: 'observe-missing-cost', modelTurns: 1, parseFailed: false, costUsd: null },
      { mode: 'observe-missing-step', modelTurns: null, parseFailed: true, costUsd: null },
    ])('pins the observe JSON for $mode', async ({ mode, modelTurns, parseFailed, costUsd }) => {
      const dir = createTestScratchDir(`wrapper-opencode-${mode}-test`)
      const fixture = makeFakeRunFixture(dir)
      const eventsFile = path.join(dir, 'observe-events.jsonl')
      writeFileSync(eventsFile, `${opencodeObserveEventLines(mode).join('\n')}\n`)
      const result = await runFake(fixture, { env: { OPENCODE_TEST_EVENTS_FILE: eventsFile } })
      expect(result.exitCode).toBe(0)
      const usage = usageForOpencodeObserveCase(fixture, { parseFailed, costUsd })
      expectPinnedObserve(fixture, { usage, modelTurns, parseFailed })
    })
  })
}
