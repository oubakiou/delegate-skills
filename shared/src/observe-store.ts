import { execFileSync } from 'node:child_process'
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPath, isRecord, jqCoalesce } from './jq-compat.ts'
import { withObserveLock } from './observe-lock.ts'
import {
  augmentCostEstimate,
  loadPriceTable,
  resolvePricesFile,
  type PriceTable,
} from './observe-cost.ts'
import { estimatedUsage } from './observe-usage.ts'
import { timingStreamCounts } from './observe-timing.ts'
import { appendMetrics, metricsTimestamp, randomToken } from './protocol.ts'

// bash 版 observe-json.sh の mutate 系関数と同一契約
// (等価性は scripts/observe-store-parity.test.ts が bash 実装との突き合わせで検証する)。

export type Env = Readonly<Partial<Record<string, string>>>

type ObserveDoc = Record<string, unknown>

const utcTimestamp = metricsTimestamp

const readObserveDoc = (observeFile: string): ObserveDoc => {
  const parsed: unknown = JSON.parse(readFileSync(observeFile, 'utf8'))
  if (!isRecord(parsed)) {
    throw new Error(`observe JSON is not an object: ${observeFile}`)
  }
  return parsed
}

// bash 版と同じく tmp ファイル + rename の原子的置換。init 以外は jq 既定の
// pretty 出力 (2-space indent + 改行) と同形にする
const writeObserveDoc = (observeFile: string, runDir: string, doc: ObserveDoc): void => {
  const base = path.basename(observeFile).replace(/\.json$/, '')
  const tmp = path.join(runDir, `${base}_upd_${randomToken(5)}.json`)
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, observeFile)
}

const updateObserve = (
  observeFile: string,
  runDir: string,
  mutate: (doc: ObserveDoc) => void
): void => {
  withObserveLock(observeFile, runDir, () => {
    const doc = readObserveDoc(observeFile)
    mutate(doc)
    writeObserveDoc(observeFile, runDir, doc)
  })
}

// mutate が false を返した場合は書き込まない条件付き更新。no-op でも rename して
// mtime を進めてしまうと supersede の mtime 比較が壊れる箇所（markSuperseded）で使う
const updateObserveConditional = (
  observeFile: string,
  runDir: string,
  mutate: (doc: ObserveDoc) => boolean
): void => {
  withObserveLock(observeFile, runDir, () => {
    const doc = readObserveDoc(observeFile)
    if (mutate(doc)) {
      writeObserveDoc(observeFile, runDir, doc)
    }
  })
}

const sectionOf = (doc: ObserveDoc, key: string): ObserveDoc => {
  const value: unknown = doc[key]
  if (isRecord(value)) {
    return value
  }
  const fresh: ObserveDoc = {}
  doc[key] = fresh
  return fresh
}

const eventsOf = (doc: ObserveDoc): unknown[] => {
  if (Array.isArray(doc.events)) {
    return doc.events
  }
  const fresh: unknown[] = []
  doc.events = fresh
  return fresh
}

const stringOrEmpty = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  return ''
}

const nullIfEmpty = (value: string): string | null => {
  if (value === '') {
    return null
  }
  return value
}

export interface ObserveInitInput {
  observeFile: string
  runDir: string
  taskType: string
  model: string
  backend: string
  requestFile: string
  responseFile: string
  requesterSessionId: string
  modelSource?: string
}

export const initObserve = (input: ObserveInitInput): void => {
  const now = utcTimestamp()
  const run: ObserveDoc = {
    task_type: input.taskType,
    model: input.model,
    backend: input.backend,
    request_file: input.requestFile,
    response_file: input.responseFile,
    run_dir: input.runDir,
    requester_session_id: input.requesterSessionId,
  }
  if (typeof input.modelSource === 'string' && input.modelSource !== '') {
    run.model_source = input.modelSource
  }
  const doc: ObserveDoc = {
    schema_version: 1,
    run,
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
      ts: now,
      backend: input.backend,
      child_pid: null,
      stdout_bytes: 0,
      stderr_bytes: 0,
      last_stream_change_at: now,
    },
    events: [
      {
        kind: 'run_created',
        ts: now,
        run_dir: input.runDir,
        request_file: input.requestFile,
        response_file: input.responseFile,
      },
    ],
    streams: {
      stdout: { bytes: 0, truncated: false, content: '' },
      stderr: { bytes: 0, truncated: false, content: '' },
    },
  }
  withObserveLock(input.observeFile, input.runDir, () => {
    // bash 版 init は jq -cn の compact 出力
    const base = path.basename(input.observeFile).replace(/\.json$/, '')
    const tmp = path.join(input.runDir, `${base}_init_${randomToken(5)}.json`)
    writeFileSync(tmp, `${JSON.stringify(doc)}\n`, { mode: 0o600 })
    renameSync(tmp, input.observeFile)
  })
}

