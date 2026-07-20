import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, closeSync, constants, openSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Env } from './build-request.ts'
import { getPath, readFileOrEmpty, stringOf } from './jq-compat.ts'
import { heartbeat, importStreams, stallTimeout } from './observe-store.ts'
import { elapsedMs, firstUsefulSeen, monotonicMs } from './observe-timing.ts'
import { exitStatusFromChild } from './protocol.ts'
import { positiveIntOrZero, processTreeJson } from './wrapper-report.ts'

// bash 版 observe-json.sh の delegate_observe_wait_with_heartbeat と同一契約。
// 子の終了検知を最大 1 秒に抑えるため 1 秒刻みで poll し、heartbeat と stall 判定
// だけを heartbeat_interval ごとに実行する。観測系の失敗で dispatch 本体を殺さない
// よう、observe 更新と JSON 読みは fail-soft にする。

const executableIn = (dir: string, command: string): boolean => {
  try {
    const file = path.join(dir, command)
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

// bash の command -v 相当（PATH 走査のみ。組み込み・関数は対象外）
export const commandAvailable = (command: string, env: Env): boolean =>
  (env.PATH ?? '').split(':').some((dir) => dir !== '' && executableIn(dir, command))

export interface WorkerSpawnInput {
  command: string
  args: readonly string[]
  cwd: string
  env: Record<string, string | undefined>
  // null は bash の </dev/null 相当
  stdinFile: string | null
  stdoutCapture: string
  stderrCapture: string
}

export interface SpawnedWorker {
  child: ChildProcess
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  isRunning: () => boolean
}

const stdinStdio = (stdinFile: string | null): 'ignore' | number => {
  if (stdinFile === null) {
    return 'ignore'
  }
  return openSync(stdinFile, 'r')
}

const closeFdQuietly = (fd: 'ignore' | number): void => {
  if (typeof fd !== 'number') {
    return
  }
  try {
    closeSync(fd)
  } catch {
    // 既にクローズ済みなら何もしない
  }
}

// bash の trap cleanup（EXIT INT TERM で子を kill）と同じ後始末を signal handler で行う
const registerChildCleanup = (child: ChildProcess): (() => void) => {
  const killChild = (): void => {
    try {
      child.kill()
    } catch {
      // 既に終了済みなら何もしない
    }
  }
  process.once('SIGINT', killChild)
  process.once('SIGTERM', killChild)
  process.once('exit', killChild)
  return (): void => {
    process.removeListener('SIGINT', killChild)
    process.removeListener('SIGTERM', killChild)
    process.removeListener('exit', killChild)
  }
}

const makeExitPromise = async (
  child: ChildProcess,
  onDone: () => void
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
  new Promise((resolve) => {
    child.once('error', () => {
      onDone()
      resolve({ code: 127, signal: null })
    })
    child.once('exit', (code, signal) => {
      onDone()
      resolve({ code, signal })
    })
  })

const spawnWithCaptureFds = (input: WorkerSpawnInput): ChildProcess => {
  const stdinFd = stdinStdio(input.stdinFile)
  const stdoutFd = openSync(input.stdoutCapture, 'w')
  const stderrFd = openSync(input.stderrCapture, 'w')
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    stdio: [stdinFd, stdoutFd, stderrFd],
  })
  closeFdQuietly(stdinFd)
  closeFdQuietly(stdoutFd)
  closeFdQuietly(stderrFd)
  return child
}

export const spawnWorker = (input: WorkerSpawnInput): SpawnedWorker => {
  const child = spawnWithCaptureFds(input)
  const removeCleanup = registerChildCleanup(child)
  const finished = { done: false }
  const exited = makeExitPromise(child, () => {
    finished.done = true
    removeCleanup()
  })
  return { child, exited, isRunning: () => !finished.done }
}

// unref しないと最後の poll の残タイマーが event loop を保持し、子の終了後も
// プロセス終了が最大 1 秒遅れる（子プロセスハンドルが loop を保持するため、
// 待機中に process が先に終わることはない）
const sleepMs = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })

