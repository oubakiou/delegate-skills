import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

interface ObserveJson {
  schema_version: number
  state: {
    dispatcher_pid?: number
    pid?: number
    exit_code?: number
  }
  heartbeat: {
    child_pid?: number
    pid?: number
  }
  events: { kind: string; dispatcher_pid?: number }[]
  streams: {
    stdout: { bytes: number; truncated: boolean; content: string }
    stderr: { bytes: number; truncated: boolean; content: string }
  }
}

interface FailedResponse {
  status: string
  sections: string[]
}

const makeWorkDir = (): string => {
  const tempRoot = path.join(repoRoot, '.temp')
  mkdirSync(tempRoot, { recursive: true })
  return mkdtempSync(path.join(tempRoot, 'observe-json-test-'))
}

const runBash = (script: string, env: NodeJS.ProcessEnv = {}): string =>
  execFileSync('bash', ['-c', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const parseJson = (content: string): unknown => {
  const value: unknown = JSON.parse(content)
  return value
}

const isObserveJson = (value: unknown): value is ObserveJson => {
  if (!isRecord(value)) {
    return false
  }
  return (
    typeof value.schema_version === 'number' &&
    isRecord(value.state) &&
    isRecord(value.heartbeat) &&
    Array.isArray(value.events) &&
    isRecord(value.streams)
  )
}

const isFailedResponse = (value: unknown): value is FailedResponse => {
  if (!isRecord(value)) {
    return false
  }
  return typeof value.status === 'string' && Array.isArray(value.sections)
}

const parseObserveJson = (content: string): ObserveJson => {
  const value = parseJson(content)
  if (!isObserveJson(value)) {
    throw new Error('invalid observe JSON')
  }
  return value
}

const readFailedResponse = (filePath: string): FailedResponse => {
  const value = parseJson(readFileSync(filePath, 'utf8'))
  if (!isFailedResponse(value)) {
    throw new Error('invalid failed response JSON')
  }
  return value
}

const readObserveJson = (filePath: string): ObserveJson =>
  parseObserveJson(readFileSync(filePath, 'utf8'))

const expectDispatchState = (observe: ObserveJson): void => {
  expect(observe.state.dispatcher_pid).toBe(12_345)
  expect(observe.state.pid).toBeUndefined()
  expect(observe.state.exit_code).toBe(7)
  expect(observe.heartbeat.child_pid).toBe(12_346)
  expect(observe.heartbeat.pid).toBeUndefined()
}

const expectDispatchEvents = (observe: ObserveJson): void => {
  expect(observe.events.map((event) => event.kind)).toEqual([
    'run_created',
    'dispatch_start',
    'dispatch_end',
  ])
  expect(observe.events[1].dispatcher_pid).toBe(12_345)
  expect(observe.events[2].dispatcher_pid).toBe(12_345)
}

const expectDispatchObserve = (observe: ObserveJson): void => {
  expect(observe.schema_version).toBe(1)
  expectDispatchState(observe)
  expectDispatchEvents(observe)
  expect(observe.streams.stdout.content).toBe('stdout')
  expect(observe.streams.stderr.content).toBe('stderr')
}

const expectCappedStreams = (observe: ObserveJson): void => {
  expect(observe.streams.stdout.bytes).toBe(4)
  expect(observe.streams.stdout.truncated).toBe(false)
  expect(observe.streams.stdout.content).toBe('a\0b\n')
  expect(observe.streams.stderr.bytes).toBe(10)
  expect(observe.streams.stderr.truncated).toBe(true)
  expect(observe.streams.stderr.content).toBe('7890')
}

describe('observe-json.sh', () => {
  it('records dispatcher and child pid with dispatch events', () => {
    const workDir = makeWorkDir()
    const output = runBash(
      `
      set -euo pipefail
      source shared/observe-json.sh
      run_dir="${workDir}/run"
      observe="$run_dir/run_observe.json"
      stdout_capture="$run_dir/worker-stdout.capture"
      stderr_capture="$run_dir/worker-stderr.capture"
      mkdir -p "$run_dir"
      printf 'stdout' >"$stdout_capture"
      printf 'stderr' >"$stderr_capture"
      delegate_observe_init "$observe" "$run_dir" chore haiku claude req.json res.json requester
      delegate_observe_dispatch_start "$observe" "$run_dir" claude 12345
      delegate_observe_heartbeat "$observe" "$run_dir" claude 12346 "$stdout_capture" "$stderr_capture"
      delegate_observe_import_streams "$observe" "$run_dir" "$stdout_capture" "$stderr_capture"
      delegate_observe_dispatch_end "$observe" "$run_dir" claude 12345 7 false
      cat "$observe"
      `
    )
    expectDispatchObserve(parseObserveJson(output))
  })

  it('imports stream content through jq rawfile and applies byte cap', () => {
    const workDir = makeWorkDir()
    const output = runBash(
      `
      set -euo pipefail
      source shared/observe-json.sh
      run_dir="${workDir}/run"
      observe="$run_dir/run_observe.json"
      stdout_capture="$run_dir/worker-stdout.capture"
      stderr_capture="$run_dir/worker-stderr.capture"
      mkdir -p "$run_dir"
      printf 'a\\000b\\n' >"$stdout_capture"
      printf '1234567890' >"$stderr_capture"
      delegate_observe_init "$observe" "$run_dir" chore haiku claude req.json res.json requester
      DELEGATE_OBSERVE_STREAM_MAX_BYTES=4 delegate_observe_import_streams "$observe" "$run_dir" "$stdout_capture" "$stderr_capture"
      cat "$observe"
      `
    )
    expectCappedStreams(parseObserveJson(output))
  })

  it('writes failed response and companion markdown through the shared helper', () => {
    const workDir = makeWorkDir()
    runBash(
      `
      set -euo pipefail
      source shared/observe-json.sh
      run_dir="${workDir}/run"
      observe="$run_dir/run_observe.json"
      response="$run_dir/delegate_chore_20260704_120000_abcde_res.json"
      mkdir -p "$run_dir"
      delegate_observe_init "$observe" "$run_dir" chore haiku claude req.json "$response" requester
      delegate_observe_write_failed_response "$observe" "$run_dir" claude "$response" 9
      delegate_observe_write_companion_markdown "$response"
      `,
      { DELEGATE_METRICS_FILE: '' }
    )
    const response = readFailedResponse(
      path.join(workDir, 'run', 'delegate_chore_20260704_120000_abcde_res.json')
    )
    const observe = readObserveJson(path.join(workDir, 'run', 'run_observe.json'))

    expect(response.status).toBe('failed')
    expect(response.sections.join('\n')).toContain('See observe JSON:')
    expect(response.sections.join('\n')).toContain('Exit code: 9')
    expect(observe.events.map((event) => event.kind)).toContain('failed_response_written')
    expect(
      existsSync(path.join(workDir, 'run', 'delegate_chore_20260704_120000_abcde_res.md'))
    ).toBe(true)
  })
})