export const appendObserveEvent = (
  observeFile: string,
  runDir: string,
  event: Record<string, unknown>
): void => {
  updateObserve(observeFile, runDir, (doc) => {
    eventsOf(doc).push(event)
  })
}

export const usageParseFailed = (
  observeFile: string,
  runDir: string,
  detail: { backend: string; source: string; message: string }
): void => {
  appendObserveEvent(observeFile, runDir, {
    kind: 'usage_parse_failed',
    ts: utcTimestamp(),
    backend: detail.backend,
    source: detail.source,
    message: detail.message,
  })
}

export const updateUsage = (
  observeFile: string,
  runDir: string,
  usage: Record<string, unknown>
): void => {
  updateObserve(observeFile, runDir, (doc) => {
    doc.usage = usage
  })
}

export const updateMcpConfig = (
  observeFile: string,
  runDir: string,
  config: { source: string; servers: unknown }
): void => {
  let servers: string[] = []
  if (Array.isArray(config.servers)) {
    servers = config.servers.map(String)
  }
  updateObserve(observeFile, runDir, (doc) => {
    doc.mcp_config = { source: config.source, servers }
  })
}

export const updateLineage = (
  observeFile: string,
  runDir: string,
  lineage: { lineageId: string; followupOf?: string }
): void => {
  updateObserve(observeFile, runDir, (doc) => {
    doc.lineage = {
      lineage_id: lineage.lineageId,
      followup_of: nullIfEmpty(lineage.followupOf ?? ''),
    }
  })
}

export interface BackendSessionInput {
  backend: string
  model: string
  resumeId: string
  resumeSource: string
  persistence: string
  homeDir?: string
}

export const updateBackendSession = (
  observeFile: string,
  runDir: string,
  session: BackendSessionInput
): void => {
  updateObserve(observeFile, runDir, (doc) => {
    doc.backend_session = {
      backend: session.backend,
      model: session.model,
      resume_id: nullIfEmpty(session.resumeId),
      resume_source: nullIfEmpty(session.resumeSource),
      persistence: session.persistence,
      home_dir: nullIfEmpty(session.homeDir ?? ''),
    }
  })
}

export const resumeUnavailable = (
  observeFile: string,
  runDir: string,
  detail: { backend: string; model: string; reason: string; homeDir?: string }
): void => {
  updateBackendSession(observeFile, runDir, {
    backend: detail.backend,
    model: detail.model,
    resumeId: '',
    resumeSource: '',
    persistence: 'unavailable',
    homeDir: detail.homeDir ?? '',
  })
  appendObserveEvent(observeFile, runDir, {
    kind: 'resume_unavailable',
    ts: utcTimestamp(),
    backend: detail.backend,
    model: detail.model,
    reason: detail.reason,
  })
}

const gitOutput = (worktree: string, args: string[]): string =>
  execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8' }).trimEnd()

const gitQuietFails = (worktree: string, args: string[]): boolean => {
  try {
    execFileSync('git', ['-C', worktree, ...args], { stdio: 'ignore' })
    return false
  } catch {
    return true
  }
}

const gitBranchOrEmpty = (worktree: string): string => {
  try {
    return gitOutput(worktree, ['branch', '--show-current'])
  } catch {
    return ''
  }
}