export interface WaitInput {
  observeFile: string
  runDir: string
  backend: string
  worker: SpawnedWorker
  stdoutCapture: string
  stderrCapture: string
  responseFile: string
  env: Env
}

export interface WaitResult {
  childStatus: number
  totalMs: number | null
  firstUsefulMs: number | null
  reportReadyMs: number | null
}

interface WaitProgress {
  firstUsefulMs: number | null
  reportReadyMs: number | null
}

const hasResponseContent = (responseFile: string): boolean => {
  try {
    return responseFile !== '' && statSync(responseFile).size > 0
  } catch {
    return false
  }
}

// 最終 poll と終了の間（最大 1 秒）に届いた分の取りこぼしも、この probe の再実行で拾う
const probeProgress = (
  input: WaitInput,
  waitStartMs: number | null,
  progress: WaitProgress
): void => {
  if (waitStartMs === null) {
    return
  }
  if (progress.firstUsefulMs === null && firstUsefulSeen(input.backend, input.stdoutCapture)) {
    progress.firstUsefulMs = elapsedMs(waitStartMs)
  }
  if (progress.reportReadyMs === null && hasResponseContent(input.responseFile)) {
    progress.reportReadyMs = elapsedMs(waitStartMs)
  }
}

const heartbeatIntervalOf = (env: Env): number => {
  const interval = positiveIntOrZero(env.DELEGATE_OBSERVE_HEARTBEAT_INTERVAL ?? '10')
  if (interval > 0) {
    return interval
  }
  return 10
}

const idleSecondsOf = (input: WaitInput): number => {
  let lastChange = ''
  try {
    const doc: unknown = JSON.parse(readFileOrEmpty(input.observeFile))
    lastChange = stringOf(
      getPath(doc, ['heartbeat', 'last_stream_change_at']) ?? getPath(doc, ['state', 'started_at'])
    )
  } catch {
    lastChange = ''
  }
  const parsed = Date.parse(lastChange)
  if (Number.isNaN(parsed)) {
    return 0
  }
  return Math.floor(Date.now() / 1000) - Math.floor(parsed / 1000)
}

const heartbeatQuietly = (input: WaitInput, childPid: number): void => {
  try {
    heartbeat(input.observeFile, input.runDir, {
      backend: input.backend,
      childPid,
      stdoutCapture: input.stdoutCapture,
      stderrCapture: input.stderrCapture,
    })
  } catch {
    // 観測系の失敗で dispatch 本体を殺さない
  }
}

const recordStallQuietly = (
  input: WaitInput,
  detail: { childPid: number; timeoutSeconds: number }
): void => {
  let processTree: string[] = []
  try {
    processTree = processTreeJson(detail.childPid)
  } catch {
    processTree = []
  }
  try {
    stallTimeout({
      observeFile: input.observeFile,
      runDir: input.runDir,
      backend: input.backend,
      childPid: detail.childPid,
      timeoutSeconds: detail.timeoutSeconds,
      idleSeconds: idleSecondsOf(input),
      stdoutCapture: input.stdoutCapture,
      stderrCapture: input.stderrCapture,
      processTree,
    })
  } catch {
    // 観測系の失敗で dispatch 本体を殺さない
  }
}

const killStalledChild = async (worker: SpawnedWorker): Promise<void> => {
  try {
    worker.child.kill('SIGTERM')
  } catch {
    // 既に終了済み
  }
  // grace は worker 終了と race する。子が SIGTERM で即死した場合、unref した grace
  // タイマーだけが残って event loop が空になり Node が exit 13 で先に落ちるのを防ぐ
  // （子が SIGTERM を無視して生存し続ける場合は child ハンドルが loop を保持する）
  await Promise.race([sleepMs(1000), worker.exited])
  try {
    worker.child.kill('SIGKILL')
  } catch {
    // 既に終了済み
  }
}

interface WaitLoopContext {
  input: WaitInput
  waitStartMs: number | null
  progress: WaitProgress
  heartbeatInterval: number
  stallTimeoutSeconds: number
  childPid: number
}

const stallDetected = (input: WaitInput, stallTimeoutSeconds: number): boolean => {
  if (stallTimeoutSeconds <= 0) {
    return false
  }
  return idleSecondsOf(input) >= stallTimeoutSeconds
}

