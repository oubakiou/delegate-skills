import { spawnSync } from 'node:child_process'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Env } from './build-request.ts'
import type { CliResult } from './cli-result.ts'
import { getPath, isRecord, parseJsonLine } from './jq-compat.ts'
import { promptConstraints } from './prompt-constraints.ts'
import {
  completeResponse,
  effortFailure,
  finishWithoutChild,
  finalizeResponse,
  makeWrapperContext,
  parseWrapperArgs,
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
const OPENCODE_CAPTURE_MAX_BYTES = 8 * 1024 * 1024
const OPENCODE_CAPTURE_MAX_LINE_BYTES = 1 * 1024 * 1024
const OPENCODE_CAPTURE_READ_BYTES = 64 * 1024
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

interface TextEventContent {
  isTextEvent: boolean
  text: string | null
}

const stringOrNull = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value
  }
  return null
}

const textEventContent = (event: unknown): TextEventContent => {
  if (!isRecord(event) || event.type !== 'text') {
    return { isTextEvent: false, text: null }
  }
  const text = getPath(event, ['part', 'text'])
  return { isTextEvent: true, text: stringOrNull(text) }
}

interface CaptureScanState {
  line: string
  lineBytes: number
  lastText: string | null
  sawTextEvent: boolean
}

const captureScanState = (): CaptureScanState => ({
  line: '',
  lineBytes: 0,
  lastText: null,
  sawTextEvent: false,
})

const consumeCaptureLine = (line: string, state: CaptureScanState): void => {
  const content = textEventContent(parseJsonLine(line))
  if (!content.isTextEvent) {
    return
  }
  state.sawTextEvent = true
  state.lastText = content.text
}

interface CaptureFragment {
  text: string
  nextOffset: number
  hasNewline: boolean
}

const captureFragmentOf = (text: string, offset: number): CaptureFragment => {
  const newline = text.indexOf('\n', offset)
  let end = text.length
  let nextOffset = text.length
  let hasNewline = false
  if (newline !== -1) {
    end = newline
    nextOffset = newline + 1
    hasNewline = true
  }
  return { text: text.slice(offset, end), nextOffset, hasNewline }
}

const captureFragmentWithinLimit = (
  fragment: CaptureFragment,
  state: CaptureScanState
): boolean => {
  state.lineBytes += Buffer.byteLength(fragment.text)
  if (fragment.hasNewline) {
    state.lineBytes += 1
  }
  return state.lineBytes <= OPENCODE_CAPTURE_MAX_LINE_BYTES
}

const consumeCaptureFragment = (
  text: string,
  offset: number,
  state: CaptureScanState
): number | null => {
  const fragment = captureFragmentOf(text, offset)
  if (!captureFragmentWithinLimit(fragment, state)) {
    return null
  }
  state.line += fragment.text
  if (!fragment.hasNewline) {
    return fragment.nextOffset
  }
  consumeCaptureLine(state.line, state)
  state.line = ''
  state.lineBytes = 0
  return fragment.nextOffset
}

const appendCaptureText = (text: string, state: CaptureScanState): boolean => {
  for (let offset = 0; offset < text.length;) {
    const nextOffset = consumeCaptureFragment(text, offset, state)
    if (nextOffset === null) {
      return false
    }
    offset = nextOffset
  }
  return true
}

const scanCaptureChunks = (
  fd: number,
  decoder: StringDecoder,
  state: CaptureScanState
): boolean => {
  const buffer = Buffer.alloc(OPENCODE_CAPTURE_READ_BYTES)
  let totalBytes = 0
  while (true) {
    const bytesRead = readSync(fd, buffer, 0, buffer.length, null)
    if (bytesRead === 0) {
      return true
    }
    totalBytes += bytesRead
    if (
      totalBytes > OPENCODE_CAPTURE_MAX_BYTES ||
      !appendCaptureText(decoder.write(buffer.subarray(0, bytesRead)), state)
    ) {
      return false
    }
  }
}

const finishCaptureScan = (decoder: StringDecoder, state: CaptureScanState): string | null => {
  if (!appendCaptureText(decoder.end(), state)) {
    return null
  }
  if (state.line !== '') {
    consumeCaptureLine(state.line, state)
  }
  if (!state.sawTextEvent) {
    return null
  }
  return state.lastText
}

const scanCaptureFile = (fd: number): string | null => {
  if (fstatSync(fd).size > OPENCODE_CAPTURE_MAX_BYTES) {
    return null
  }
  const decoder = new StringDecoder('utf8')
  const state = captureScanState()
  if (!scanCaptureChunks(fd, decoder, state)) {
    return null
  }
  return finishCaptureScan(decoder, state)
}

const closeCaptureQuietly = (fd: number | null): void => {
  if (fd === null) {
    return
  }
  try {
    closeSync(fd)
  } catch {
    // capture cleanup is best-effort
  }
}

export const lastTextFromCapture = (captureFile: string): string | null => {
  let fd: number | null = null
  try {
    fd = openSync(captureFile, 'r')
    return scanCaptureFile(fd)
  } catch {
    return null
  } finally {
    closeCaptureQuietly(fd)
  }
}

const opencodeCapturedText = (context: WrapperContext, wait: WaitResult): string | null => {
  if (wait.childStatus !== 0) {
    return null
  }
  return lastTextFromCapture(context.stdoutCapture)
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
  return wrapperResult(context, finalizeResponse(context, wait.childStatus))
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

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  const { chmodSync, existsSync, readFileSync, writeFileSync } = await import('node:fs')
  const { createTestScratchDir } = await import('./test-scratch.ts')

  const writeExecutable = (dir: string, name: string, source: string): string => {
    const file = path.join(dir, name)
    writeFileSync(file, source)
    chmodSync(file, 0o755)
    return file
  }

  const readTestJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'))

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

  describe('runWrapperOpencode', () => {
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
}
