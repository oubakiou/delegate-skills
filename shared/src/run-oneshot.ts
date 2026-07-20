import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Env } from './build-request.ts'
import type { CliResult } from './cli-result.ts'
import { spawnWrapper, runDispatch } from './dispatch.ts'
import { hasFileContent, isRecord, readFileOrEmpty, stringOf } from './jq-compat.ts'
import { runPrepareImagegen } from './prepare-imagegen.ts'
import { parseRunPaths, runPrepare } from './prepare.ts'
import { runReadResponse } from './read-response.ts'
import { prettyJson } from './protocol.ts'

// bash 版 run.sh / run-imagegen.sh / run-x-research.sh と同一の one-shot 契約:
// stdout: 成功・失敗とも単一 JSON（exit_code / status / content / content_truncated /
//         response_file / observe_file / run_dir）
// stderr: dispatch 前に "observe_file: <path>" を先出しする
// exit: 内部処理の exit code を透過する

export interface OneShotIo {
  scriptsDir: string
  // observe_file の stderr 先出しは dispatch 開始前に届く必要があるため、
  // CliResult へ畳まず live に書く
  writeStderr: (text: string) => void
}

const contentMaxOf = (env: Env): number => {
  const raw = env.DELEGATE_RUN_CONTENT_MAX ?? '16384'
  if (raw === '' || /[^0-9]/.test(raw)) {
    return 16_384
  }
  return Number(raw)
}

const utf8ByteLength = (text: string): number => Buffer.byteLength(text, 'utf8')

// jq 版 clip_bytes と同じく codepoint 境界を保ったまま上限バイト以下の最長 prefix を
// 二分探索で取る（バイト切断は UTF-8 文字の途中で切れて本文破損を起こすため）
// for...of は codepoint 単位の走査で、jq の文字列 index (codepoint) と一致する
const codePointsOf = (text: string): string[] => {
  const points: string[] = []
  for (const point of text) {
    points.push(point)
  }
  return points
}

const clipBytes = (text: string, maxBytes: number): string => {
  const points = codePointsOf(text)
  let low = 0
  let high = points.length
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2)
    if (utf8ByteLength(points.slice(0, mid).join('')) <= maxBytes) {
      low = mid
    } else {
      high = mid
    }
  }
  return points.slice(0, low).join('')
}

const nullIfEmpty = (value: string): string | null => {
  if (value === '') {
    return null
  }
  return value
}

interface RunEmitInput {
  exitCode: number
  status: string
  content: string
  responseFile: string
  observeFile: string
  runDir: string
}

const clippedContent = (content: string, maxBytes: number, truncated: boolean): string => {
  if (truncated) {
    return clipBytes(content, maxBytes)
  }
  return content
}

const runJson = (env: Env, input: RunEmitInput): string => {
  const maxBytes = contentMaxOf(env)
  const truncated = maxBytes > 0 && utf8ByteLength(input.content) > maxBytes
  return prettyJson({
    exit_code: input.exitCode,
    status: input.status,
    content: clippedContent(input.content, maxBytes, truncated),
    content_truncated: truncated,
    response_file: nullIfEmpty(input.responseFile),
    observe_file: nullIfEmpty(input.observeFile),
    run_dir: nullIfEmpty(input.runDir),
  })
}

const failureJson = (env: Env, failed: { exitCode: number; content: string }): CliResult => ({
  exitCode: failed.exitCode,
  stderr: '',
  stdout: runJson(env, {
    exitCode: failed.exitCode,
    status: 'failed',
    content: failed.content,
    responseFile: '',
    observeFile: '',
    runDir: '',
  }),
})

// 引数エラーでも one-shot 契約（単一 JSON stdout + exit 2）を崩さない
const usageError = (env: Env, usageText: string): CliResult => {
  const result = failureJson(env, { exitCode: 2, content: `${usageText}\n` })
  return { ...result, stderr: `${usageText}\n` }
}

const defaultSelector = (taskType: string): string => {
  if (taskType === 'review') {
    return 'decision'
  }
  return 'auto'
}