// heartbeat 契機の stall 判定。stall なら子を kill して true を返す
const heartbeatAndStallCheck = async (context: WaitLoopContext): Promise<boolean> => {
  heartbeatQuietly(context.input, context.childPid)
  if (!stallDetected(context.input, context.stallTimeoutSeconds)) {
    return false
  }
  recordStallQuietly(context.input, {
    childPid: context.childPid,
    timeoutSeconds: context.stallTimeoutSeconds,
  })
  await killStalledChild(context.input.worker)
  return true
}

const pollOnce = async (
  context: WaitLoopContext,
  counter: { secondsUntilHeartbeat: number }
): Promise<'continue' | 'stalled'> => {
  probeProgress(context.input, context.waitStartMs, context.progress)
  if (counter.secondsUntilHeartbeat <= 0) {
    counter.secondsUntilHeartbeat = context.heartbeatInterval
    if (await heartbeatAndStallCheck(context)) {
      return 'stalled'
    }
  }
  // sleep は子の終了で即時に打ち切る（bash の sleep 1 は非中断だが、bash は起動
  // オーバーヘッド中に速い子が先に終わるため実効挙動は同じ。長寿命の子では同一）
  await Promise.race([sleepMs(1000), context.input.worker.exited])
  counter.secondsUntilHeartbeat -= 1
  return 'continue'
}

const waitLoop = async (context: WaitLoopContext): Promise<boolean> => {
  const counter = { secondsUntilHeartbeat: 0 }
  while (context.input.worker.isRunning()) {
    // 1 秒刻みの生存 poll が本質の待機ループで、逐次 await が仕様
    // eslint-disable-next-line no-await-in-loop
    const outcome = await pollOnce(context, counter)
    if (outcome === 'stalled') {
      return true
    }
  }
  return false
}

const finalStatus = (
  stalled: boolean,
  exitResult: { code: number | null; signal: NodeJS.Signals | null }
): number => {
  if (stalled) {
    return 124
  }
  // bash の wait はシグナル死を 128+signum で返す（SIGHUP=129 等も含む）。共通変換を使う
  return exitStatusFromChild(exitResult)
}

const finalizeWaitObserve = (input: WaitInput, childPid: number): void => {
  heartbeat(input.observeFile, input.runDir, {
    backend: input.backend,
    childPid,
    stdoutCapture: input.stdoutCapture,
    stderrCapture: input.stderrCapture,
  })
  importStreams(input.observeFile, input.runDir, {
    stdoutCapture: input.stdoutCapture,
    stderrCapture: input.stderrCapture,
    env: input.env,
  })
}

