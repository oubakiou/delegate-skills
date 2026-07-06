import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

interface ObserveJson {
  schema_version: number
  backend_session?: {
    backend?: string
    home_dir?: string | null
    model?: string
    persistence?: string
    resume_id?: string | null
    resume_source?: string | null
  }
  lineage?: {
    followup_of?: string | null
    lineage_id?: string
  }
  run: {
    model_source?: string
  }
  run_context?: {
    dirty?: boolean
    git_branch?: string | null
    git_head?: string
    repo_root?: string
    worktree_root?: string
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
    process_tree?: string[]
    superseded_by?: string
  }[]
  usage?: {
    backend?: string
    cached_input_tokens?: number | null
    cost_estimate_basis?: string
    cost_usd?: number | null
    cost_usd_estimated?: number
    estimation_basis?: string
    input_tokens?: number | null
    measurement?: string
    model?: string
    output_tokens?: number | null
    pricing_source?: string
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

const errorOutputPart = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8')
  }
  return ''
}

const runBashStatus = (
  script: string,
  env: NodeJS.ProcessEnv = {}
): { output: string; status: number } => {
  try {
    const output = runBash(script, env)
    return { output, status: 0 }
  } catch (error) {
    if (isRecord(error) && typeof error.status === 'number') {
      const stdout = errorOutputPart(error.stdout)
      const stderr = errorOutputPart(error.stderr)
      return { output: `${stdout}${stderr}`, status: error.status }
    }
    throw error
  }
}

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
  expect(usage.cost_usd_estimated).toBeUndefined()
}

const expectDevinExportUsage = (observe: ObserveJson): void => {
  const usage = requireUsage(observe)
  expect(usage.measurement).toBe('measured')
  expect(usage.source).toBe('devin_atif_export')
  expect(usage.input_tokens).toBe(15_691)
  expect(usage.output_tokens).toBe(3)
  expect(usage.total_tokens).toBe(15_694)
}

// gpt-5.5 単価: (input - cached)*5 + cached*0.5 + output*30 per 1M tokens
const expectCachedRateCostEstimate = (
  usage: NonNullable<ObserveJson['usage']>,
  costUsdEstimated: number
): void => {
  expect(usage.cost_usd_estimated).toBeCloseTo(costUsdEstimated, 10)
  expect(usage.cost_estimate_basis).toBe('cached_input_rate_applied')
  expect(usage.pricing_source).toBe('model-token-prices.json:openai')
  expect(usage.cost_usd).toBeNull()
}

const expectCodexSessionUsage = (observe: ObserveJson): void => {
  const usage = requireUsage(observe)
  expect(usage.measurement).toBe('measured')
  expect(usage.source).toBe('codex_session_jsonl')
  expect(usage.input_tokens).toBe(13_656)
  expect(usage.cached_input_tokens).toBe(9600)
  expect(usage.output_tokens).toBe(17)
  expect(usage.total_tokens).toBe(13_673)
  expectCachedRateCostEstimate(usage, 0.025_59)
}

const expectCodexJsonUsage = (observe: ObserveJson): void => {
  const usage = requireUsage(observe)
  expect(usage.measurement).toBe('measured')
  expect(usage.source).toBe('codex_json')
  expect(usage.input_tokens).toBe(13_367)
  expect(usage.cached_input_tokens).toBe(9088)
  expect(usage.output_tokens).toBe(17)
  expect(usage.total_tokens).toBe(13_384)
  expectCachedRateCostEstimate(usage, 0.026_449)
}

const expectEstimatedUsage = (observe: ObserveJson): void => {
  const usage = requireUsage(observe)
  expect(usage.measurement).toBe('estimated')
  expect(usage.estimation_basis).toBe('protocol_payload_only')
  expect(usage.source).toBe('chars_4')
  expect(usage.input_tokens).toBe(2)
  expect(usage.output_tokens).toBe(1)
  expect(usage.total_tokens).toBe(3)
  expect(usage.cost_usd_estimated).toBeUndefined()
}

const requireBackendSession = (
  observe: ObserveJson
): NonNullable<ObserveJson['backend_session']> => {
  if (!observe.backend_session) {
    throw new Error('missing backend_session')
  }
  return observe.backend_session
}

const requireRunContext = (observe: ObserveJson): NonNullable<ObserveJson['run_context']> => {
  if (!observe.run_context) {
    throw new Error('missing run_context')
  }
  return observe.run_context
}