const selectorOf = (taskType: string, requested: string): string => {
  if (requested !== '') {
    return requested
  }
  return defaultSelector(taskType)
}

const responseStatusOf = (responseFile: string): string => {
  try {
    const parsed: unknown = JSON.parse(readFileOrEmpty(responseFile))
    if (isRecord(parsed) && typeof parsed.status === 'string') {
      return parsed.status
    }
    return 'failed'
  } catch {
    return 'failed'
  }
}

interface DispatchOutcome {
  exitCode: number
  stderr: string
}

interface OneShotConfig {
  taskType: string
  selector: string
  env: Env
  io: OneShotIo
  prepare: () => CliResult
  dispatch: (paths: PreparedRun) => DispatchOutcome
}

export interface PreparedRun {
  model: string
  requestFile: string
  responseFile: string
  runDir: string
  observeFile: string
}

const preparedRunOf = (prepareStdout: string): PreparedRun => {
  const parsed: unknown = JSON.parse(prepareStdout)
  const model = ((): string => {
    if (isRecord(parsed)) {
      return stringOf(parsed.model)
    }
    return ''
  })()
  const paths = parseRunPaths(prepareStdout)
  return {
    model,
    requestFile: paths.request_file,
    responseFile: paths.response_file,
    runDir: paths.run_dir,
    observeFile: paths.observe_file,
  }
}

interface ReadOutcome {
  status: string
  content: string
  readStatus: number
}

const readResponseContent = (config: OneShotConfig, prepared: PreparedRun): ReadOutcome => {
  const status = responseStatusOf(prepared.responseFile)
  const read = runReadResponse([prepared.responseFile, config.selector], config.env)
  if (read.exitCode === 0) {
    return { status, content: read.stdout, readStatus: 0 }
  }
  // bash 版と同じく read-response の stdout に stderr を継ぎ足して content にする
  return {
    status: 'failed',
    content: `${read.stdout}${read.stderr}`,
    readStatus: read.exitCode,
  }
}

const collectOutcome = (
  config: OneShotConfig,
  prepared: PreparedRun,
  dispatched: DispatchOutcome
): ReadOutcome => {
  if (hasFileContent(prepared.responseFile)) {
    return readResponseContent(config, prepared)
  }
  // failed response の生成すら無い異常系: dispatch stderr を親へ返す
  return { status: 'failed', content: dispatched.stderr, readStatus: 0 }
}

const exitCodeOf = (dispatched: DispatchOutcome, outcome: ReadOutcome): number => {
  if (dispatched.exitCode !== 0) {
    return dispatched.exitCode
  }
  return outcome.readStatus
}

export const oneShot = (config: OneShotConfig): CliResult => {
  const prepared = config.prepare()
  if (prepared.exitCode !== 0) {
    return failureJson(config.env, { exitCode: prepared.exitCode, content: prepared.stderr })
  }
  const paths = preparedRunOf(prepared.stdout)
  config.io.writeStderr(`observe_file: ${paths.observeFile}\n`)
  const dispatched = config.dispatch(paths)
  const outcome = collectOutcome(config, paths, dispatched)
  const exitCode = exitCodeOf(dispatched, outcome)
  return {
    exitCode,
    stderr: '',
    stdout: runJson(config.env, {
      exitCode,
      status: outcome.status,
      content: outcome.content,
      responseFile: paths.responseFile,
      observeFile: paths.observeFile,
      runDir: paths.runDir,
    }),
  }
}

const RUN_USAGE =
  'Usage: run <task_type> <type_env_name> <default_model> <parent_task_type_chain_json> <requester_session_id> [selector]  (request body markdown on stdin)'