export const updateRunContext = (
  observeFile: string,
  runDir: string,
  roots: { repoRoot: string; worktreeRoot: string }
): void => {
  const repoReal = realpathSync(roots.repoRoot)
  const worktreeReal = realpathSync(roots.worktreeRoot)
  const gitHead = gitOutput(worktreeReal, ['rev-parse', 'HEAD'])
  const gitBranch = gitBranchOrEmpty(worktreeReal)
  const dirty =
    gitQuietFails(worktreeReal, ['diff', '--quiet', '--ignore-submodules', '--']) ||
    gitQuietFails(worktreeReal, ['diff', '--cached', '--quiet', '--ignore-submodules', '--'])
  updateObserve(observeFile, runDir, (doc) => {
    doc.run_context = {
      repo_root: repoReal,
      worktree_root: worktreeReal,
      git_head: gitHead,
      git_branch: nullIfEmpty(gitBranch),
      dirty,
    }
  })
}

export const recordEffort = (
  observeFile: string,
  runDir: string,
  effort: { requested: string; effective?: Record<string, unknown> | null }
): void => {
  const effective = effort.effective ?? { value: null, source: 'not_exposed' }
  updateObserve(observeFile, runDir, (doc) => {
    sectionOf(doc, 'run').effort = {
      requested: nullIfEmpty(effort.requested),
      effective,
    }
  })
  // 宣言が CLI に効いていない事故の検出。判定は measured の場合のみ可能
  const effectiveValue = stringOrEmpty(jqCoalesce(effective.value))
  if (
    effort.requested !== '' &&
    effective.source === 'measured' &&
    effectiveValue !== '' &&
    effectiveValue !== effort.requested
  ) {
    appendObserveEvent(observeFile, runDir, {
      kind: 'effort_mismatch',
      ts: utcTimestamp(),
      requested: effort.requested,
      effective: effectiveValue,
    })
  }
}

export interface RecordUsageInput {
  observeFile: string
  runDir: string
  backend: string
  model: string
  requestFile: string
  responseFile: string
  source: string
  measured?: Record<string, unknown> | null
  pricesTable?: PriceTable | null
}

const defaultPriceTable = (): PriceTable | null => {
  // new URL(...).pathname は空白・非 ASCII を percent-encode するため、そのままだと
  // そういう install path で価格表を見失う。fileURLToPath で正しい OS パスに戻す
  const libDir = path.dirname(fileURLToPath(import.meta.url))
  const pricesFile = resolvePricesFile(libDir)
  if (pricesFile === null) {
    return null
  }
  return loadPriceTable(pricesFile)
}

export const recordUsage = (input: RecordUsageInput): void => {
  let usage = input.measured ?? null
  if (usage === null) {
    usageParseFailed(input.observeFile, input.runDir, {
      backend: input.backend,
      source: input.source,
      message: 'measured usage was not available',
    })
    usage = estimatedUsage({
      requestFile: input.requestFile,
      responseFile: input.responseFile,
      model: input.model,
      backend: input.backend,
      source: 'chars_4',
    })
  }
  const table = input.pricesTable ?? defaultPriceTable()
  usage = augmentCostEstimate(usage, input.backend, table)
  updateUsage(input.observeFile, input.runDir, usage)
}

export const markSuperseded = (
  observeFile: string,
  requester: string,
  supersededBy: string
): void => {
  // run_dir が無い候補は retention で削除済み。lock/tmp 作成で復活させないため触らない
  const runDir = observeFile.replace(/_observe\.json$/, '')
  if (!existsSync(runDir)) {
    return
  }
  updateObserveConditional(observeFile, runDir, (doc) => {
    // phase 不一致 / requester 不一致は no-op。書き込まず mtime を進めない
    // （進めると別 requester の no-op が候補を新 run より新しく見せ、正しい
    //   requester の後続 dispatch が stale 判定できず prepared のまま残る）
    if (getPath(doc, ['state', 'phase']) !== 'prepared') {
      return false
    }
    if ((getPath(doc, ['run', 'requester_session_id']) ?? '') !== requester) {
      return false
    }
    sectionOf(doc, 'state').phase = 'superseded'
    eventsOf(doc).push({ kind: 'superseded', ts: utcTimestamp(), superseded_by: supersededBy })
    return true
  })
}