const makeResumableObserve = (workDir: string, overrides = ''): string => `
  source shared/observe-json.sh
  run_dir="${workDir}/run"
  observe="$run_dir/run_observe.json"
  mkdir -p "$run_dir"
  delegate_observe_init "$observe" "$run_dir" chore gpt-5.5 codex req.json res.json requester
  delegate_observe_backend_session_update "$observe" "$run_dir" codex gpt-5.5 thread-1 codex_json resumable "$run_dir/codex-home"
  delegate_observe_run_context_update "$observe" "$run_dir" "${repoRoot}" "${repoRoot}"
  ${overrides}
`

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

  it('rejects session_mode for read-only task types', () => {
    const workDir = makeWorkDir()
    const resumable = runBashStatus(
      `
      set -euo pipefail
      DELEGATE_WORK_DIR="${workDir}" bash shared/prepare.sh explore DELEGATE_EXPLORE_MODEL haiku '[]' requester resumable <<'MD'
# Objective
test
MD
      `,
      { DELEGATE_METRICS_FILE: '' }
    )
    const followup = runBashStatus(
      `
      set -euo pipefail
      DELEGATE_WORK_DIR="${workDir}" bash shared/prepare.sh review DELEGATE_REVIEW_MODEL opus '[]' requester followup="${workDir}/previous.json" <<'MD'
# Objective
test
MD
      `,
      { DELEGATE_METRICS_FILE: '' }
    )

    expect(resumable.status).toBe(2)
    expect(resumable.output).toContain('session_mode is only supported for implement/chore')
    expect(followup.status).toBe(2)
    expect(followup.output).toContain('session_mode is only supported for implement/chore')
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

    it('falls back to uncached rates when the cache breakdown is missing', () => {
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
        printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}' >"$capture"
        measured="$(delegate_observe_usage_from_capture "$capture" gpt-5.5 codex codex_json || true)"
        delegate_observe_record_usage "$observe" "$run_dir" codex gpt-5.5 req.json res.json codex_json "$measured"
        cat "$observe"
        `
      )
      const usage = requireUsage(parseObserveJson(output))

      // gpt-5.5 非キャッシュ単価: 100*5 + 10*30 per 1M tokens
      expect(usage.cost_usd_estimated).toBeCloseTo(0.0008, 10)
      expect(usage.cost_estimate_basis).toBe('uncached_input_rate_upper_bound')
    })

    it('resolves prefixed devin models and prefers the backend pricing source', () => {
      const workDir = makeWorkDir()
      const output = runBash(
        `
        set -euo pipefail
        source shared/observe-json.sh
        run_dir="${workDir}/run"
        observe="$run_dir/run_observe.json"
        mkdir -p "$run_dir"
        delegate_observe_init "$observe" "$run_dir" chore devin-glm-5.2 devin req.json res.json requester
        measured='{"input_tokens":1000000,"cached_input_tokens":null,"output_tokens":0,"total_tokens":1000000,"cost_usd":null,"measurement":"measured","source":"devin_json","model":"devin-glm-5.2","backend":"devin"}'
        delegate_observe_record_usage "$observe" "$run_dir" devin devin-glm-5.2 req.json res.json devin_json "$measured"
        cat "$observe"
        `
      )
      const usage = requireUsage(parseObserveJson(output))

      // glm-5.2(cognition): 1M input tokens * 1.4 per 1M tokens
      expect(usage.cost_usd_estimated).toBeCloseTo(1.4, 10)
      expect(usage.pricing_source).toBe('model-token-prices.json:cognition')
    })

    it('resolves cursor effort-suffixed models against the base price entry', () => {
      const workDir = makeWorkDir()
      const output = runBash(
        `
        set -euo pipefail
        source shared/observe-json.sh
        run_dir="${workDir}/run"
        observe="$run_dir/run_observe.json"
        mkdir -p "$run_dir"
        delegate_observe_init "$observe" "$run_dir" chore cursor-glm-5.2-high cursor req.json res.json requester
        measured='{"input_tokens":1000000,"cached_input_tokens":null,"output_tokens":0,"total_tokens":1000000,"cost_usd":null,"measurement":"measured","source":"cursor_json","model":"cursor-glm-5.2-high","backend":"cursor"}'
        delegate_observe_record_usage "$observe" "$run_dir" cursor cursor-glm-5.2-high req.json res.json cursor_json "$measured"
        cat "$observe"
        `
      )
      const usage = requireUsage(parseObserveJson(output))

      expect(usage.cost_usd_estimated).toBeCloseTo(1.4, 10)
      expect(usage.pricing_source).toBe('model-token-prices.json:cursor')
    })

    it('omits the cost estimate when the price table has no usable entry', () => {
      const workDir = makeWorkDir()
      const output = runBash(
        `
        set -euo pipefail
        source shared/observe-json.sh
        run_dir="${workDir}/run"
        observe="$run_dir/run_observe.json"
        capture="$run_dir/worker-stdout.capture"
        mkdir -p "$run_dir"
        delegate_observe_init "$observe" "$run_dir" chore gpt-5 codex req.json res.json requester
        printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}' >"$capture"
        measured="$(delegate_observe_usage_from_capture "$capture" gpt-5 codex codex_json || true)"
        delegate_observe_record_usage "$observe" "$run_dir" codex gpt-5 req.json res.json codex_json "$measured"
        cat "$observe"
        `
      )
      const usage = requireUsage(parseObserveJson(output))

      expect(usage.measurement).toBe('measured')
      expect(usage.cost_usd_estimated).toBeUndefined()
      expect(usage.cost_estimate_basis).toBeUndefined()
      expect(usage.pricing_source).toBeUndefined()
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
})

describe('session reuse metadata merge', () => {
  it('merges lineage, backend session, and realpath run context', () => {
    const workDir = makeWorkDir()
    const output = runBash(
      `
        set -euo pipefail
        source shared/observe-json.sh
        run_dir="${workDir}/run"
        observe="$run_dir/run_observe.json"
        mkdir -p "$run_dir"
        delegate_observe_init "$observe" "$run_dir" implement gpt-5.5 codex req.json res.json requester
        delegate_observe_lineage_update "$observe" "$run_dir" lineage-1 previous-observe.json
        delegate_observe_backend_session_update "$observe" "$run_dir" codex gpt-5.5 thread-1 codex_json resumable "$run_dir/codex-home"
        delegate_observe_run_context_update "$observe" "$run_dir" "${repoRoot}/." "${repoRoot}/."
        cat "$observe"
        `
    )
    const observe = parseObserveJson(output)
    const runContext = requireRunContext(observe)

    expect(observe.lineage).toEqual({
      followup_of: 'previous-observe.json',
      lineage_id: 'lineage-1',
    })
    expect(observe.backend_session).toEqual({
      backend: 'codex',
      home_dir: `${workDir}/run/codex-home`,
      model: 'gpt-5.5',
      persistence: 'resumable',
      resume_id: 'thread-1',
      resume_source: 'codex_json',
    })
    expect(runContext.repo_root).toBe(repoRoot)
    expect(runContext.worktree_root).toBe(repoRoot)
    expect(runContext.git_head).toMatch(/^[0-9a-f]{40}$/)
    expect(typeof runContext.dirty).toBe('boolean')
  })

  it('records unavailable resume metadata and event', () => {
    const workDir = makeWorkDir()
    const output = runBash(
      `
        set -euo pipefail
        source shared/observe-json.sh
        run_dir="${workDir}/run"
        observe="$run_dir/run_observe.json"
        mkdir -p "$run_dir"
        delegate_observe_init "$observe" "$run_dir" implement gpt-5.5 codex req.json res.json requester
        delegate_observe_resume_unavailable "$observe" "$run_dir" codex gpt-5.5 "missing thread.started"
        cat "$observe"
        `
    )
    const observe = parseObserveJson(output)
    const backendSession = requireBackendSession(observe)

    expect(backendSession.persistence).toBe('unavailable')
    expect(backendSession.resume_id).toBeNull()
    expect(observe.events.map((event) => event.kind)).toContain('resume_unavailable')
  })
})

describe('session reuse metadata validation', () => {
  it('validates resumable follow-up metadata', () => {
    const workDir = makeWorkDir()
    const { status, output } = runBashStatus(
      `
        set -euo pipefail
        ${makeResumableObserve(workDir)}
        delegate_observe_validate_followup "$observe" codex gpt-5.5 "${repoRoot}" "${repoRoot}"
        `
    )

    expect(status).toBe(0)
    expect(output).toBe('')
  })

  it('fails closed when previous observe JSON is missing', () => {
    const workDir = makeWorkDir()
    const { status, output } = runBashStatus(
      `
        set -euo pipefail
        source shared/observe-json.sh
        delegate_observe_validate_followup "${workDir}/missing.json" codex gpt-5.5 "${repoRoot}" "${repoRoot}"
        `
    )

    expect(status).not.toBe(0)
    expect(output).toContain('previous observe JSON is missing')
  })

  it('fails closed when resume handle is missing', () => {
    const workDir = makeWorkDir()
    const { status, output } = runBashStatus(
      `
        set -euo pipefail
        ${makeResumableObserve(
          workDir,
          'jq \'.backend_session.resume_id = null\' "$observe" >"$run_dir/tmp.json" && mv "$run_dir/tmp.json" "$observe"'
        )}
        delegate_observe_validate_followup "$observe" codex gpt-5.5 "${repoRoot}" "${repoRoot}"
        `
    )

    expect(status).not.toBe(0)
    expect(output).toContain('backend_session.resume_id is missing')
  })

  it('fails closed when persistence is not resumable', () => {
    const workDir = makeWorkDir()
    const { status, output } = runBashStatus(
      `
        set -euo pipefail
        ${makeResumableObserve(
          workDir,
          'jq \'.backend_session.persistence = "ephemeral"\' "$observe" >"$run_dir/tmp.json" && mv "$run_dir/tmp.json" "$observe"'
        )}
        delegate_observe_validate_followup "$observe" codex gpt-5.5 "${repoRoot}" "${repoRoot}"
        `
    )

    expect(status).not.toBe(0)
    expect(output).toContain('backend_session.persistence is not resumable')
  })

  it('fails closed on backend and model mismatches', () => {
    const workDir = makeWorkDir()
    const backendResult = runBashStatus(
      `
        set -euo pipefail
        ${makeResumableObserve(workDir)}
        delegate_observe_validate_followup "$observe" claude gpt-5.5 "${repoRoot}" "${repoRoot}"
        `
    )
    const modelResult = runBashStatus(
      `
        set -euo pipefail
        source shared/observe-json.sh
        observe="${workDir}/run/run_observe.json"
        delegate_observe_validate_followup "$observe" codex gpt-5 "${repoRoot}" "${repoRoot}"
        `
    )

    expect(backendResult.status).not.toBe(0)
    expect(backendResult.output).toContain('backend mismatch')
    expect(modelResult.status).not.toBe(0)
    expect(modelResult.output).toContain('model mismatch')
  })

  it('fails closed on repo and worktree mismatches', () => {
    const workDir = makeWorkDir()
    const otherRoot = `${workDir}/other`
    mkdirSync(otherRoot)
    const repoResult = runBashStatus(
      `
        set -euo pipefail
        ${makeResumableObserve(workDir)}
        delegate_observe_validate_followup "$observe" codex gpt-5.5 "${otherRoot}" "${repoRoot}"
        `
    )
    const worktreeResult = runBashStatus(
      `
        set -euo pipefail
        source shared/observe-json.sh
        observe="${workDir}/run/run_observe.json"
        delegate_observe_validate_followup "$observe" codex gpt-5.5 "${repoRoot}" "${otherRoot}"
        `
    )

    expect(repoResult.status).not.toBe(0)
    expect(repoResult.output).toContain('repo_root mismatch')
    expect(worktreeResult.status).not.toBe(0)
    expect(worktreeResult.output).toContain('worktree_root mismatch')
  })

  it('fails closed when run context required fields are missing', () => {
    const workDir = makeWorkDir()
    const { status, output } = runBashStatus(
      `
        set -euo pipefail
        ${makeResumableObserve(
          workDir,
          'jq \'del(.run_context.git_head)\' "$observe" >"$run_dir/tmp.json" && mv "$run_dir/tmp.json" "$observe"'
        )}
        delegate_observe_validate_followup "$observe" codex gpt-5.5 "${repoRoot}" "${repoRoot}"
        `
    )

    expect(status).not.toBe(0)
    expect(output).toContain('run_context required field is missing')
  })

  it('allows identical and ancestor git heads but rejects unrelated heads', () => {
    const workDir = makeWorkDir()
    const gitDir = `${workDir}/git-repo`
    const output = runBash(
      `
        set -euo pipefail
        source shared/observe-json.sh
        git_dir="${gitDir}"
        run_dir="${workDir}/run"
        observe="$run_dir/run_observe.json"
        mkdir -p "$git_dir" "$run_dir"
        git -C "$git_dir" init -q
        git -C "$git_dir" config user.email test@example.com
        git -C "$git_dir" config user.name Test
        printf base >"$git_dir/file.txt"
        git -C "$git_dir" add file.txt
        git -C "$git_dir" commit -q -m base
        delegate_observe_init "$observe" "$run_dir" chore gpt-5.5 codex req.json res.json requester
        delegate_observe_backend_session_update "$observe" "$run_dir" codex gpt-5.5 thread-1 codex_json resumable "$run_dir/codex-home"
        delegate_observe_run_context_update "$observe" "$run_dir" "$git_dir" "$git_dir"
        delegate_observe_validate_followup "$observe" codex gpt-5.5 "$git_dir" "$git_dir"
        printf descendant >>"$git_dir/file.txt"
        git -C "$git_dir" add file.txt
        git -C "$git_dir" commit -q -m descendant
        delegate_observe_validate_followup "$observe" codex gpt-5.5 "$git_dir" "$git_dir"
        git -C "$git_dir" checkout -q --orphan unrelated
        git -C "$git_dir" rm -q -rf .
        printf unrelated >"$git_dir/other.txt"
        git -C "$git_dir" add other.txt
        git -C "$git_dir" commit -q -m unrelated
        if delegate_observe_validate_followup "$observe" codex gpt-5.5 "$git_dir" "$git_dir" 2>"$run_dir/error.txt"; then
          printf 'unexpected-success'
        else
          cat "$run_dir/error.txt"
        fi
        `
    )

    expect(output).toContain('git_head is not current HEAD or its ancestor')
    expect(output).not.toContain('unexpected-success')
  })

  it('fails closed for unsupported backend instead of falling back', () => {
    const workDir = makeWorkDir()
    const { status, output } = runBashStatus(
      `
        set -euo pipefail
        ${makeResumableObserve(
          workDir,
          'jq \'.backend_session.backend = "grok"\' "$observe" >"$run_dir/tmp.json" && mv "$run_dir/tmp.json" "$observe"'
        )}
        delegate_observe_validate_followup "$observe" grok gpt-5.5 "${repoRoot}" "${repoRoot}"
        `
    )

    expect(status).not.toBe(0)
    expect(output).toContain('unsupported backend: grok')
  })
})

describe('observe-json.sh lifecycle helpers', () => {
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
    const processTree = stallEvent.process_tree ?? []
    expect(processTree.some((line) => line.includes('sleep'))).toBe(true)
  })

  it('supersedes stale prepared observes of the same type and requester only', () => {
    const workDir = makeWorkDir()
    runBash(
      `
      set -euo pipefail
      source shared/observe-json.sh
      init() {
        local run_dir="${workDir}/delegate_chore_20260706_$1"
        mkdir -p "$run_dir"
        delegate_observe_init "\${run_dir}_observe.json" "$run_dir" chore haiku claude req.json res.json "$2"
      }
      init 000009_zzzzz req-1
      init 000002_bbbbb req-1
      init 000003_ccccc other-req
      init 000006_rrrrr req-1
      rm -rf "${workDir}/delegate_chore_20260706_000006_rrrrr"
      init 000004_ddddd req-1
      delegate_observe_dispatch_start "${workDir}/delegate_chore_20260706_000002_bbbbb_observe.json" "${workDir}/delegate_chore_20260706_000002_bbbbb" claude 111
      delegate_observe_dispatch_start "${workDir}/delegate_chore_20260706_000004_ddddd_observe.json" "${workDir}/delegate_chore_20260706_000004_ddddd" claude 222
      delegate_observe_supersede_stale_prepared "${workDir}/delegate_chore_20260706_000004_ddddd_observe.json" chore
      `,
      { DELEGATE_METRICS_FILE: '' }
    )
    const observeAt = (name: string): ObserveJson =>
      readObserveJson(path.join(workDir, `delegate_chore_20260706_${name}_observe.json`))

    // 000001 は basename 辞書順では current より古くないが mtime では古い（同一秒対策）
    expect(observeAt('000009_zzzzz').state.phase).toBe('superseded')
    expect(observeAt('000002_bbbbb').state.phase).toBe('running')
    expect(observeAt('000003_ccccc').state.phase).toBe('prepared')
    expect(observeAt('000006_rrrrr').state.phase).toBe('prepared')
    expect(existsSync(path.join(workDir, 'delegate_chore_20260706_000006_rrrrr'))).toBe(false)
    const supersededEvent = findRequiredEvent(observeAt('000009_zzzzz'), 'superseded')
    expect(supersededEvent.superseded_by).toBe('delegate_chore_20260706_000004_ddddd_observe.json')
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