// stdin は prepare が引数検証を通過した後にだけ読む（bash 版と同じ遅延順序）
export const runRun = (
  argv: readonly string[],
  context: { env: Env; io: OneShotIo },
  readStdin: () => Buffer
): CliResult => {
  if (argv.length < 5) {
    return usageError(context.env, RUN_USAGE)
  }
  const [taskType, typeEnv, defaultModel, parentChain, requesterSessionId] = argv
  return oneShot({
    taskType,
    selector: selectorOf(taskType, argv[5] ?? ''),
    env: context.env,
    io: context.io,
    prepare: () =>
      runPrepare(
        [taskType, typeEnv, defaultModel, parentChain, requesterSessionId],
        context.env,
        readStdin
      ),
    dispatch: (paths) =>
      runDispatch(
        [
          paths.model,
          taskType,
          paths.requestFile,
          paths.responseFile,
          paths.runDir,
          paths.observeFile,
        ],
        context.env,
        { scriptsDir: context.io.scriptsDir, captureStderr: true }
      ),
  })
}

// 専用 run は共通 dispatch.sh を通れないため wrapper を直接起動する
// （imagegen は専用 prepare / wrapper、x-research は dispatch.sh が grok を明示拒否する）
const dedicatedWrapperDispatch = (
  context: { env: Env; io: OneShotIo },
  wrapperScript: string,
  paths: PreparedRun
): DispatchOutcome => {
  const outcome = spawnWrapper({
    script: path.join(context.io.scriptsDir, wrapperScript),
    args: [paths.model, paths.requestFile, paths.responseFile, paths.runDir, paths.observeFile],
    env: context.env,
    captureStderr: true,
  })
  return { exitCode: outcome.exitCode, stderr: outcome.stderr }
}

const RUN_IMAGEGEN_USAGE =
  'Usage: run-imagegen <parent_task_type_chain_json> <requester_session_id> [selector]  (request body markdown on stdin)'

export const runRunImagegen = (
  argv: readonly string[],
  context: { env: Env; io: OneShotIo },
  readStdin: () => Buffer
): CliResult => {
  if (argv.length < 2) {
    return usageError(context.env, RUN_IMAGEGEN_USAGE)
  }
  const [parentChain, requesterSessionId] = argv
  return oneShot({
    taskType: 'imagegen',
    selector: selectorOf('imagegen', argv[2] ?? ''),
    env: context.env,
    io: context.io,
    prepare: () => runPrepareImagegen([parentChain, requesterSessionId], context.env, readStdin),
    dispatch: (paths) => dedicatedWrapperDispatch(context, 'delegate-imagegen-codex.sh', paths),
  })
}

const RUN_X_RESEARCH_USAGE =
  'Usage: run-x-research <parent_task_type_chain_json> <requester_session_id> [selector]  (request body markdown on stdin)'

export const runRunXResearch = (
  argv: readonly string[],
  context: { env: Env; io: OneShotIo },
  readStdin: () => Buffer
): CliResult => {
  if (argv.length < 2) {
    return usageError(context.env, RUN_X_RESEARCH_USAGE)
  }
  const [parentChain, requesterSessionId] = argv
  return oneShot({
    taskType: 'xresearch',
    selector: selectorOf('xresearch', argv[2] ?? ''),
    env: context.env,
    io: context.io,
    prepare: () =>
      runPrepare(
        ['xresearch', 'DELEGATE_X_RESEARCH_MODEL', 'grok-build', parentChain, requesterSessionId],
        context.env,
        readStdin
      ),
    dispatch: (paths) => dedicatedWrapperDispatch(context, 'delegate-x-research-grok.sh', paths),
  })
}

// in-source test 専用 helper (bundle からは treeshake で除去される)
const makeOneShotTestDir = (): string => {
  mkdirSync('.temp', { recursive: true })
  const dir = `.temp/run-oneshot-test-${Math.random().toString(36).slice(2)}`
  mkdirSync(dir)
  return dir
}

const stderrSpyIo = (dir: string, lines: string[]): OneShotIo => ({
  scriptsDir: dir,
  writeStderr: (text: string): void => {
    lines.push(text)
  },
})

