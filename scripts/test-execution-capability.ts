import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const PROBE_SENTINEL = 'delegate-skills-test-execution-capability-ok'
const PROBE_TIMEOUT_MS = 5000

export interface ChildExecutionProbeObservation {
  errorCode: string | null
  signal: NodeJS.Signals | null
  status: number | null
  stderr: string
  stdout: string
}

const errorCodeOf = (error: Error | undefined): string | null => {
  if (!error) {
    return null
  }
  const { code } = error as NodeJS.ErrnoException
  if (typeof code === 'string') {
    return code
  }
  return null
}

const probeProgram = `process.stdout.write(${JSON.stringify(PROBE_SENTINEL)})`

const errorFailure = (errorCode: string | null): string | null => {
  if (errorCode === null) {
    return null
  }
  return `error=${errorCode}`
}

const statusFailure = (status: number | null): string | null => {
  if (status === 0) {
    return null
  }
  return `status=${String(status)}`
}

const signalFailure = (signal: NodeJS.Signals | null): string | null => {
  if (signal === null) {
    return null
  }
  return `signal=${signal}`
}

const stdoutFailure = (stdout: string): string | null => {
  if (stdout === PROBE_SENTINEL) {
    return null
  }
  return `stdout=${JSON.stringify(stdout)}`
}

const appendStderr = (failure: string, stderr: string): string => {
  if (stderr === '') {
    return failure
  }
  return `${failure}, stderr=${JSON.stringify(stderr)}`
}

export const childExecutionProbeFailure = (
  kind: 'async' | 'sync',
  observation: ChildExecutionProbeObservation
): string | null => {
  const failures = [
    errorFailure(observation.errorCode),
    statusFailure(observation.status),
    signalFailure(observation.signal),
    stdoutFailure(observation.stdout),
  ].filter((failure): failure is string => failure !== null)
  if (failures.length === 0) {
    return null
  }
  return appendStderr(`${kind}: ${failures.join(', ')}`, observation.stderr)
}

export const unsupportedTestEnvironmentMessage = (failure: string): string =>
  [
    `TEST_ENVIRONMENT_UNSUPPORTED: Node child-process execution probe failed (${failure}).`,
    'The test suite was not started because its contract-test results would be unreliable.',
    'Run `npm test` in an environment that permits subprocess execution.',
    'For Codex, start a new trusted session with an allowed `--sandbox danger-full-access` override; managed or host policy may still require using CI or a normal terminal.',
  ].join(' ')

const syncProbe = (): ChildExecutionProbeObservation => {
  const result = spawnSync(process.execPath, ['-e', probeProgram], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
  })
  return {
    errorCode: errorCodeOf(result.error),
    signal: result.signal,
    status: result.status,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  }
}

const asyncProbe = async (): Promise<ChildExecutionProbeObservation> =>
  new Promise((resolve) => {
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const child = spawn(process.execPath, ['-e', probeProgram], {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    child.once('error', (error) => {
      resolve({
        errorCode: errorCodeOf(error),
        signal: null,
        status: null,
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      })
    })
    child.once('close', (status, signal) => {
      resolve({
        errorCode: null,
        signal,
        status,
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      })
    })
  })

export const assertTestExecutionCapability = async (): Promise<void> => {
  const syncFailure = childExecutionProbeFailure('sync', syncProbe())
  if (syncFailure !== null) {
    throw new Error(unsupportedTestEnvironmentMessage(syncFailure))
  }

  const asyncFailure = childExecutionProbeFailure('async', await asyncProbe())
  if (asyncFailure !== null) {
    throw new Error(unsupportedTestEnvironmentMessage(asyncFailure))
  }
}

const isDirectRun = (): boolean => {
  const [, entry] = process.argv
  if (!entry) {
    return false
  }
  return import.meta.url === pathToFileURL(entry).href
}

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

if (isDirectRun()) {
  try {
    await assertTestExecutionCapability()
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`)
    process.exitCode = 1
  }
}

const STALE_RUN_MS = 60 * 60 * 1000

const sweepScratch = async (olderThanMs: number): Promise<void> => {
  const { sweepTestScratch } = await import('../shared/src/test-scratch.ts')
  sweepTestScratch({ olderThanMs })
}

export interface TestEnvironmentSetupDeps {
  assertCapability: () => Promise<void>
  sweep: (olderThanMs: number) => Promise<void>
}

// teardown ではなく setup 側で掃除する。teardown は worker pool が閉じる前に走るため
// 自 run の scratch を所有 pid 生存として保護してしまい、異常終了時には走らない
export const runTestEnvironmentSetup = async (deps: TestEnvironmentSetupDeps): Promise<void> => {
  // probe が通らない環境では sweep も実行しない (capability 不成立のまま副作用を出さない)
  await deps.assertCapability()
  // sweep の失敗は preflight の fail-closed 判定を覆さない。catch を sweep 呼び出しだけに
  // 狭く掛け、TEST_ENVIRONMENT_UNSUPPORTED を警告へ格下げしないようにする
  try {
    await deps.sweep(STALE_RUN_MS)
  } catch (error) {
    process.stderr.write(`test scratch sweep skipped: ${errorMessage(error)}\n`)
  }
}

export const setupTestEnvironment = async (): Promise<void> =>
  runTestEnvironmentSetup({ assertCapability: assertTestExecutionCapability, sweep: sweepScratch })

export default setupTestEnvironment
