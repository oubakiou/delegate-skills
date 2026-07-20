import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { backendFor } from './backend.ts'
import type { CliResult } from './cli-result.ts'
import { hasFileContent, readFileOrEmpty } from './jq-compat.ts'
import {
  appendDispatchMetrics,
  dispatchEnd,
  dispatchStart,
  initObserve,
  responseMissing,
  supersedeStalePrepared,
  type Env,
} from './observe-store.ts'
import { elapsedMs, monotonicMs } from './observe-timing.ts'
import { exitStatusFromChild } from './protocol.ts'

// bash 版 dispatch.sh と同一契約:
// Usage: dispatch <model> <task_type> <request_file> <response_file> [run_dir] [observe_file] [session_mode] [resume_arg] [session_home]
// stdout: 委譲先ラッパの stdout（response_file のパスのみ）
// exit: 委譲先ラッパの exit code をそのまま返す（2=引数エラー）

const USAGE =
  'Usage: dispatch <model> <task_type> <request_file> <response_file> [run_dir] [observe_file] [session_mode] [resume_arg] [session_home]\n'

const BACKEND_SCRIPTS: Readonly<Partial<Record<string, string>>> = {
  codex: 'delegate-codex.sh',
  devin: 'delegate-devin.sh',
  cursor: 'delegate-cursor.sh',
}

export interface DispatchIo {
  scriptsDir: string
  // run one-shot は bash 版と同じく wrapper stderr をファイル相当に捕捉して
  // response 欠落時の content に転用する。単独実行時は端末へ流す
  captureStderr?: boolean
}

// bash はシグナル死の子を 128+signum で報告する。spawnSync の status null をそれに揃える
export const exitStatusOf = (result: {
  status: number | null
  signal: NodeJS.Signals | null
}): number => exitStatusFromChild({ code: result.status, signal: result.signal })

const stripTrailingNewlinesText = (value: string): string => value.replace(/\n+$/, '')

export interface WrapperSpawnInput {
  script: string
  args: readonly string[]
  env: Env
  captureStderr: boolean
}

export interface WrapperOutcome {
  exitCode: number
  stdout: string
  stderr: string
}

interface WrapperCapture {
  scratch: string
  stdoutFile: string
  stderrFile: string
  stdoutFd: number
  stderrFd: number | null
}

const openWrapperCapture = (captureStderr: boolean): WrapperCapture => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'delegate-wrapper.'))
  const stdoutFile = path.join(scratch, 'stdout')
  const stderrFile = path.join(scratch, 'stderr')
  const capture: WrapperCapture = {
    scratch,
    stdoutFile,
    stderrFile,
    stdoutFd: openSync(stdoutFile, 'w'),
    stderrFd: null,
  }
  if (captureStderr) {
    capture.stderrFd = openSync(stderrFile, 'w')
  }
  return capture
}

const closeQuietly = (fd: number | null): void => {
  if (fd === null) {
    return
  }
  try {
    closeSync(fd)
  } catch {
    // クローズ失敗は capture 読み取りへ影響しない
  }
}

const spawnWrapperCaptured = (
  input: WrapperSpawnInput,
  capture: WrapperCapture
): WrapperOutcome => {
  // bash 版はファイルリダイレクト（サイズ上限なし）。pipe + maxBuffer だと上限超過で
  // Node が wrapper を強制終了して正常な response まで失うため、同じくファイルへ流す
  const spawned = spawnSync('bash', [input.script, ...input.args], {
    env: { ...input.env },
    stdio: ['inherit', capture.stdoutFd, capture.stderrFd ?? 'inherit'],
  })
  closeQuietly(capture.stdoutFd)
  closeQuietly(capture.stderrFd)
  const stderrText = ((): string => {
    if (capture.stderrFd === null) {
      return ''
    }
    return readFileOrEmpty(capture.stderrFile)
  })()
  return {
    exitCode: exitStatusOf(spawned),
    stdout: readFileOrEmpty(capture.stdoutFile),
    stderr: stderrText,
  }
}

export const spawnWrapper = (input: WrapperSpawnInput): WrapperOutcome => {
  const capture = openWrapperCapture(input.captureStderr)
  try {
    return spawnWrapperCaptured(input, capture)
  } finally {
    rmSync(capture.scratch, { force: true, recursive: true })
  }
}

interface DispatchArgs {
  model: string
  taskType: string
  requestFile: string
  responseFile: string
  runDir: string
  observeFile: string
  sessionMode: string
  resumeArg: string
  sessionHome: string
}

const argOrDefault = (value: string | undefined, fallback: string): string => {
  if (typeof value === 'string' && value !== '') {
    return value
  }
  return fallback
}