const mtimeOrNull = (file: string): number | null => {
  try {
    return statSync(file).mtimeMs
  } catch {
    return null
  }
}

// dispatch 時に同一 WORK_DIR / task_type / requester の古い prepared observe へ
// superseded マークを付ける (詳細な背景は bash 版のコメント参照)
const requesterOf = (observeFile: string): string => {
  try {
    return stringOrEmpty(getPath(readObserveDoc(observeFile), ['run', 'requester_session_id']))
  } catch {
    return ''
  }
}

const markSuersededQuietly = (candidate: string, requester: string, currentBase: string): void => {
  try {
    markSuperseded(candidate, requester, currentBase)
  } catch {
    // bash 版の `|| true` と同じく候補単位で握りつぶす
  }
}

export const supersedeStalePrepared = (observeFile: string, taskType: string): void => {
  const workDir = path.dirname(observeFile)
  const currentBase = path.basename(observeFile)
  const requester = requesterOf(observeFile)
  const currentMtime = mtimeOrNull(observeFile)
  for (const name of readdirSync(workDir)) {
    const candidateMtime = mtimeOrNull(path.join(workDir, name))
    const isTarget =
      name.startsWith(`delegate_${taskType}_`) &&
      name.endsWith('_observe.json') &&
      name !== currentBase &&
      candidateMtime !== null &&
      currentMtime !== null &&
      candidateMtime < currentMtime
    if (isTarget) {
      markSuersededQuietly(path.join(workDir, name), requester, currentBase)
    }
  }
}

export const dispatchStart = (
  observeFile: string,
  runDir: string,
  detail: { backend: string; dispatcherPid: number }
): void => {
  const now = utcTimestamp()
  updateObserve(observeFile, runDir, (doc) => {
    Object.assign(sectionOf(doc, 'state'), {
      phase: 'running',
      dispatcher_pid: detail.dispatcherPid,
      started_at: now,
      ended_at: null,
      exit_code: null,
      duration_ms: null,
      response_present: false,
    })
    const heartbeatDoc = sectionOf(doc, 'heartbeat')
    Object.assign(heartbeatDoc, {
      ts: now,
      backend: detail.backend,
      child_pid: null,
      last_stream_change_at: jqCoalesce(heartbeatDoc.last_stream_change_at) ?? now,
    })
    eventsOf(doc).push({
      kind: 'dispatch_start',
      ts: now,
      backend: detail.backend,
      dispatcher_pid: detail.dispatcherPid,
    })
  })
}

export const captureBytes = (captureFile: string): number => {
  try {
    return statSync(captureFile).size
  } catch {
    return 0
  }
}

export const heartbeat = (
  observeFile: string,
  runDir: string,
  detail: { backend: string; childPid: number; stdoutCapture: string; stderrCapture: string }
): void => {
  const now = utcTimestamp()
  const stdoutBytes = captureBytes(detail.stdoutCapture)
  const stderrBytes = captureBytes(detail.stderrCapture)
  updateObserve(observeFile, runDir, (doc) => {
    const heartbeatDoc = sectionOf(doc, 'heartbeat')
    const prevStdout = Number(jqCoalesce(heartbeatDoc.stdout_bytes) ?? 0)
    const prevStderr = Number(jqCoalesce(heartbeatDoc.stderr_bytes) ?? 0)
    let lastChange = stringOrEmpty(jqCoalesce(heartbeatDoc.last_stream_change_at))
    if (stdoutBytes > prevStdout || stderrBytes > prevStderr || lastChange === '') {
      lastChange = now
    }
    Object.assign(heartbeatDoc, {
      ts: now,
      backend: detail.backend,
      child_pid: detail.childPid,
      stdout_bytes: stdoutBytes,
      stderr_bytes: stderrBytes,
      last_stream_change_at: lastChange,
    })
  })
}

const epochSeconds = (timestamp: string): number => {
  if (timestamp === '') {
    return 0
  }
  const parsed = Date.parse(timestamp)
  if (Number.isNaN(parsed)) {
    return 0
  }
  return Math.floor(parsed / 1000)
}

