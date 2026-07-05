import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

interface ObserveJson {
  schema_version: number
  run: {
    model_source?: string
  }
  state: {
    phase?: string
    dispatcher_pid?: number
    pid?: number
    exit_code?: number
  }
  heartbeat: {
    child_pid?: number
    pid?: number
  }
  events: {
    kind: string
    dispatcher_pid?: number
    child_pid?: number
    message?: string
    source?: string
    timeout_seconds?: number
    idle_seconds?: number
  }[]
  usage?: {
    backend?: string
    cost_usd?: number | null
    input_tokens?: number | null
    measurement?: string
    model?: string
    output_tokens?: number | null
    source?: string
    total_tokens?: number | null
  }
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

const splitStatusAndObserve = (output: string): { status: number; observe: ObserveJson } => {
  const [statusLine, ...jsonLines] = output.trimEnd().split('\n')
  const status = Number(statusLine.replace(/^STATUS:/, ''))
  return { observe: parseObserveJson(jsonLines.join('\n')), status }
}

const findRequiredEvent = (observe: ObserveJson, kind: string): ObserveJson['events'][number] => {
  const index = observe.events.findIndex((candidate) => candidate.kind === kind)
  if (index === -1) {
    throw new Error(`missing ${kind} event`)
  }
  return observe.events[index]
}

const requireUsage = (observe: ObserveJson): NonNullable<ObserveJson['usage']> => {
  if (!observe.usage) {
    throw new Error('missing usage')
  }
  return observe.usage
}

const expectMeasuredUsage = (observe: ObserveJson): void => {
  const usage = requireUsage(observe)
  expect(usage.measurement).toBe('measured')
  expect(usage.source).toBe('claude_stream_json')
  expect(usage.input_tokens).toBe(120)
  expect(usage.output_tokens).toBe(30)
  expect(usage.total_tokens).toBe(150)
  expect(usage.cost_usd).toBe(0.0012)
}

const expectDevinExportUsage = (observe: ObserveJson): void => {
  const usage = requireUsage(observe)
  expect(usage.measurement).toBe('measured')
  expect(usage.source).toBe('devin_atif_export')
  expect(usage.input_tokens).toBe(15_691)
  expect(usage.output_tokens).toBe(3)
  expect(usage.total_tokens).toBe(15_694)
}

const expectCodexSessionUsage = (observe: ObserveJson): void => {
  const usage = requireUsage(observe)
  expect(usage.measurement).toBe('measured')
  expect(usage.source).toBe('codex_session_jsonl')
  expect(usage.input_tokens).toBe(13_656)
  expect(usage.output_tokens).toBe(17)
  expect(usage.total_tokens).toBe(13_673)
}

const expectCodexJsonUsage = (observe: ObserveJson): void => {
  const usage = requireUsage(observe)
  expect(usage.measurement).toBe('measured')
  expect(usage.source).toBe('codex_json')
  expect(usage.input_tokens).toBe(13_367)
  expect(usage.output_tokens).toBe(17)
  expect(usage.total_tokens).toBe(13_384)
}

const expectEstimatedUsage = (observe: ObserveJson): void => {
  const usage = requireUsage(observe)
  expect(usage.measurement).toBe('estimated')
  expect(usage.source).toBe('chars_4')
  expect(usage.input_tokens).toBe(2)
  expect(usage.output_tokens).toBe(1)
  expect(usage.total_tokens).toBe(3)
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

  it('records model source when observe init receives it', () => {
    const workDir = makeWorkDir()
    const output = runBash(
      `
      set -euo pipefail
      source shared/observe-json.sh
      run_dir="${workDir}/run"
      observe="$run_dir/run_observe.json"
      mkdir -p "$run_dir"
      delegate_observe_init "$observe" "$run_dir" chore gpt-5.4-mini codex req.json res.json requester env
      cat "$observe"
      `
    )

    expect(parseObserveJson(output).run.model_source).toBe('env')
  })

  it('returns model source in prepare output and observe JSON', () => {
    const workDir = makeWorkDir()
    const output = runBash(
      `
      set -euo pipefail
      DELEGATE_WORK_DIR="${workDir}" DELEGATE_CHORE_MODEL=gpt-5.4-mini bash shared/prepare.sh chore DELEGATE_CHORE_MODEL haiku '[]' requester <<'MD'
# Objective
test
MD
      `,
      { DELEGATE_METRICS_FILE: '' }
    )
    const prepared = parseJson(output)
    if (!isRecord(prepared) || typeof prepared.observe_file !== 'string') {
      throw new Error('invalid prepare output')
    }
    const observe = readObserveJson(prepared.observe_file)

    expect(prepared.model).toBe('gpt-5.4-mini')
    expect(prepared.model_source).toBe('env')
    expect(observe.run.model_source).toBe('env')
  })

  it('marks prepare model source as default when the type env is unset', () => {
    const workDir = makeWorkDir()
    const output = runBash(
      `
      set -euo pipefail
      unset DELEGATE_CHORE_MODEL
      DELEGATE_WORK_DIR="${workDir}" bash shared/prepare.sh chore DELEGATE_CHORE_MODEL haiku '[]' requester <<'MD'
# Objective
test
MD
      `,
      { DELEGATE_METRICS_FILE: '' }
    )
    const prepared = parseJson(output)
    if (!isRecord(prepared) || typeof prepared.observe_file !== 'string') {
      throw new Error('invalid prepare output')
    }
    const observe = readObserveJson(prepared.observe_file)

    expect(prepared.model).toBe('haiku')
    expect(prepared.model_source).toBe('default')
    expect(observe.run.model_source).toBe('default')
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

  describe('usage', () => {
    it('records measured usage parsed from JSONL capture', () => {
      const workDir = makeWorkDir()
      const output = runBash(
        `
        set -euo pipefail
        source shared/observe-json.sh
        run_dir="${workDir}/run"
        observe="$run_dir/run_observe.json"
        capture="$run_dir/worker-stdout.capture"
        mkdir -p "$run_dir"
        delegate_observe_init "$observe" "$run_dir" chore sonnet claude req.json res.json requester
        printf '%s\\n' '{"type":"system","usage":{"input_tokens":3}}' '{"type":"result","result":"completed","usage":{"input_tokens":120,"output_tokens":30},"total_cost_usd":0.0012}' >"$capture"
        measured="$(delegate_observe_usage_from_capture "$capture" sonnet claude claude_stream_json || true)"
        delegate_observe_record_usage "$observe" "$run_dir" claude sonnet req.json res.json claude_stream_json "$measured"
        cat "$observe"
        `
      )
      const observe = parseObserveJson(output)

      expectMeasuredUsage(observe)
    })

    it('records measured usage parsed from Devin ATIF export', () => {
      const workDir = makeWorkDir()
      const output = runBash(
        `
        set -euo pipefail
        source shared/observe-json.sh
        run_dir="${workDir}/run"
        observe="$run_dir/run_observe.json"
        export_file="$run_dir/devin-export.json"
        mkdir -p "$run_dir"
        printf '%s' '{"schema_version":"ATIF-v1.7","final_metrics":{"total_prompt_tokens":15691,"total_completion_tokens":3,"total_cached_tokens":769},"steps":[]}' >"$export_file"
        delegate_observe_init "$observe" "$run_dir" chore devin-glm-5.2 devin req.json res.json requester
        measured="$(delegate_observe_usage_from_devin_export "$export_file" devin-glm-5.2 devin || true)"
        delegate_observe_record_usage "$observe" "$run_dir" devin devin-glm-5.2 req.json res.json devin_atif_export "$measured"
        cat "$observe"
        `
      )
      const observe = parseObserveJson(output)

      expectDevinExportUsage(observe)
    })

    it('records measured usage parsed from Codex token count events', () => {
      const workDir = makeWorkDir()
      const output = runBash(
        `
        set -euo pipefail
        source shared/observe-json.sh
        run_dir="${workDir}/run"
        codex_home="$run_dir/codex-home"
        observe="$run_dir/run_observe.json"
        request="$run_dir/request.json"
        response="$run_dir/response.json"
        session_dir="$codex_home/sessions/2026/07/05"
        mkdir -p "$session_dir"
        printf '{"sections":["request"]}' >"$request"
        printf '{"sections":["response"]}' >"$response"
        printf '%s\\n' '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":13656,"cached_input_tokens":9600,"output_tokens":17,"reasoning_output_tokens":10,"total_tokens":13673}}}}' >"$session_dir/session.jsonl"
        delegate_observe_init "$observe" "$run_dir" chore gpt-5.5 codex "$request" "$response" requester
        measured="$(delegate_observe_usage_from_codex_sessions "$codex_home" gpt-5.5 codex || true)"
        delegate_observe_record_usage "$observe" "$run_dir" codex gpt-5.5 "$request" "$response" codex_session_jsonl "$measured"
        cat "$observe"
        `
      )
      const observe = parseObserveJson(output)

      expectCodexSessionUsage(observe)
    })

    it('records measured usage parsed from Codex JSON stdout', () => {
      const workDir = makeWorkDir()
      const output = runBash(
        `
        set -euo pipefail
        source shared/observe-json.sh
        run_dir="${workDir}/run"
        observe="$run_dir/run_observe.json"
        capture="$run_dir/worker-stdout.capture"
        mkdir -p "$run_dir"
        delegate_observe_init "$observe" "$run_dir" chore gpt-5.5 codex req.json res.json requester
        printf '%s\\n' '{"type":"thread.started","thread_id":"test"}' '{"type":"turn.completed","usage":{"input_tokens":13367,"cached_input_tokens":9088,"output_tokens":17,"reasoning_output_tokens":10}}' >"$capture"
        measured="$(delegate_observe_usage_from_capture "$capture" gpt-5.5 codex codex_json || true)"
        delegate_observe_record_usage "$observe" "$run_dir" codex gpt-5.5 req.json res.json codex_json "$measured"
        cat "$observe"
        `
      )
      const observe = parseObserveJson(output)

      expectCodexJsonUsage(observe)
    })

    it('ignores trailing usage objects without measured values', () => {
      const workDir = makeWorkDir()
      const output = runBash(
        `
        set -euo pipefail
        source shared/observe-json.sh
        run_dir="${workDir}/run"
        observe="$run_dir/run_observe.json"
        capture="$run_dir/worker-stdout.capture"
        mkdir -p "$run_dir"
        delegate_observe_init "$observe" "$run_dir" chore sonnet claude req.json res.json requester
        printf '%s\\n' '{"usage":{"input_tokens":120,"output_tokens":30},"total_cost_usd":0.0012}' '{"usage":{}}' >"$capture"
        measured="$(delegate_observe_usage_from_capture "$capture" sonnet claude claude_stream_json || true)"
        delegate_observe_record_usage "$observe" "$run_dir" claude sonnet req.json res.json claude_stream_json "$measured"
        cat "$observe"
        `
      )
      const observe = parseObserveJson(output)

      expectMeasuredUsage(observe)
    })

    it('falls back to estimated usage and records a parse failure event', () => {
      const workDir = makeWorkDir()
      const output = runBash(
        `
        set -euo pipefail
        source shared/observe-json.sh
        run_dir="${workDir}/run"
        observe="$run_dir/run_observe.json"
        request="$run_dir/request.json"
        response="$run_dir/response.json"
        mkdir -p "$run_dir"
        printf '{"sections":["12345678"]}' >"$request"
        printf '{"sections":["1234"]}' >"$response"
        delegate_observe_init "$observe" "$run_dir" chore haiku claude "$request" "$response" requester
        delegate_observe_record_usage "$observe" "$run_dir" claude haiku "$request" "$response" claude_stream_json ""
        cat "$observe"
        `
      )
      const observe = parseObserveJson(output)

      expectEstimatedUsage(observe)
      expect(observe.events.map((event) => event.kind)).toContain('usage_parse_failed')
    })
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

  it('kills a stalled child and records a stall timeout event', () => {
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
      : >"$stdout_capture"
      : >"$stderr_capture"
      delegate_observe_init "$observe" "$run_dir" chore haiku claude req.json res.json requester
      delegate_observe_dispatch_start "$observe" "$run_dir" claude 12345
      sleep 20 >"$stdout_capture" 2>"$stderr_capture" &
      child_pid=$!
      if DELEGATE_OBSERVE_HEARTBEAT_INTERVAL=1 DELEGATE_OBSERVE_STALL_TIMEOUT_SECONDS=1 delegate_observe_wait_with_heartbeat "$observe" "$run_dir" claude "$child_pid" "$stdout_capture" "$stderr_capture"; then
        status=0
      else
        status=$?
      fi
      delegate_observe_dispatch_end "$observe" "$run_dir" claude 12345 "$status" false
      printf 'STATUS:%s\\n' "$status"
      cat "$observe"
      `
    )
    const { status, observe } = splitStatusAndObserve(output)
    const stallEvent = findRequiredEvent(observe, 'stall_timeout')

    expect(status).toBe(124)
    expect(observe.state.phase).toBe('stalled')
    expect(stallEvent.timeout_seconds).toBe(1)
    expect(stallEvent.idle_seconds).toBeGreaterThanOrEqual(1)
  })

  it('removes old run directories while keeping running runs during build-request', () => {
    const workDir = makeWorkDir()
    runBash(
      `
      set -euo pipefail
      old_dir="${workDir}/delegate_chore_20260701_120000_oldaa"
      running_dir="${workDir}/delegate_chore_20260701_120000_runaa"
      mkdir -p "$old_dir" "$running_dir"
      printf '{"state":{"phase":"ended"}}' >"\${old_dir}_observe.json"
      printf '{"state":{"phase":"running"}}' >"\${running_dir}_observe.json"
      touch -d '3 days ago' "$old_dir" "$running_dir"
      DELEGATE_WORK_DIR="${workDir}" DELEGATE_RUN_RETENTION_DAYS=1 bash shared/build-request.sh chore haiku '[]' requester <<'MD'
# Objective
test
MD
      `,
      { DELEGATE_METRICS_FILE: '' }
    )

    expect(existsSync(path.join(workDir, 'delegate_chore_20260701_120000_oldaa'))).toBe(false)
    expect(existsSync(path.join(workDir, 'delegate_chore_20260701_120000_runaa'))).toBe(true)
  })
})