export const waitWithHeartbeat = async (input: WaitInput): Promise<WaitResult> => {
  const waitStartMs = monotonicMs()
  const progress: WaitProgress = { firstUsefulMs: null, reportReadyMs: null }
  const context: WaitLoopContext = {
    input,
    waitStartMs,
    progress,
    heartbeatInterval: heartbeatIntervalOf(input.env),
    stallTimeoutSeconds: positiveIntOrZero(input.env.DELEGATE_OBSERVE_STALL_TIMEOUT_SECONDS ?? '0'),
    childPid: input.worker.child.pid ?? 0,
  }
  const stalled = await waitLoop(context)
  const childStatus = finalStatus(stalled, await input.worker.exited)
  const totalMs = elapsedMs(waitStartMs)
  probeProgress(input, waitStartMs, progress)
  finalizeWaitObserve(input, context.childPid)
  return {
    childStatus,
    totalMs,
    firstUsefulMs: progress.firstUsefulMs,
    reportReadyMs: progress.reportReadyMs,
  }
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs')

  const makeWaitTestDir = (): string => {
    mkdirSync('.temp', { recursive: true })
    const dir = `.temp/wrapper-wait-test-${Math.random().toString(36).slice(2)}`
    mkdirSync(dir)
    return dir
  }

  const writeObserveFixture = (dir: string, heartbeatDoc: Record<string, unknown>): string => {
    const observeFile = path.join(dir, 'run_observe.json')
    writeFileSync(
      observeFile,
      JSON.stringify({
        schema_version: 1,
        state: { phase: 'running' },
        heartbeat: heartbeatDoc,
        events: [],
        streams: {},
      })
    )
    return observeFile
  }

  describe('commandAvailable', () => {
    it('finds executables on PATH and rejects missing ones', () => {
      expect(commandAvailable('bash', process.env)).toBe(true)
      expect(commandAvailable('no-such-cli-xyz', process.env)).toBe(false)
      expect(commandAvailable('bash', { PATH: '/nonexistent' })).toBe(false)
    })
  })

  describe('spawnWorker + waitWithHeartbeat', () => {
    it('captures streams, returns the exit status, and imports streams into observe', async () => {
      const dir = makeWaitTestDir()
      const observeFile = writeObserveFixture(dir, {})
      const worker = spawnWorker({
        command: 'bash',
        args: ['-c', 'echo out-line; echo err-line >&2; exit 7'],
        cwd: dir,
        env: { ...process.env },
        stdinFile: null,
        stdoutCapture: path.join(dir, 'stdout.capture'),
        stderrCapture: path.join(dir, 'stderr.capture'),
      })
      const result = await waitWithHeartbeat({
        observeFile,
        runDir: dir,
        backend: 'claude',
        worker,
        stdoutCapture: path.join(dir, 'stdout.capture'),
        stderrCapture: path.join(dir, 'stderr.capture'),
        responseFile: path.join(dir, 'run_res.json'),
        env: {},
      })
      expect(result.childStatus).toBe(7)
      expect(result.totalMs).not.toBeNull()
      const observe: unknown = JSON.parse(readFileSync(observeFile, 'utf8'))
      expect(observe).toMatchObject({
        streams: { stdout: { content: 'out-line\n' }, stderr: { content: 'err-line\n' } },
      })
    })

    it('returns 127 when the command cannot be spawned', async () => {
      const dir = makeWaitTestDir()
      const observeFile = writeObserveFixture(dir, {})
      const worker = spawnWorker({
        command: '/nonexistent/cli',
        args: [],
        cwd: dir,
        env: { ...process.env },
        stdinFile: null,
        stdoutCapture: path.join(dir, 'stdout.capture'),
        stderrCapture: path.join(dir, 'stderr.capture'),
      })
      const result = await waitWithHeartbeat({
        observeFile,
        runDir: dir,
        backend: 'claude',
        worker,
        stdoutCapture: path.join(dir, 'stdout.capture'),
        stderrCapture: path.join(dir, 'stderr.capture'),
        responseFile: '',
        env: {},
      })
      expect(result.childStatus).toBe(127)
    })

    it('kills a stalled child and reports status 124 with a stall_timeout event', async () => {
      const dir = makeWaitTestDir()
      const past = new Date(Date.now() - 3600 * 1000).toISOString()
      const observeFile = writeObserveFixture(dir, { last_stream_change_at: past })
      const worker = spawnWorker({
        command: 'bash',
        args: ['-c', 'sleep 600'],
        cwd: dir,
        env: { ...process.env },
        stdinFile: null,
        stdoutCapture: path.join(dir, 'stdout.capture'),
        stderrCapture: path.join(dir, 'stderr.capture'),
      })
      const result = await waitWithHeartbeat({
        observeFile,
        runDir: dir,
        backend: 'claude',
        worker,
        stdoutCapture: path.join(dir, 'stdout.capture'),
        stderrCapture: path.join(dir, 'stderr.capture'),
        responseFile: '',
        env: {
          DELEGATE_OBSERVE_STALL_TIMEOUT_SECONDS: '5',
          DELEGATE_OBSERVE_HEARTBEAT_INTERVAL: '1',
        },
      })
      expect(result.childStatus).toBe(124)
      const observe: unknown = JSON.parse(readFileSync(observeFile, 'utf8'))
      expect(JSON.stringify(observe)).toContain('stall_timeout')
      expect(observe).toMatchObject({ state: { phase: 'stalled' } })
    }, 30_000)
  })
}