export const dispatchEnd = (
  observeFile: string,
  runDir: string,
  detail: { backend: string; dispatcherPid: number; exitCode: number; responsePresent: boolean }
): void => {
  const endedAt = utcTimestamp()
  updateObserve(observeFile, runDir, (doc) => {
    const state = sectionOf(doc, 'state')
    const startedAt = stringOrEmpty(jqCoalesce(state.started_at))
    let durationMs = 0
    if (startedAt !== '') {
      durationMs = (epochSeconds(endedAt) - epochSeconds(startedAt)) * 1000
    }
    if (state.phase !== 'stalled') {
      state.phase = 'ended'
    }
    Object.assign(state, {
      dispatcher_pid: detail.dispatcherPid,
      ended_at: endedAt,
      exit_code: detail.exitCode,
      duration_ms: durationMs,
      response_present: detail.responsePresent,
    })
    Object.assign(sectionOf(doc, 'heartbeat'), { ts: endedAt, backend: detail.backend })
    eventsOf(doc).push({
      kind: 'dispatch_end',
      ts: endedAt,
      backend: detail.backend,
      dispatcher_pid: detail.dispatcherPid,
      exit_code: detail.exitCode,
    })
  })
}

export const responseMissing = (observeFile: string, runDir: string): void => {
  appendObserveEvent(observeFile, runDir, { kind: 'response_missing', ts: utcTimestamp() })
}

export const failedResponseWritten = (observeFile: string, runDir: string): void => {
  appendObserveEvent(observeFile, runDir, { kind: 'failed_response_written', ts: utcTimestamp() })
}

export interface StallTimeoutInput {
  observeFile: string
  runDir: string
  backend: string
  childPid: number
  timeoutSeconds: number
  idleSeconds: number
  stdoutCapture: string
  stderrCapture: string
  processTree?: unknown[]
}

export const stallTimeout = (input: StallTimeoutInput): void => {
  const now = utcTimestamp()
  const stdoutBytes = captureBytes(input.stdoutCapture)
  const stderrBytes = captureBytes(input.stderrCapture)
  updateObserve(input.observeFile, input.runDir, (doc) => {
    sectionOf(doc, 'state').phase = 'stalled'
    const heartbeatDoc = sectionOf(doc, 'heartbeat')
    heartbeatDoc.ts = now
    heartbeatDoc.backend = input.backend
    heartbeatDoc.child_pid = input.childPid
    heartbeatDoc.stdout_bytes = stdoutBytes
    heartbeatDoc.stderr_bytes = stderrBytes
    eventsOf(doc).push({
      kind: 'stall_timeout',
      ts: now,
      backend: input.backend,
      child_pid: input.childPid,
      timeout_seconds: input.timeoutSeconds,
      idle_seconds: input.idleSeconds,
      stdout_bytes: stdoutBytes,
      stderr_bytes: stderrBytes,
      process_tree: input.processTree ?? [],
    })
  })
}

export interface RecordTimingInput {
  observeFile: string
  runDir: string
  backend: string
  stdoutCapture: string
  totalMs: number | null
  firstUsefulMs: number | null
  reportReadyMs: number | null
  devinExport?: string
  structuredOutputParse?: boolean | null
}

export const recordTiming = (input: RecordTimingInput): void => {
  const counts = timingStreamCounts({
    backend: input.backend,
    stdoutCapture: input.stdoutCapture,
    devinExport: input.devinExport ?? '',
  })
  const timing = {
    total_ms: input.totalMs,
    time_to_first_useful_event_ms: input.firstUsefulMs,
    report_ready_at_ms: input.reportReadyMs,
    model_turns: counts.model_turns,
    tool_calls: counts.tool_calls,
    structured_output_parse: input.structuredOutputParse ?? null,
    measurement_source: counts.source,
  }
  updateObserve(input.observeFile, input.runDir, (doc) => {
    doc.timing = timing
  })
}

const streamCapBytes = (env: Env): number => {
  const value = env.DELEGATE_OBSERVE_STREAM_MAX_BYTES ?? ''
  if (!/^[0-9]+$/.test(value)) {
    return 65_536
  }
  return Number(value)
}