const silentIo = (dir: string): OneShotIo => stderrSpyIo(dir, [])

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  const { writeFileSync, chmodSync } = await import('node:fs')

  const makeFakeWrapper = (dir: string, name: string): void => {
    const file = path.join(dir, name)
    writeFileSync(
      file,
      `#!/usr/bin/env bash\nprintf '%s' '{"protocol_version":1,"type":"response","status":"completed","worker_session_id":"w","index":"# Summary","sections":["# Summary\\nok from fake wrapper"]}' >"$3"\nprintf '%s\\n' "$3"\n`
    )
    chmodSync(file, 0o755)
  }

  describe('runRun one-shot', () => {
    it('returns the usage-error JSON contract with exit 2', () => {
      const result = runRun(['chore'], { env: {}, io: silentIo('.') }, () => Buffer.alloc(0))
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('Usage:')
      expect(JSON.parse(result.stdout)).toMatchObject({
        exit_code: 2,
        status: 'failed',
        content_truncated: false,
        response_file: null,
        observe_file: null,
        run_dir: null,
      })
    })

    it('passes prepare failures through with the failure JSON', () => {
      const result = runRun(
        ['chore', 'DELEGATE_ONESHOT_TEST_MODEL', 'haiku', '["chore"]', 'sid'],
        { env: {}, io: silentIo('.') },
        () => Buffer.from('# T\nbody\n')
      )
      expect(result.exitCode).toBe(4)
      expect(JSON.parse(result.stdout)).toMatchObject({ exit_code: 4, status: 'failed' })
    })
  })

  describe('dedicated one-shot engines', () => {
    it('run-x-research dispatches to the grok wrapper and pre-announces observe_file', () => {
      const dir = makeOneShotTestDir()
      makeFakeWrapper(dir, 'delegate-x-research-grok.sh')
      const stderrLines: string[] = []
      const result = runRunXResearch(
        ['[]', 'sid'],
        { env: { ...process.env, DELEGATE_WORK_DIR: dir }, io: stderrSpyIo(dir, stderrLines) },
        () => Buffer.from('# T\nx research request\n')
      )
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ exit_code: 0, status: 'completed' })
      expect(result.stdout).toContain('ok from fake wrapper')
      expect(stderrLines.join('')).toContain('observe_file: ')
    })

    it('run-imagegen keeps the same contract via the codex wrapper', () => {
      const dir = makeOneShotTestDir()
      makeFakeWrapper(dir, 'delegate-imagegen-codex.sh')
      const result = runRunImagegen(
        ['[]', 'sid'],
        { env: { ...process.env, DELEGATE_WORK_DIR: dir }, io: silentIo(dir) },
        () => Buffer.from('# T\nimagegen request\n')
      )
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ exit_code: 0, status: 'completed' })
    })
  })

  describe('clipBytes', () => {
    it('clips on codepoint boundaries within the byte cap like the jq binary search', () => {
      const text = 'あいうえお'
      const clipped = clipBytes(text, 8)
      expect(clipped).toBe('あい')
      expect(utf8ByteLength(clipped)).toBeLessThanOrEqual(8)
    })

    it('returns an empty string when even one codepoint exceeds the cap', () => {
      expect(clipBytes('あ', 2)).toBe('')
    })
  })

  describe('runJson truncation', () => {
    it('truncates content at DELEGATE_RUN_CONTENT_MAX and flags content_truncated', () => {
      const emitted = runJson(
        { DELEGATE_RUN_CONTENT_MAX: '4' },
        {
          exitCode: 0,
          status: 'completed',
          content: 'abcdef',
          responseFile: '',
          observeFile: '',
          runDir: '',
        }
      )
      expect(JSON.parse(emitted)).toMatchObject({ content: 'abcd', content_truncated: true })
    })

    it('treats 0 and invalid values as unlimited / default like the bash case', () => {
      const unlimited = runJson(
        { DELEGATE_RUN_CONTENT_MAX: '0' },
        {
          exitCode: 0,
          status: 'completed',
          content: 'abcdef',
          responseFile: '',
          observeFile: '',
          runDir: '',
        }
      )
      expect(JSON.parse(unlimited)).toMatchObject({ content: 'abcdef', content_truncated: false })
    })
  })
}
