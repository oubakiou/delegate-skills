import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getPath, stringOf } from '../shared/src/jq-compat.ts'
import { validateFollowup, writeFailedResponse } from '../shared/src/observe-followup.ts'
import {
  appendDispatchMetrics,
  appendObserveEvent,
  dispatchEnd,
  dispatchStart,
  heartbeat,
  importStreams,
  initObserve,
  recordEffort,
  recordTiming,
  recordUsage,
  markSuperseded,
  resumeUnavailable,
  stallTimeout,
  supersedeStalePrepared,
  updateBackendSession,
  updateLineage,
  updateMcpConfig,
  updateRunContext,
  usageParseFailed,
} from '../shared/src/observe-store.ts'

// bash 版 observe-json.sh の mutate 関数と TS モジュールに同一の操作列を適用し、
// 生成される observe JSON をタイムスタンプ・パス正規化のうえ突き合わせる等価性検証。
// bash 実装が存在する限り両者のスキーマ一致を保証する。

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const makeWorkDir = (): string => {
  const tempRoot = path.join(repoRoot, '.temp')
  mkdirSync(tempRoot, { recursive: true })
  return mkdtempSync(path.join(tempRoot, 'observe-store-parity-'))
}

const runBashOps = (script: string, env: NodeJS.ProcessEnv = {}): string =>
  execFileSync('bash', ['-c', `set -uo pipefail\nsource shared/observe-json.sh\n${script}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })

// タイムスタンプ・実行ごとのパス・秒精度依存の duration を潰して比較する
const normalizedJson = (raw: unknown, baseDir: string): unknown => {
  const text = JSON.stringify(raw)
    .replaceAll(baseDir, '<DIR>')
    .replaceAll(/"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z"/g, '"<TS>"')
    .replaceAll(/"duration_ms":\d+/g, '"duration_ms":"<DUR>"')
  return JSON.parse(text) as unknown
}

const normalizedObserve = (dir: string): unknown =>
  normalizedJson(JSON.parse(readFileSync(path.join(dir, 'run', 'run_observe.json'), 'utf8')), dir)

const setupDir = (dir: string): { runDir: string; observe: string } => {
  const runDir = path.join(dir, 'run')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(path.join(runDir, 'out.cap'), 'stream-output-data')
  writeFileSync(path.join(runDir, 'err.cap'), 'errdata')
  return { runDir, observe: path.join(runDir, 'run_observe.json') }
}

const MEASURED_USAGE_OBJECT: Record<string, unknown> = {
  input_tokens: 1000,
  cached_input_tokens: 200,
  output_tokens: 50,
  total_tokens: 1050,
  cost_usd: null,
  measurement: 'measured',
  source: 'csj',
  model: 'haiku',
  backend: 'claude',
}

const MEASURED_USAGE = JSON.stringify(MEASURED_USAGE_OBJECT)

const bashLifecycleScript = (dir: string): string => `
run_dir="${dir}/run"
observe="$run_dir/run_observe.json"
delegate_observe_init "$observe" "$run_dir" chore haiku claude req.json res.json requester env-var
delegate_observe_lineage_update "$observe" "$run_dir" lin-1 prev_observe.json
delegate_observe_backend_session_update "$observe" "$run_dir" claude haiku sess-1 stream_json resumable "$run_dir/home"
delegate_observe_mcp_config_update "$observe" "$run_dir" injected '["alpha","beta",7]'
delegate_observe_dispatch_start "$observe" "$run_dir" claude 4242
delegate_observe_heartbeat "$observe" "$run_dir" claude 4243 "$run_dir/out.cap" "$run_dir/err.cap"
delegate_observe_usage_parse_failed "$observe" "$run_dir" claude test_source boom
delegate_observe_record_effort "$observe" "$run_dir" high '{"value":"low","source":"measured"}'
delegate_observe_record_usage "$observe" "$run_dir" claude haiku req.json res.json csj '${MEASURED_USAGE}'
DELEGATE_OBSERVE_STREAM_MAX_BYTES=6 delegate_observe_import_streams "$observe" "$run_dir" "$run_dir/out.cap" "$run_dir/err.cap"
delegate_observe_record_timing "$observe" "$run_dir" claude "$run_dir/out.cap" 1200 300 900 '' true
delegate_observe_dispatch_end "$observe" "$run_dir" claude 4242 0 true
delegate_observe_response_missing "$observe" "$run_dir"
delegate_observe_failed_response_written "$observe" "$run_dir"
`

const tsLifecycleSteps = (runDir: string, observe: string): (() => void)[] => [
  (): void =>
    initObserve({
      observeFile: observe,
      runDir,
      taskType: 'chore',
      model: 'haiku',
      backend: 'claude',
      requestFile: 'req.json',
      responseFile: 'res.json',
      requesterSessionId: 'requester',
      modelSource: 'env-var',
    }),
  (): void =>
    updateLineage(observe, runDir, { lineageId: 'lin-1', followupOf: 'prev_observe.json' }),
  (): void =>
    updateBackendSession(observe, runDir, {
      backend: 'claude',
      model: 'haiku',
      resumeId: 'sess-1',
      resumeSource: 'stream_json',
      persistence: 'resumable',
      homeDir: path.join(runDir, 'home'),
    }),
  (): void =>
    updateMcpConfig(observe, runDir, { source: 'injected', servers: ['alpha', 'beta', 7] }),
  (): void => dispatchStart(observe, runDir, { backend: 'claude', dispatcherPid: 4242 }),
  (): void =>
    heartbeat(observe, runDir, {
      backend: 'claude',
      childPid: 4243,
      stdoutCapture: path.join(runDir, 'out.cap'),
      stderrCapture: path.join(runDir, 'err.cap'),
    }),
  (): void =>
    usageParseFailed(observe, runDir, {
      backend: 'claude',
      source: 'test_source',
      message: 'boom',
    }),
  (): void =>
    recordEffort(observe, runDir, {
      requested: 'high',
      effective: { value: 'low', source: 'measured' },
    }),
  (): void =>
    recordUsage({
      observeFile: observe,
      runDir,
      backend: 'claude',
      model: 'haiku',
      requestFile: 'req.json',
      responseFile: 'res.json',
      source: 'csj',
      measured: { ...MEASURED_USAGE_OBJECT },
    }),
  (): void =>
    importStreams(observe, runDir, {
      stdoutCapture: path.join(runDir, 'out.cap'),
      stderrCapture: path.join(runDir, 'err.cap'),
      env: { DELEGATE_OBSERVE_STREAM_MAX_BYTES: '6' },
    }),
  (): void =>
    recordTiming({
      observeFile: observe,
      runDir,
      backend: 'claude',
      stdoutCapture: path.join(runDir, 'out.cap'),
      totalMs: 1200,
      firstUsefulMs: 300,
      reportReadyMs: 900,
      structuredOutputParse: true,
    }),
  (): void =>
    dispatchEnd(observe, runDir, {
      backend: 'claude',
      dispatcherPid: 4242,
      exitCode: 0,
      responsePresent: true,
    }),
  (): void =>
    appendObserveEvent(observe, runDir, { kind: 'response_missing', ts: '2026-01-01T00:00:00Z' }),
  (): void =>
    appendObserveEvent(observe, runDir, {
      kind: 'failed_response_written',
      ts: '2026-01-01T00:00:00Z',
    }),
]

const estimatedUsageScript = (dir: string): string => `
run_dir="${dir}/run"
observe="$run_dir/run_observe.json"
printf '{"sections":["# Objective\\n\\nbody"]}' >"$run_dir/req.json"
printf '{"sections":["# Summary\\n\\nok"]}' >"$run_dir/res.json"
delegate_observe_init "$observe" "$run_dir" chore haiku claude "$run_dir/req.json" "$run_dir/res.json" requester
delegate_observe_record_usage "$observe" "$run_dir" claude haiku "$run_dir/req.json" "$run_dir/res.json" claude_stream_json
`

const runTsEstimatedUsage = (dir: string): void => {
  const { runDir, observe } = setupDir(dir)
  writeFileSync(path.join(runDir, 'req.json'), '{"sections":["# Objective\n\nbody"]}')
  writeFileSync(path.join(runDir, 'res.json'), '{"sections":["# Summary\n\nok"]}')
  initObserve({
    observeFile: observe,
    runDir,
    taskType: 'chore',
    model: 'haiku',
    backend: 'claude',
    requestFile: path.join(runDir, 'req.json'),
    responseFile: path.join(runDir, 'res.json'),
    requesterSessionId: 'requester',
  })
  recordUsage({
    observeFile: observe,
    runDir,
    backend: 'claude',
    model: 'haiku',
    requestFile: path.join(runDir, 'req.json'),
    responseFile: path.join(runDir, 'res.json'),
    source: 'claude_stream_json',
  })
}

const runContextScript = (dir: string): string => `
run_dir="${dir}/run"
observe="$run_dir/run_observe.json"
delegate_observe_init "$observe" "$run_dir" chore gpt-5.5 codex req.json res.json requester
delegate_observe_run_context_update "$observe" "$run_dir" "${repoRoot}" "${repoRoot}"
delegate_observe_resume_unavailable "$observe" "$run_dir" codex gpt-5.5 "managed policy" "$run_dir/home"
`

const runTsRunContext = (dir: string): void => {
  const { runDir, observe } = setupDir(dir)
  initObserve({
    observeFile: observe,
    runDir,
    taskType: 'chore',
    model: 'gpt-5.5',
    backend: 'codex',
    requestFile: 'req.json',
    responseFile: 'res.json',
    requesterSessionId: 'requester',
  })
  updateRunContext(observe, runDir, { repoRoot, worktreeRoot: repoRoot })
  resumeUnavailable(observe, runDir, {
    backend: 'codex',
    model: 'gpt-5.5',
    reason: 'managed policy',
    homeDir: path.join(runDir, 'home'),
  })
}

const supersedePaths = (
  dir: string
): { older: string; olderRun: string; newer: string; newerRun: string } => {
  const older = path.join(dir, 'delegate_chore_20260101_000000_aaaaa_observe.json')
  const newer = path.join(dir, 'delegate_chore_20260101_000001_bbbbb_observe.json')
  return {
    older,
    olderRun: older.replace(/_observe\.json$/, ''),
    newer,
    newerRun: newer.replace(/_observe\.json$/, ''),
  }
}

const runBashSupersede = (dir: string): string => {
  const paths = supersedePaths(dir)
  mkdirSync(paths.olderRun, { recursive: true })
  mkdirSync(paths.newerRun, { recursive: true })
  runBashOps(`
delegate_observe_init '${paths.older}' '${paths.olderRun}' chore haiku claude r1 s1 requester
sleep 0.05
delegate_observe_init '${paths.newer}' '${paths.newerRun}' chore haiku claude r2 s2 requester
delegate_observe_supersede_stale_prepared '${paths.newer}' chore
`)
  return paths.older
}

const tsInitForSupersede = (observeFile: string, runDir: string, files: [string, string]): void => {
  initObserve({
    observeFile,
    runDir,
    taskType: 'chore',
    model: 'haiku',
    backend: 'claude',
    requestFile: files[0],
    responseFile: files[1],
    requesterSessionId: 'requester',
  })
}

const runTsSupersede = (dir: string): string => {
  const paths = supersedePaths(dir)
  mkdirSync(paths.olderRun, { recursive: true })
  mkdirSync(paths.newerRun, { recursive: true })
  tsInitForSupersede(paths.older, paths.olderRun, ['r1', 's1'])
  tsInitForSupersede(paths.newer, paths.newerRun, ['r2', 's2'])
  supersedeStalePrepared(paths.newer, 'chore')
  return paths.older
}

const runBashMetrics = (dir: string): unknown => {
  const metricsFile = path.join(dir, 'metrics.jsonl')
  setupDir(dir)
  runBashOps(
    `
run_dir="${dir}/run"
observe="$run_dir/run_observe.json"
delegate_observe_init "$observe" "$run_dir" chore haiku claude req.json res.json requester
delegate_observe_record_timing "$observe" "$run_dir" claude "$run_dir/out.cap" 1200 300 900 '' true
delegate_observe_append_dispatch_metrics "$observe" chore haiku claude 1234 0 true "$run_dir/res.json"
`,
    { DELEGATE_METRICS_FILE: metricsFile }
  )
  return normalizedJson(JSON.parse(readFileSync(metricsFile, 'utf8').trim()), dir)
}

const runTsMetrics = (dir: string): unknown => {
  const metricsFile = path.join(dir, 'metrics.jsonl')
  const { runDir, observe } = setupDir(dir)
  initObserve({
    observeFile: observe,
    runDir,
    taskType: 'chore',
    model: 'haiku',
    backend: 'claude',
    requestFile: 'req.json',
    responseFile: 'res.json',
    requesterSessionId: 'requester',
  })
  recordTiming({
    observeFile: observe,
    runDir,
    backend: 'claude',
    stdoutCapture: path.join(runDir, 'out.cap'),
    totalMs: 1200,
    firstUsefulMs: 300,
    reportReadyMs: 900,
    structuredOutputParse: true,
  })
  appendDispatchMetrics(
    {
      observeFile: observe,
      taskType: 'chore',
      model: 'haiku',
      backend: 'claude',
      durationMs: 1234,
      exitCode: 0,
      responsePresent: true,
      responseFile: path.join(runDir, 'res.json'),
    },
    { DELEGATE_METRICS_FILE: metricsFile }
  )
  return normalizedJson(JSON.parse(readFileSync(metricsFile, 'utf8').trim()), dir)
}

const runBashFailedResponse = (dir: string): unknown => {
  setupDir(dir)
  runBashOps(`
run_dir="${dir}/run"
observe="$run_dir/run_observe.json"
delegate_observe_init "$observe" "$run_dir" chore haiku claude req.json "$run_dir/run_res.json" requester
delegate_observe_write_failed_response "$observe" "$run_dir" claude "$run_dir/run_res.json" 7
`)
  return normalizedJson(
    JSON.parse(readFileSync(path.join(dir, 'run', 'run_res.json'), 'utf8')),
    dir
  )
}

const runTsFailedResponse = (dir: string): unknown => {
  const { runDir, observe } = setupDir(dir)
  const responseFile = path.join(runDir, 'run_res.json')
  initObserve({
    observeFile: observe,
    runDir,
    taskType: 'chore',
    model: 'haiku',
    backend: 'claude',
    requestFile: 'req.json',
    responseFile,
    requesterSessionId: 'requester',
  })
  const written = writeFailedResponse({
    observeFile: observe,
    runDir,
    backend: 'claude',
    responseFile,
    exitCode: 7,
  })
  expect(written).toBe(true)
  return normalizedJson(JSON.parse(readFileSync(responseFile, 'utf8')), dir)
}

interface FollowupCase {
  backend: string
  model: string
  repo: string
  worktree: string
  file: string
}

const bashFailureOf = (error: unknown): { status: number; stderr: string } => {
  const result = { status: 1, stderr: '' }
  if (typeof error === 'object' && error !== null) {
    if ('status' in error && typeof error.status === 'number') {
      result.status = error.status
    }
    if ('stderr' in error && typeof error.stderr === 'string') {
      result.stderr = error.stderr.trim()
    }
  }
  return result
}

const bashValidateFollowup = (followupCase: FollowupCase): { status: number; stderr: string } => {
  try {
    execFileSync(
      'bash',
      [
        '-c',
        `source shared/observe-json.sh\ndelegate_observe_validate_followup '${followupCase.file}' '${followupCase.backend}' '${followupCase.model}' '${followupCase.repo}' '${followupCase.worktree}'`,
      ],
      { cwd: repoRoot, encoding: 'utf8' }
    )
    return { status: 0, stderr: '' }
  } catch (error) {
    return bashFailureOf(error)
  }
}

const expectFollowupParity = (followupCase: FollowupCase): void => {
  const tsResult = validateFollowup({
    previousObserveFile: followupCase.file,
    expectedBackend: followupCase.backend,
    expectedModel: followupCase.model,
    expectedRepoRoot: followupCase.repo,
    expectedWorktreeRoot: followupCase.worktree,
  })
  const bash = bashValidateFollowup(followupCase)
  if (tsResult.ok) {
    expect(bash.status, JSON.stringify(followupCase)).toBe(0)
  } else {
    expect(bash.status, JSON.stringify(followupCase)).not.toBe(0)
    expect(bash.stderr, JSON.stringify(followupCase)).toBe(tsResult.message)
  }
}

interface HeartbeatContext {
  runDir: string
  observe: string
  viaBash: boolean
}

const heartbeatInit = (context: HeartbeatContext): void => {
  if (context.viaBash) {
    runBashOps(
      `delegate_observe_init '${context.observe}' '${context.runDir}' chore haiku claude req.json res.json requester`
    )
  } else {
    initObserve({
      observeFile: context.observe,
      runDir: context.runDir,
      taskType: 'chore',
      model: 'haiku',
      backend: 'claude',
      requestFile: 'req.json',
      responseFile: 'res.json',
      requesterSessionId: 'requester',
    })
  }
}

const heartbeatOnce = (context: HeartbeatContext): void => {
  if (context.viaBash) {
    runBashOps(
      `delegate_observe_heartbeat '${context.observe}' '${context.runDir}' claude 4243 '${context.runDir}/out.cap' '${context.runDir}/err.cap'`
    )
  } else {
    heartbeat(context.observe, context.runDir, {
      backend: 'claude',
      childPid: 4243,
      stdoutCapture: path.join(context.runDir, 'out.cap'),
      stderrCapture: path.join(context.runDir, 'err.cap'),
    })
  }
}

const lastStreamChangeOf = (context: HeartbeatContext): string =>
  stringOf(
    getPath(JSON.parse(readFileSync(context.observe, 'utf8')), [
      'heartbeat',
      'last_stream_change_at',
    ])
  )

const heartbeatValues = (dir: string, viaBash: boolean): [string, string, string] => {
  const context = { ...setupDir(dir), viaBash }
  heartbeatInit(context)
  heartbeatOnce(context)
  const first = lastStreamChangeOf(context)
  execFileSync('sleep', ['1.1'])
  heartbeatOnce(context)
  const second = lastStreamChangeOf(context)
  writeFileSync(path.join(context.runDir, 'out.cap'), 'stream-output-data-grown-longer')
  heartbeatOnce(context)
  return [first, second, lastStreamChangeOf(context)]
}

const runBashStalled = (dir: string): unknown => {
  setupDir(dir)
  runBashOps(`
run_dir="${dir}/run"
observe="$run_dir/run_observe.json"
delegate_observe_init "$observe" "$run_dir" chore haiku claude req.json res.json requester
delegate_observe_dispatch_start "$observe" "$run_dir" claude 4242
delegate_observe_stall_timeout "$observe" "$run_dir" claude 999999 60 61 "$run_dir/out.cap" "$run_dir/err.cap"
delegate_observe_dispatch_end "$observe" "$run_dir" claude 4242 124 false
`)
  return normalizedObserve(dir)
}

const runTsStalled = (dir: string): unknown => {
  const { runDir, observe } = setupDir(dir)
  tsInitForSupersede(observe, runDir, ['req.json', 'res.json'])
  dispatchStart(observe, runDir, { backend: 'claude', dispatcherPid: 4242 })
  stallTimeout({
    observeFile: observe,
    runDir,
    backend: 'claude',
    childPid: 999_999,
    timeoutSeconds: 60,
    idleSeconds: 61,
    stdoutCapture: path.join(runDir, 'out.cap'),
    stderrCapture: path.join(runDir, 'err.cap'),
  })
  dispatchEnd(observe, runDir, {
    backend: 'claude',
    dispatcherPid: 4242,
    exitCode: 124,
    responsePresent: false,
  })
  return normalizedObserve(dir)
}

const refusalPaths = (
  dir: string
): { running: string; runningRun: string; other: string; otherRun: string } => {
  const running = path.join(dir, 'delegate_chore_20260101_000000_ccccc_observe.json')
  const other = path.join(dir, 'delegate_chore_20260101_000000_ddddd_observe.json')
  return {
    running,
    runningRun: running.replace(/_observe\.json$/, ''),
    other,
    otherRun: other.replace(/_observe\.json$/, ''),
  }
}

const runBashRefusal = (dir: string): [unknown, unknown] => {
  const paths = refusalPaths(dir)
  mkdirSync(paths.runningRun, { recursive: true })
  mkdirSync(paths.otherRun, { recursive: true })
  runBashOps(`
delegate_observe_init '${paths.running}' '${paths.runningRun}' chore haiku claude r s requester
delegate_observe_dispatch_start '${paths.running}' '${paths.runningRun}' claude 4242
delegate_observe_init '${paths.other}' '${paths.otherRun}' chore haiku claude r s other-requester
delegate_observe_mark_superseded '${paths.running}' requester newer_observe.json
delegate_observe_mark_superseded '${paths.other}' requester newer_observe.json
`)
  return [
    normalizedJson(JSON.parse(readFileSync(paths.running, 'utf8')), dir),
    normalizedJson(JSON.parse(readFileSync(paths.other, 'utf8')), dir),
  ]
}

const runTsRefusal = (dir: string): [unknown, unknown] => {
  const paths = refusalPaths(dir)
  mkdirSync(paths.runningRun, { recursive: true })
  mkdirSync(paths.otherRun, { recursive: true })
  tsInitForSupersede(paths.running, paths.runningRun, ['r', 's'])
  dispatchStart(paths.running, paths.runningRun, { backend: 'claude', dispatcherPid: 4242 })
  initObserve({
    observeFile: paths.other,
    runDir: paths.otherRun,
    taskType: 'chore',
    model: 'haiku',
    backend: 'claude',
    requestFile: 'r',
    responseFile: 's',
    requesterSessionId: 'other-requester',
  })
  markSuperseded(paths.running, 'requester', 'newer_observe.json')
  markSuperseded(paths.other, 'requester', 'newer_observe.json')
  return [
    normalizedJson(JSON.parse(readFileSync(paths.running, 'utf8')), dir),
    normalizedJson(JSON.parse(readFileSync(paths.other, 'utf8')), dir),
  ]
}

describe('observe store parity (bash vs TS)', () => {
  it('produces an identical observe JSON for the full dispatch lifecycle', () => {
    const bashDir = makeWorkDir()
    setupDir(bashDir)
    runBashOps(bashLifecycleScript(bashDir))
    const tsDir = makeWorkDir()
    const { runDir, observe } = setupDir(tsDir)
    for (const step of tsLifecycleSteps(runDir, observe)) {
      step()
    }
    expect(normalizedObserve(tsDir)).toEqual(normalizedObserve(bashDir))
  })

  it('falls back to estimated usage with a usage_parse_failed event identically', () => {
    const bashDir = makeWorkDir()
    setupDir(bashDir)
    runBashOps(estimatedUsageScript(bashDir))
    const tsDir = makeWorkDir()
    runTsEstimatedUsage(tsDir)
    expect(normalizedObserve(tsDir)).toEqual(normalizedObserve(bashDir))
  })

  it('records run_context and resume_unavailable identically', () => {
    const bashDir = makeWorkDir()
    setupDir(bashDir)
    runBashOps(runContextScript(bashDir))
    const tsDir = makeWorkDir()
    runTsRunContext(tsDir)
    expect(normalizedObserve(tsDir)).toEqual(normalizedObserve(bashDir))
  })

  it('supersedes stale prepared observes identically', () => {
    const bashDir = makeWorkDir()
    const bashOlder = runBashSupersede(bashDir)
    const tsDir = makeWorkDir()
    const tsOlder = runTsSupersede(tsDir)
    const bashDoc = normalizedJson(JSON.parse(readFileSync(bashOlder, 'utf8')), bashDir)
    const tsDoc = normalizedJson(JSON.parse(readFileSync(tsOlder, 'utf8')), tsDir)
    expect(tsDoc).toEqual(bashDoc)
  })

  it('appends dispatch metrics records identically', () => {
    expect(runTsMetrics(makeWorkDir())).toEqual(runBashMetrics(makeWorkDir()))
  })

  it('writes an identical failed response through the protocol builder', () => {
    expect(runTsFailedResponse(makeWorkDir())).toEqual(runBashFailedResponse(makeWorkDir()))
  })

  it('validates follow-up preconditions with identical messages', () => {
    const dir = makeWorkDir()
    const { observe } = setupDir(dir)
    runBashOps(`
run_dir="${dir}/run"
observe="$run_dir/run_observe.json"
delegate_observe_init "$observe" "$run_dir" chore gpt-5.5 codex req.json res.json requester
delegate_observe_backend_session_update "$observe" "$run_dir" codex gpt-5.5 thread-1 codex_json resumable ""
delegate_observe_run_context_update "$observe" "$run_dir" "${repoRoot}" "${repoRoot}"
`)
    const base: FollowupCase = {
      backend: 'codex',
      model: 'gpt-5.5',
      repo: repoRoot,
      worktree: repoRoot,
      file: observe,
    }
    expectFollowupParity(base)
    expectFollowupParity({ ...base, backend: 'claude' })
    expectFollowupParity({ ...base, model: 'gpt-5' })
    expectFollowupParity({ ...base, repo: dir })
    expectFollowupParity({ ...base, file: path.join(dir, 'missing.json') })
  })
})

describe('observe store parity guards (bash vs TS)', () => {
  it('keeps last_stream_change_at while streams do not grow, on both sides', () => {
    for (const viaBash of [false, true]) {
      const [first, second, third] = heartbeatValues(makeWorkDir(), viaBash)
      expect(second, `viaBash=${viaBash}`).toBe(first)
      expect(third, `viaBash=${viaBash}`).not.toBe(second)
    }
  })

  it('keeps the stalled phase through dispatch_end identically', () => {
    const tsDoc = runTsStalled(makeWorkDir())
    expect(tsDoc).toEqual(runBashStalled(makeWorkDir()))
    expect(JSON.stringify(tsDoc)).toContain('"phase":"stalled"')
  })

  it('refuses to supersede when the phase or requester does not match, identically', () => {
    const tsDocs = runTsRefusal(makeWorkDir())
    expect(tsDocs).toEqual(runBashRefusal(makeWorkDir()))
    expect(JSON.stringify(tsDocs)).not.toContain('superseded')
  })

  it('reaps a non-symlink legacy lock file before updating', () => {
    const dir = makeWorkDir()
    const { runDir, observe } = setupDir(dir)
    runBashOps(`
run_dir="${dir}/run"
observe="$run_dir/run_observe.json"
delegate_observe_init "$observe" "$run_dir" chore haiku claude req.json res.json requester
`)
    writeFileSync(path.join(runDir, 'run_observe.lock'), 'legacy flock file')
    appendObserveEvent(observe, runDir, {
      kind: 'ts_after_legacy_reap',
      ts: '2026-01-01T00:00:00Z',
    })
    expect(readFileSync(observe, 'utf8')).toContain('ts_after_legacy_reap')
  })

  it('interoperates with the bash symlink lock protocol', () => {
    const dir = makeWorkDir()
    const { runDir, observe } = setupDir(dir)
    runBashOps(`
run_dir="${dir}/run"
observe="$run_dir/run_observe.json"
delegate_observe_init "$observe" "$run_dir" chore haiku claude req.json res.json requester
`)
    // 死んだ pid の bash 形式 lock を TS 側が回収して更新を通せる
    symlinkSync('999999 stale-token', path.join(runDir, 'run_observe.lock'))
    appendObserveEvent(observe, runDir, { kind: 'ts_after_reap', ts: '2026-01-01T00:00:00Z' })
    const doc: unknown = JSON.parse(readFileSync(observe, 'utf8'))
    const events = getPath(doc, ['events'])
    expect(Array.isArray(events)).toBe(true)
    expect(JSON.stringify(events)).toContain('ts_after_reap')
  })
})