const parseDispatchArgs = (argv: readonly string[]): DispatchArgs | CliResult => {
  if (argv.length < 4) {
    return { exitCode: 2, stderr: USAGE, stdout: '' }
  }
  const [model, taskType, requestFile, responseFile] = argv
  const runBase = responseFile.replace(/_res\.json$/, '')
  return {
    model,
    taskType,
    requestFile,
    responseFile,
    runDir: argOrDefault(argv[4], runBase),
    observeFile: argOrDefault(argv[5], `${runBase}_observe.json`),
    sessionMode: argv[6] ?? '',
    resumeArg: argv[7] ?? '',
    sessionHome: argv[8] ?? '',
  }
}

const wrapperArgsOf = (args: DispatchArgs): string[] => {
  const wrapperArgs = [
    args.model,
    args.taskType,
    args.requestFile,
    args.responseFile,
    args.runDir,
    args.observeFile,
  ]
  if (args.sessionMode !== '' || args.resumeArg !== '' || args.sessionHome !== '') {
    wrapperArgs.push(args.sessionMode, args.resumeArg, args.sessionHome)
  }
  return wrapperArgs
}

const ensureObserveInitialized = (args: DispatchArgs, backend: string): void => {
  mkdirSync(args.runDir, { recursive: true })
  if (!hasFileContent(args.observeFile)) {
    initObserve({
      observeFile: args.observeFile,
      runDir: args.runDir,
      taskType: args.taskType,
      model: args.model,
      backend,
      requestFile: args.requestFile,
      responseFile: args.responseFile,
      requesterSessionId: '',
    })
  }
}

interface DispatchRecordInput {
  args: DispatchArgs
  backend: string
  startMs: number | null
  outcome: WrapperOutcome
}

const recordDispatchEnd = (env: Env, input: DispatchRecordInput): boolean => {
  const { args, backend, outcome } = input
  const responsePresent = hasFileContent(args.responseFile)
  if (!responsePresent) {
    responseMissing(args.observeFile, args.runDir)
  }
  dispatchEnd(args.observeFile, args.runDir, {
    backend,
    dispatcherPid: process.pid,
    exitCode: outcome.exitCode,
    responsePresent,
  })
  try {
    appendDispatchMetrics(
      {
        observeFile: args.observeFile,
        taskType: args.taskType,
        model: args.model,
        backend,
        durationMs: elapsedMs(input.startMs),
        exitCode: outcome.exitCode,
        responsePresent,
        responseFile: args.responseFile,
      },
      env
    )
  } catch {
    // bash 版の || true と同じく telemetry 失敗で dispatch を止めない
  }
  return responsePresent
}

const wrapperStdoutOf = (outcome: WrapperOutcome): string => {
  const stripped = stripTrailingNewlinesText(outcome.stdout)
  if (stripped === '') {
    return ''
  }
  return `${stripped}\n`
}

const startDispatch = (args: DispatchArgs, backend: string): void => {
  ensureObserveInitialized(args, backend)
  dispatchStart(args.observeFile, args.runDir, { backend, dispatcherPid: process.pid })
  try {
    supersedeStalePrepared(args.observeFile, args.taskType)
  } catch {
    // bash 版の || true と同じく supersede 失敗で dispatch を止めない
  }
}

const dispatchToWrapper = (args: DispatchArgs, env: Env, io: DispatchIo): CliResult => {
  const startMs = monotonicMs()
  const backend = backendFor(args.taskType, args.model)
  if (backend === 'grok') {
    return {
      exitCode: 2,
      stderr:
        'ERROR: grok backend is not supported by shared dispatch.sh; use the xresearch wrapper directly.\n',
      stdout: '',
    }
  }
  startDispatch(args, backend)
  const outcome = spawnWrapper({
    script: path.join(io.scriptsDir, BACKEND_SCRIPTS[backend] ?? 'delegate-claude.sh'),
    args: wrapperArgsOf(args),
    env,
    captureStderr: io.captureStderr === true,
  })
  recordDispatchEnd(env, { args, backend, startMs, outcome })
  return { exitCode: outcome.exitCode, stderr: outcome.stderr, stdout: wrapperStdoutOf(outcome) }
}

export const runDispatch = (argv: readonly string[], env: Env, io: DispatchIo): CliResult => {
  const args = parseDispatchArgs(argv)
  if ('exitCode' in args) {
    return args
  }
  return dispatchToWrapper(args, env, io)
}