// 上限超過時は tail (末尾) を残す
const readBufferOrNull = (file: string): Buffer | null => {
  try {
    return readFileSync(file)
  } catch {
    return null
  }
}

const cappedCaptureContent = (captureFile: string, maxBytes: number): string => {
  const content = readBufferOrNull(captureFile)
  if (content === null) {
    return ''
  }
  if (maxBytes !== 0 && content.length > maxBytes) {
    return content.subarray(content.length - maxBytes).toString('utf8')
  }
  return content.toString('utf8')
}

export const importStreams = (
  observeFile: string,
  runDir: string,
  captures: { stdoutCapture: string; stderrCapture: string; env?: Env }
): void => {
  const maxBytes = streamCapBytes(captures.env ?? process.env)
  const stdoutBytes = captureBytes(captures.stdoutCapture)
  const stderrBytes = captureBytes(captures.stderrCapture)
  const stdoutContent = cappedCaptureContent(captures.stdoutCapture, maxBytes)
  const stderrContent = cappedCaptureContent(captures.stderrCapture, maxBytes)
  updateObserve(observeFile, runDir, (doc) => {
    const streams = sectionOf(doc, 'streams')
    streams.stdout = {
      bytes: stdoutBytes,
      truncated: maxBytes !== 0 && stdoutBytes > maxBytes,
      content: stdoutContent,
    }
    streams.stderr = {
      bytes: stderrBytes,
      truncated: maxBytes !== 0 && stderrBytes > maxBytes,
      content: stderrContent,
    }
  })
}

export interface DispatchMetricsInput {
  observeFile: string
  taskType: string
  model: string
  backend: string
  durationMs: number | null
  exitCode: number
  responsePresent: boolean
  responseFile?: string
}

export const appendDispatchMetrics = (
  input: DispatchMetricsInput,
  env: Env = process.env
): void => {
  const metricsFile = env.DELEGATE_METRICS_FILE ?? ''
  if (metricsFile === '') {
    return
  }
  let timing: unknown = {}
  try {
    timing = jqCoalesce(getPath(readObserveDoc(input.observeFile), ['timing'])) ?? {}
  } catch {
    timing = {}
  }
  const record = {
    kind: 'dispatch',
    ts: utcTimestamp(),
    task_type: input.taskType,
    model: input.model,
    backend: input.backend,
    duration_ms: input.durationMs,
    exit_code: input.exitCode,
    response_present: input.responsePresent,
    model_turns: jqCoalesce(getPath(timing, ['model_turns'])),
    tool_calls: jqCoalesce(getPath(timing, ['tool_calls'])),
    time_to_first_useful_event_ms: jqCoalesce(getPath(timing, ['time_to_first_useful_event_ms'])),
    report_ready_at_ms: jqCoalesce(getPath(timing, ['report_ready_at_ms'])),
    structured_output_parse: jqCoalesce(getPath(timing, ['structured_output_parse'])),
    measurement_source: jqCoalesce(getPath(timing, ['measurement_source'])) ?? 'unavailable',
    observe_file: input.observeFile,
    response_file: nullIfEmpty(input.responseFile ?? ''),
  }
  appendMetrics(metricsFile, record)
}

// parity テスト（Step 8 で削除）が担保していた mutate 系 lifecycle 契約を、bash 非依存の
// in-source test として保持する（end-to-end は fake CLI golden）。
const observeDocOf = (observeFile: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(readFileSync(observeFile, 'utf8'))
  if (!isRecord(parsed)) {
    throw new Error('observe json is not an object')
  }
  return parsed
}