// in-source test 専用 helper (bundle からは treeshake で除去される)
const makeDispatchTestDir = (): string => {
  mkdirSync('.temp', { recursive: true })
  const dir = `.temp/dispatch-test-${Math.random().toString(36).slice(2)}`
  mkdirSync(dir)
  return dir
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  const { writeFileSync, chmodSync, readFileSync } = await import('node:fs')

  const makeFakeWrapper = (dir: string, script: string): void => {
    const file = path.join(dir, 'delegate-claude.sh')
    writeFileSync(file, script)
    chmodSync(file, 0o755)
  }

  describe('runDispatch', () => {
    it('fails closed with exit 2 on missing args', () => {
      const result = runDispatch(['haiku'], {}, { scriptsDir: '.' })
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('Usage:')
    })

    it('rejects the grok backend like the bash dispatch', () => {
      const result = runDispatch(
        ['grok-build', 'xresearch', 'req.json', 'res.json'],
        {},
        { scriptsDir: '.' }
      )
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('grok backend is not supported')
    })

    it('spawns the wrapper, records dispatch lifecycle, and passes the exit code through', () => {
      const dir = makeDispatchTestDir()
      const responseFile = path.join(dir, 'delegate_chore_x_res.json')
      makeFakeWrapper(
        dir,
        `#!/usr/bin/env bash\nprintf '%s\\n' "$4"\nprintf '{"status":"completed"}' >"$4"\nexit 0\n`
      )
      const observeFile = path.join(dir, 'delegate_chore_x_observe.json')
      const result = runDispatch(
        ['haiku', 'chore', path.join(dir, 'req.json'), responseFile, dir, observeFile],
        { ...process.env },
        { scriptsDir: dir, captureStderr: true }
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe(`${responseFile}\n`)
      const observe: unknown = JSON.parse(readFileSync(observeFile, 'utf8'))
      expect(observe).toMatchObject({
        state: { phase: 'ended', exit_code: 0, response_present: true },
      })
    })

    it('records response_missing and returns the wrapper failure code', () => {
      const dir = makeDispatchTestDir()
      makeFakeWrapper(dir, `#!/usr/bin/env bash\necho boom >&2\nexit 9\n`)
      const responseFile = path.join(dir, 'delegate_chore_y_res.json')
      const observeFile = path.join(dir, 'delegate_chore_y_observe.json')
      const result = runDispatch(
        ['haiku', 'chore', path.join(dir, 'req.json'), responseFile, dir, observeFile],
        { ...process.env },
        { scriptsDir: dir, captureStderr: true }
      )
      expect(result.exitCode).toBe(9)
      expect(result.stderr).toContain('boom')
      const observe: unknown = JSON.parse(readFileSync(observeFile, 'utf8'))
      expect(observe).toMatchObject({
        state: { phase: 'ended', exit_code: 9, response_present: false },
      })
      expect(JSON.stringify(observe)).toContain('response_missing')
    })

    it('appends the dispatch metrics record when DELEGATE_METRICS_FILE is set', () => {
      const dir = makeDispatchTestDir()
      makeFakeWrapper(dir, `#!/usr/bin/env bash\nprintf '{"status":"completed"}' >"$4"\nexit 0\n`)
      const responseFile = path.join(dir, 'delegate_chore_z_res.json')
      const observeFile = path.join(dir, 'delegate_chore_z_observe.json')
      const metricsFile = path.join(dir, 'metrics.jsonl')
      const result = runDispatch(
        ['haiku', 'chore', path.join(dir, 'req.json'), responseFile, dir, observeFile],
        { ...process.env, DELEGATE_METRICS_FILE: metricsFile },
        { scriptsDir: dir, captureStderr: true }
      )
      expect(result.exitCode).toBe(0)
      const record: unknown = JSON.parse(readFileSync(metricsFile, 'utf8').trimEnd())
      expect(record).toMatchObject({
        kind: 'dispatch',
        task_type: 'chore',
        model: 'haiku',
        backend: 'claude',
        exit_code: 0,
        response_present: true,
      })
    })

    it('derives run_dir and observe_file from the response path like the bash defaults', () => {
      const dir = makeDispatchTestDir()
      makeFakeWrapper(dir, `#!/usr/bin/env bash\nprintf '{"status":"completed"}' >"$4"\nexit 0\n`)
      const runDir = path.join(dir, 'delegate_chore_d')
      mkdirSync(runDir)
      const responseFile = `${runDir}_res.json`
      const result = runDispatch(
        ['haiku', 'chore', path.join(dir, 'req.json'), responseFile],
        { ...process.env },
        { scriptsDir: dir, captureStderr: true }
      )
      expect(result.exitCode).toBe(0)
      const observe: unknown = JSON.parse(readFileSync(`${runDir}_observe.json`, 'utf8'))
      expect(observe).toMatchObject({ run: { run_dir: runDir } })
    })
  })
}