const observeEventKinds = (doc: Record<string, unknown>): unknown[] => {
  const { events } = doc
  if (!Array.isArray(events)) {
    return []
  }
  return events.map((event) => {
    if (isRecord(event)) {
      return event.kind
    }
    return null
  })
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  const { mkdirSync, utimesSync } = await import('node:fs')

  const initFixture = (): { observeFile: string; runDir: string } => {
    const dir = `.temp/observe-store-test-${randomToken(8)}`
    const runDir = path.join(dir, 'delegate_chore_run')
    mkdirSync(runDir, { recursive: true })
    const run = { observeFile: path.join(dir, 'delegate_chore_run_observe.json'), runDir }
    initObserve({
      observeFile: run.observeFile,
      runDir: run.runDir,
      taskType: 'chore',
      model: 'haiku',
      backend: 'claude',
      requestFile: `${run.runDir}_req.json`,
      responseFile: `${run.runDir}_res.json`,
      requesterSessionId: 'sid-1',
      modelSource: 'default',
    })
    return run
  }

  describe('initObserve', () => {
    it('writes the prepared skeleton with run / state / heartbeat / streams', () => {
      const run = initFixture()
      const doc = observeDocOf(run.observeFile)
      expect(doc).toMatchObject({
        schema_version: 1,
        run: { task_type: 'chore', model: 'haiku', backend: 'claude', model_source: 'default' },
        state: { phase: 'prepared', dispatcher_pid: null, response_present: false },
      })
      expect(observeEventKinds(doc)[0]).toBe('run_created')
    })
  })

  describe('dispatch lifecycle', () => {
    it('moves prepared → running → ended and records exit_code + response_present', () => {
      const run = initFixture()
      dispatchStart(run.observeFile, run.runDir, { backend: 'claude', dispatcherPid: 4242 })
      expect(observeDocOf(run.observeFile)).toMatchObject({
        state: { phase: 'running', dispatcher_pid: 4242 },
      })
      dispatchEnd(run.observeFile, run.runDir, {
        backend: 'claude',
        dispatcherPid: 4242,
        exitCode: 0,
        responsePresent: true,
      })
      const doc = observeDocOf(run.observeFile)
      expect(doc).toMatchObject({ state: { phase: 'ended', exit_code: 0, response_present: true } })
      expect(observeEventKinds(doc)).toEqual(['run_created', 'dispatch_start', 'dispatch_end'])
    })

    it('records response_missing and failed_response_written events', () => {
      const run = initFixture()
      responseMissing(run.observeFile, run.runDir)
      failedResponseWritten(run.observeFile, run.runDir)
      const kinds = observeEventKinds(observeDocOf(run.observeFile))
      expect(kinds).toContain('response_missing')
      expect(kinds).toContain('failed_response_written')
    })
  })

  const makeAgedStalePrepared = (workDir: string): string => {
    const staleRunDir = path.join(workDir, 'delegate_chore_stale')
    mkdirSync(staleRunDir, { recursive: true })
    const staleObserve = path.join(workDir, 'delegate_chore_stale_observe.json')
    initObserve({
      observeFile: staleObserve,
      runDir: staleRunDir,
      taskType: 'chore',
      model: 'haiku',
      backend: 'claude',
      requestFile: 'r',
      responseFile: 'r',
      requesterSessionId: 'sid-1',
    })
    const past = new Date(Date.now() - 60_000)
    utimesSync(staleObserve, past, past)
    return staleObserve
  }

  describe('supersedeStalePrepared', () => {
    it('marks an older prepared observe of the same task_type as superseded', () => {
      const current = initFixture()
      const staleObserve = makeAgedStalePrepared(path.dirname(current.observeFile))
      supersedeStalePrepared(current.observeFile, 'chore')
      expect(getPath(observeDocOf(staleObserve), ['state', 'phase'])).toBe('superseded')
      // 自身は superseded にならない
      expect(getPath(observeDocOf(current.observeFile), ['state', 'phase'])).toBe('prepared')
    })

    it('does not rewrite an mtime on a requester-mismatch no-op', () => {
      // 別 requester の supersede が候補に触れても書き込まず mtime を進めない（進めると
      // 正しい requester の後続 dispatch が候補を stale 判定できなくなる）
      const current = initFixture()
      const candidate = makeAgedStalePrepared(path.dirname(current.observeFile))
      const before = statSync(candidate).mtimeMs
      markSuperseded(candidate, 'different-requester', path.basename(current.observeFile))
      expect(getPath(observeDocOf(candidate), ['state', 'phase'])).toBe('prepared')
      expect(statSync(candidate).mtimeMs).toBe(before)
    })
  })
}
