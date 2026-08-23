import { spawnSync } from 'node:child_process'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Env } from './build-request.ts'
import type { CliResult } from './cli-result.ts'
import { sanitizeFailureModel, type ChildFailure } from './failure-classify.ts'
import { isRecord, parseJsonLine } from './jq-compat.ts'
import {
  effortFromOpencodeExport,
  OPENCODE_EFFORT_UNSUPPORTED_WARNING,
  opencodeVariantsInclude,
  type EffectiveEffort,
} from './observe-effort.ts'
import {
  appendObserveEvent,
  recordChildFailure,
  recordEffort,
  recordUsage,
} from './observe-store.ts'
import {
  OPENCODE_CAPTURE_MAX_BYTES,
  OPENCODE_CAPTURE_MAX_LINE_BYTES,
  estimatedUsage,
  summarizeOpencodeCapture,
  usageFromOpencodeCapture,
} from './observe-usage.ts'
import { metricsTimestamp } from './protocol.ts'
import { promptConstraints } from './prompt-constraints.ts'
import {
  completeResponse,
  effortFailure,
  finishWithoutChild,
  finalizeResponse,
  makeWrapperContext,
  parseWrapperArgs,
  quietly,
  readTailBytes,
  recordFollowupOutcome,
  recordResumableOutcome,
  responderSessionIdOf,
  STDERR_TAIL_MAX_BYTES,
  workerPrompt,
  wrapperResult,
  writePromptFile,
  type WrapperContext,
} from './wrapper-common.ts'
import {
  buildResponseFromStdoutText,
  reportModeForBackend,
  requestPromptStep,
  requestInlineMax,
  type RequestPromptStep,
} from './wrapper-report.ts'
import {
  executablePaths,
  spawnWorker,
  waitWithHeartbeat,
  type SpawnedWorker,
  type WaitResult,
} from './wrapper-wait.ts'

const OPENCODE_SELECTOR = 'opencode/'
const OPENCODE_VERSION_TIMEOUT_MS = 10_000
const OPENCODE_VERSION_MAX_BYTES = 16_384
const OPENCODE_AUX_TIMEOUT_MS = 10_000
const OPENCODE_MODELS_MAX_BYTES = 256 * 1024
const OPENCODE_EXPORT_MAX_BYTES = 2 * 1024 * 1024
const OPENCODE_SESSION_DELETE_TIMEOUT_MS = 2000
const OPENCODE_SESSION_DELETE_MAX_BYTES = 16_384
const OPENCODE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const OPENCODE_SESSION_EVENT_TYPES = new Set([
  'step_start',
  'text',
  'tool_use',
  'step_finish',
  'error',
])
const OPENCODE_IDENTITY_READ_BYTES = 64 * 1024
const PURE_TASK_TYPES = new Set(['explore', 'review', 'htmldoc'])

export interface OpencodeCatalogModel {
  id: string
  variants: Record<string, unknown>
}

export type OpencodeCatalogLookup =
  | { ok: true; models: ReadonlyMap<string, OpencodeCatalogModel> }
  | { ok: false }

interface CatalogParseState {
  pending: string
  awaitingBlock: boolean
  models: Map<string, OpencodeCatalogModel>
}

interface OpencodeAuxLimits {
  timeoutMs: number
  maxBytes: number
}

const catalogParseState = (): CatalogParseState => ({
  pending: '',
  awaitingBlock: false,
  models: new Map(),
})

const tryParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const catalogModelOf = (value: unknown): OpencodeCatalogModel | null => {
  if (!isRecord(value) || !isRecord(value.variants)) {
    return null
  }
  if (typeof value.id !== 'string' || typeof value.providerID !== 'string') {
    return null
  }
  const id = sanitizeFailureModel(`${value.providerID}/${value.id}`)
  if (id === null) {
    return null
  }
  return { id, variants: value.variants }
}

const finishCatalogBlock = (state: CatalogParseState): boolean => {
  const parsed = tryParseJson(state.pending)
  if (parsed === null) {
    return true
  }
  const model = catalogModelOf(parsed)
  if (model === null) {
    return false
  }
  state.models.set(model.id, model)
  state.pending = ''
  state.awaitingBlock = false
  return true
}

const startCatalogJson = (line: string, state: CatalogParseState): boolean => {
  state.pending = line
  return finishCatalogBlock(state)
}

const consumeCatalogHeading = (state: CatalogParseState): boolean => {
  if (state.awaitingBlock) {
    return false
  }
  state.awaitingBlock = true
  return true
}

const consumeCatalogJsonStart = (line: string, state: CatalogParseState): boolean => {
  if (!state.awaitingBlock) {
    return false
  }
  state.awaitingBlock = false
  return startCatalogJson(line, state)
}

const consumeCatalogStart = (trimmed: string, line: string, state: CatalogParseState): boolean => {
  if (trimmed === '') {
    return true
  }
  if (trimmed.startsWith('{')) {
    return consumeCatalogJsonStart(line, state)
  }
  return consumeCatalogHeading(state)
}

const consumeCatalogLine = (line: string, state: CatalogParseState): boolean => {
  if (state.pending === '') {
    return consumeCatalogStart(line.trim(), line, state)
  }
  state.pending = `${state.pending}\n${line}`
  return finishCatalogBlock(state)
}

export const parseOpencodeModelsVerbose = (stdout: string): OpencodeCatalogLookup => {
  const state = catalogParseState()
  for (const line of stdout.split('\n')) {
    if (!consumeCatalogLine(line, state)) {
      return { ok: false }
    }
  }
  if (state.pending !== '' || state.awaitingBlock || state.models.size === 0) {
    return { ok: false }
  }
  return { ok: true, models: state.models }
}

const classifyOpencodeCatalogFailure = (
  model: string,
  catalog: OpencodeCatalogLookup
): ChildFailure => {
  if (!catalog.ok) {
    return { kind: 'model_catalog_unavailable', retryable: true, model }
  }
  if (!catalog.models.has(model)) {
    return { kind: 'model_catalog_miss', retryable: true, model }
  }
  return { kind: 'unknown' }
}

export const classifyOpencodeChildFailure = (input: {
  exitCode: number
  stdoutTail: string
  requestedModel: string
  catalog: OpencodeCatalogLookup
}): ChildFailure => {
  if (input.exitCode === 0) {
    return { kind: 'unknown' }
  }
  const model = sanitizeFailureModel(input.requestedModel)
  if (model === null) {
    return { kind: 'unknown' }
  }
  return classifyOpencodeCatalogFailure(model, input.catalog)
}

const auxLimitsOf = (
  limits: Partial<OpencodeAuxLimits>,
  fallback: OpencodeAuxLimits
): OpencodeAuxLimits => {
  const resolved: OpencodeAuxLimits = { ...fallback }
  if (typeof limits.timeoutMs === 'number') {
    resolved.timeoutMs = limits.timeoutMs
  }
  if (typeof limits.maxBytes === 'number') {
    resolved.maxBytes = limits.maxBytes
  }
  return resolved
}

interface OpencodeAuxOptions extends Partial<OpencodeAuxLimits> {
  cwd?: string
  pure?: boolean
}

interface OpencodeAuxResult {
  ok: boolean
  stdout: string
  stdoutBytes: number
  timedOut: boolean
}

const auxSpawnTimedOut = (error: Error | undefined): boolean =>
  typeof error !== 'undefined' && 'code' in error && error.code === 'ETIMEDOUT'

const auxSpawnFailed = (result: {
  error?: Error | undefined
  status: number | null
  signal: NodeJS.Signals | null
}): boolean => Boolean(result.error) || result.status !== 0 || result.signal !== null

const opencodeAuxArgs = (args: readonly string[], pure: boolean): string[] => {
  if (pure) {
    return [...args, '--pure']
  }
  return [...args]
}

const runOpencodeAux = (input: {
  command: string
  args: readonly string[]
  env: Env
  cwd?: string
  limits: OpencodeAuxLimits
}): OpencodeAuxResult => {
  const result = spawnSync(input.command, [...input.args], {
    encoding: 'utf8',
    env: { ...input.env },
    cwd: input.cwd,
    killSignal: 'SIGKILL',
    maxBuffer: input.limits.maxBytes,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: input.limits.timeoutMs,
  })
  const stdout = result.stdout ?? ''
  const stdoutBytes = Buffer.byteLength(stdout)
  const timedOut = auxSpawnTimedOut(result.error)
  if (auxSpawnFailed(result)) {
    return { ok: false, stdout: '', stdoutBytes: 0, timedOut }
  }
  return { ok: true, stdout, stdoutBytes, timedOut: false }
}

const auxResultAuthoritative = (result: OpencodeAuxResult, maxBytes: number): boolean =>
  result.ok && result.stdoutBytes < maxBytes

export const fetchOpencodeCatalog = (
  command: string,
  env: Env,
  options: OpencodeAuxOptions = {}
): OpencodeCatalogLookup => {
  const limits = auxLimitsOf(options, {
    timeoutMs: OPENCODE_AUX_TIMEOUT_MS,
    maxBytes: OPENCODE_MODELS_MAX_BYTES,
  })
  const result = runOpencodeAux({
    command,
    args: opencodeAuxArgs(['models', '--verbose'], options.pure === true),
    env,
    cwd: options.cwd,
    limits,
  })
  if (!auxResultAuthoritative(result, limits.maxBytes)) {
    return { ok: false }
  }
  return parseOpencodeModelsVerbose(result.stdout)
}

export const fetchOpencodeExport = (input: {
  command: string
  sessionID: string
  env: Env
  limits?: Partial<OpencodeAuxLimits>
  cwd?: string
  pure?: boolean
}): string | null => {
  const limits = auxLimitsOf(input.limits ?? {}, {
    timeoutMs: OPENCODE_AUX_TIMEOUT_MS,
    maxBytes: OPENCODE_EXPORT_MAX_BYTES,
  })
  const result = runOpencodeAux({
    command: input.command,
    args: opencodeAuxArgs(['export', input.sessionID], input.pure === true),
    env: input.env,
    cwd: input.cwd,
    limits,
  })
  if (!auxResultAuthoritative(result, limits.maxBytes)) {
    return null
  }
  return result.stdout
}

export const deleteOpencodeSession = (input: {
  command: string
  sessionID: string
  env: Env
  limits?: Partial<OpencodeAuxLimits>
  cwd?: string
  pure?: boolean
}): { ok: boolean; timedOut: boolean } => {
  const limits = auxLimitsOf(input.limits ?? {}, {
    timeoutMs: OPENCODE_SESSION_DELETE_TIMEOUT_MS,
    maxBytes: OPENCODE_SESSION_DELETE_MAX_BYTES,
  })
  const result = runOpencodeAux({
    command: input.command,
    args: opencodeAuxArgs(['session', 'delete', input.sessionID], input.pure === true),
    env: input.env,
    cwd: input.cwd,
    limits,
  })
  return { ok: result.ok, timedOut: result.timedOut }
}

const opencodePromptTailLines = [
  '3. 作業完了後、最終応答として front-matter 付き Markdown だけを返す。先頭に',
  '   ---',
  '   status: <completed | partial | failed | needs_input のいずれか>',
  '   ---',
  '   の front-matter を置き、その下に見出し Summary / Changed files / Commands / Verification / Findings / Blockers / Error の本文を書く。',
  '   report は簡潔に書く: Summary は 5 行以内。Findings は重要なものに絞る。コマンドの生ログは貼らず、Verification は実行コマンドと結果（exit code / pass・fail）のみ。該当が無い見出しは省く。',
  '   JSON やコードフェンスで全体をラップせず、md2idx / jq / build-response.sh によるレスポンス生成はしない。',
] as const

const opencodeTextEvent = (text: string, sessionID = 'ses_test_default'): string =>
  JSON.stringify({ type: 'text', sessionID, part: { text } })

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

const opencodeSessionCliArgs = (context: WrapperContext): string[] => {
  if (context.args.sessionMode === 'followup' && context.args.resumeArg !== '') {
    return ['-s', context.args.resumeArg]
  }
  return []
}

export const opencodeCliArgs = (context: WrapperContext, cliModel: string): string[] => {
  const args = ['run', '--format', 'json', '-m', cliModel]
  if (context.effort !== '') {
    args.push('--variant', context.effort)
  }
  args.push(...opencodeSessionCliArgs(context))
  if (usePureMode(context)) {
    args.push('--pure')
  }
  return args
}

export const lastTextFromCapture = (captureFile: string): string | null => {
  const summary = summarizeOpencodeCapture(captureFile)
  if (summary === null || !summary.sawTextEvent) {
    return null
  }
  return summary.lastText
}

const opencodeCapturedText = (context: WrapperContext, wait: WaitResult): string | null => {
  if (wait.childStatus !== 0) {
    return null
  }
  return lastTextFromCapture(context.stdoutCapture)
}

// A missing provider cost is distinct from a free-model cost of zero, so the generic
// price-table fallback must not add an estimate to opencode's measured usage.
const OPENCODE_EMPTY_PRICE_TABLE = { models: [], aliases: [] }

const recordOpencodeUsage = (context: WrapperContext): void => {
  quietly(() => {
    recordUsage({
      observeFile: context.args.observeFile,
      runDir: context.workDir,
      backend: context.backend,
      model: context.args.originalModel,
      requestFile: context.args.requestFile,
      responseFile: context.args.responseFile,
      source: 'opencode_step_finish',
      measured: usageFromOpencodeCapture(context.stdoutCapture, {
        model: context.args.originalModel,
        backend: context.backend,
      }),
      pricesTable: OPENCODE_EMPTY_PRICE_TABLE,
    })
  })
}

const opencodeChildEnv = (context: WrapperContext): Env => ({
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

const sessionModeFailure = (context: WrapperContext): CliResult | null => {
  const { sessionMode, resumeArg } = context.args
  if (sessionMode === 'followup' && resumeArg === '') {
    return finishWithoutChild(context, 5, 'ERROR: follow-up requires resume_id.')
  }
  if (sessionMode !== '' && sessionMode !== 'resumable' && sessionMode !== 'followup') {
    return finishWithoutChild(
      context,
      2,
      `ERROR: session_mode must be empty, resumable, or followup: ${sessionMode}`
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

const opencodeAuxLaunchOf = (
  context: WrapperContext
): { env: Env; cwd: string; pure: boolean } => ({
  env: opencodeChildEnv(context),
  cwd: context.repoRoot,
  pure: usePureMode(context),
})

const catalogIfNeeded = (
  command: string,
  context: WrapperContext,
  childStatus: number
): OpencodeCatalogLookup | null => {
  if (childStatus === 0 && context.effort === '') {
    return null
  }
  const aux = opencodeAuxLaunchOf(context)
  return fetchOpencodeCatalog(command, aux.env, { cwd: aux.cwd, pure: aux.pure })
}

const catalogForClassify = (catalog: OpencodeCatalogLookup | null): OpencodeCatalogLookup => {
  if (catalog === null) {
    return { ok: false }
  }
  return catalog
}

interface OpencodeSessionIdentity {
  id: string | null
  conflict: boolean
}

interface OpencodeIdentityFragment {
  text: string
  next: number
  hasNewline: boolean
}

interface OpencodeIdentityScan {
  identity: OpencodeSessionIdentity
  decoder: StringDecoder
  line: string
  lineBytes: number
  totalBytes: number
  overflowed: boolean
}

const emptyOpencodeSessionIdentity = (): OpencodeSessionIdentity => ({
  id: null,
  conflict: false,
})

const opencodeIdentityScan = (): OpencodeIdentityScan => ({
  identity: emptyOpencodeSessionIdentity(),
  decoder: new StringDecoder('utf8'),
  line: '',
  lineBytes: 0,
  totalBytes: 0,
  overflowed: false,
})

const recognizedOpencodeSessionId = (event: Record<string, unknown>): string | null => {
  if (typeof event.type !== 'string' || !OPENCODE_SESSION_EVENT_TYPES.has(event.type)) {
    return null
  }
  if (typeof event.sessionID !== 'string' || event.sessionID === '') {
    return null
  }
  if (!OPENCODE_SESSION_ID_PATTERN.test(event.sessionID)) {
    return null
  }
  return event.sessionID
}

const acceptOpencodeSessionCandidate = (
  identity: OpencodeSessionIdentity,
  candidate: string | null
): void => {
  if (candidate === null || identity.conflict) {
    return
  }
  if (identity.id === null) {
    identity.id = candidate
    return
  }
  if (identity.id !== candidate) {
    identity.conflict = true
    identity.id = null
  }
}

const consumeOpencodeSessionLine = (line: string, identity: OpencodeSessionIdentity): void => {
  const value = parseJsonLine(line)
  if (!isRecord(value)) {
    return
  }
  acceptOpencodeSessionCandidate(identity, recognizedOpencodeSessionId(value))
}

const finishIdentityLine = (scan: OpencodeIdentityScan): void => {
  consumeOpencodeSessionLine(scan.line, scan.identity)
  scan.line = ''
  scan.lineBytes = 0
}

const identityLineByteCount = (text: string, hasNewline: boolean): number => {
  if (hasNewline) {
    return Buffer.byteLength(text) + 1
  }
  return Buffer.byteLength(text)
}

const nextIdentityFragment = (text: string, offset: number): OpencodeIdentityFragment => {
  const newline = text.indexOf('\n', offset)
  if (newline === -1) {
    return { text: text.slice(offset), next: text.length, hasNewline: false }
  }
  return { text: text.slice(offset, newline), next: newline + 1, hasNewline: true }
}

const appendIdentityFragment = (
  scan: OpencodeIdentityScan,
  fragment: OpencodeIdentityFragment
): boolean => {
  scan.lineBytes += identityLineByteCount(fragment.text, fragment.hasNewline)
  if (scan.lineBytes > OPENCODE_CAPTURE_MAX_LINE_BYTES) {
    scan.overflowed = true
    return false
  }
  scan.line += fragment.text
  if (fragment.hasNewline) {
    finishIdentityLine(scan)
  }
  return true
}

const appendIdentityText = (scan: OpencodeIdentityScan, text: string): boolean => {
  let offset = 0
  while (offset < text.length) {
    const fragment = nextIdentityFragment(text, offset)
    if (fragment.next <= offset) {
      return false
    }
    if (!appendIdentityFragment(scan, fragment)) {
      return false
    }
    offset = fragment.next
  }
  return true
}

const consumeIdentityChunk = (scan: OpencodeIdentityScan, chunk: Buffer): boolean => {
  scan.totalBytes += chunk.length
  if (scan.totalBytes > OPENCODE_CAPTURE_MAX_BYTES) {
    scan.overflowed = true
    return false
  }
  return appendIdentityText(scan, scan.decoder.write(chunk))
}

const readIdentityChunk = (
  fd: number,
  buffer: Buffer,
  cursor: { offset: number; size: number }
): Buffer | null => {
  const want = Math.min(buffer.length, cursor.size - cursor.offset)
  const bytesRead = readSync(fd, buffer, 0, want, cursor.offset)
  if (bytesRead <= 0) {
    return null
  }
  return buffer.subarray(0, bytesRead)
}

const scanIdentityFd = (fd: number, scan: OpencodeIdentityScan): void => {
  const buffer = Buffer.alloc(OPENCODE_IDENTITY_READ_BYTES)
  const cursor = { offset: 0, size: fstatSync(fd).size }
  while (cursor.offset < cursor.size && !scan.overflowed) {
    const chunk = readIdentityChunk(fd, buffer, cursor)
    if (chunk === null) {
      return
    }
    cursor.offset += chunk.length
    consumeIdentityChunk(scan, chunk)
  }
}

const finishIdentityScan = (scan: OpencodeIdentityScan): void => {
  if (scan.overflowed) {
    return
  }
  if (!appendIdentityText(scan, scan.decoder.end())) {
    return
  }
  if (scan.line !== '') {
    finishIdentityLine(scan)
  }
}

const sessionIdentityFromCapture = (captureFile: string): OpencodeSessionIdentity => {
  const scan = opencodeIdentityScan()
  const fd = openSync(captureFile, 'r')
  try {
    scanIdentityFd(fd, scan)
    finishIdentityScan(scan)
    return scan.identity
  } finally {
    closeSync(fd)
  }
}

const sessionIdFromCapture = (captureFile: string): string | null =>
  sessionIdentityFromCapture(captureFile).id

const recordOpencodeChildFailure = (context: WrapperContext, failure: ChildFailure): void => {
  quietly(() => {
    recordChildFailure(context.args.observeFile, context.workDir, {
      backend: context.backend,
      failure,
    })
  })
}

const catalogUnavailableLines = (model: string): string[] => [
  '# Summary',
  `Child CLI failed: backend could not resolve model '${model}'. The backend returned no model catalog, so this is likely transient and may succeed on retry.`,
  '',
  '# Error',
  'Cause: model_catalog_unavailable',
  `Model: ${model}`,
  'Retryable: yes',
]

const catalogMissLines = (model: string): string[] => [
  '# Summary',
  `Child CLI failed: model '${model}' is not listed in the backend catalog. Catalog matching is reference information, not an allowlist.`,
  '',
  '# Error',
  'Cause: model_catalog_miss',
  `Model: ${model}`,
  'Retryable: yes',
]

const classifiedFailureBody = (failure: ChildFailure): string[] => {
  if (failure.kind === 'model_catalog_unavailable') {
    return catalogUnavailableLines(failure.model)
  }
  if (failure.kind === 'model_catalog_miss') {
    return catalogMissLines(failure.model)
  }
  return ['# Summary', 'Child CLI failed or did not write a response.', '', '# Error']
}

const failedExitCode = (childStatus: number): number => {
  if (childStatus === 0) {
    return 1
  }
  return childStatus
}

const classifiedFailureReport = (
  context: WrapperContext,
  failure: ChildFailure,
  childStatus: number
): string =>
  [
    '---',
    'status: failed',
    '---',
    ...classifiedFailureBody(failure),
    `See observe JSON: ${context.args.observeFile}`,
    `Exit code: ${failedExitCode(childStatus)}`,
    '',
  ].join('\n')

const classifyOpencodeRunFailure = (input: {
  context: WrapperContext
  cliModel: string
  childStatus: number
  catalog: OpencodeCatalogLookup | null
}): ChildFailure =>
  classifyOpencodeChildFailure({
    exitCode: input.childStatus,
    stdoutTail: readTailBytes(input.context.stdoutCapture, STDERR_TAIL_MAX_BYTES),
    requestedModel: input.cliModel,
    catalog: catalogForClassify(input.catalog),
  })

const recordFailureIfNeeded = (
  context: WrapperContext,
  childStatus: number,
  failure: ChildFailure
): void => {
  if (childStatus !== 0) {
    recordOpencodeChildFailure(context, failure)
  }
}

const variantsOfCatalogModel = (
  catalog: OpencodeCatalogLookup,
  cliModel: string
): Record<string, unknown> | null => {
  if (!catalog.ok) {
    return null
  }
  const entry = catalog.models.get(cliModel)
  if (typeof entry === 'undefined') {
    return null
  }
  return entry.variants
}

const emitEffortUnsupported = (
  context: WrapperContext,
  cliModel: string,
  variants: Record<string, unknown>
): void => {
  quietly(() => {
    appendObserveEvent(context.args.observeFile, context.workDir, {
      kind: 'effort_unsupported',
      ts: metricsTimestamp(),
      requested: context.effort,
      model: cliModel,
      variants: Object.keys(variants),
    })
  })
}

const opencodeEffortWarning = (
  context: WrapperContext,
  cliModel: string,
  catalog: OpencodeCatalogLookup | null
): string => {
  if (context.effort === '' || catalog === null) {
    return ''
  }
  const variants = variantsOfCatalogModel(catalog, cliModel)
  if (variants === null || opencodeVariantsInclude(variants, context.effort)) {
    return ''
  }
  emitEffortUnsupported(context, cliModel, variants)
  return OPENCODE_EFFORT_UNSUPPORTED_WARNING
}

const notExposedEffort = (): EffectiveEffort => ({ value: null, source: 'not_exposed' })

const effectiveFromExport = (exported: string | null): EffectiveEffort => {
  if (exported === null) {
    return notExposedEffort()
  }
  return effortFromOpencodeExport(exported) ?? notExposedEffort()
}

const recordOpencodeEffortObservation = (
  context: WrapperContext,
  effective: EffectiveEffort
): void => {
  quietly(() => {
    recordEffort(context.args.observeFile, context.workDir, {
      requested: context.effort,
      effective: { ...effective },
    })
  })
}

const recordOpencodeExportEffort = (
  context: WrapperContext,
  command: string,
  sessionID: string | null
): void => {
  if (sessionID === null) {
    recordOpencodeEffortObservation(context, notExposedEffort())
    return
  }
  const aux = opencodeAuxLaunchOf(context)
  const exported = fetchOpencodeExport({
    command,
    sessionID,
    env: aux.env,
    cwd: aux.cwd,
    pure: aux.pure,
  })
  recordOpencodeEffortObservation(context, effectiveFromExport(exported))
}

const applyOpencodeEffort = (input: {
  context: WrapperContext
  command: string
  cliModel: string
  catalog: OpencodeCatalogLookup | null
  sessionID: string | null
}): string => {
  if (input.context.effort === '') {
    return ''
  }
  const warning = opencodeEffortWarning(input.context, input.cliModel, input.catalog)
  recordOpencodeExportEffort(input.context, input.command, input.sessionID)
  return warning
}

const opencodeStdoutText = (input: {
  context: WrapperContext
  wait: WaitResult
  failure: ChildFailure
}): string | null => {
  if (input.wait.childStatus !== 0) {
    return classifiedFailureReport(input.context, input.failure, input.wait.childStatus)
  }
  return opencodeCapturedText(input.context, input.wait)
}

const OPENCODE_RESUME_SOURCE = 'opencode_json'

const recordOpencodeResumable = (
  context: WrapperContext,
  sessionID: string | null,
  outcome: { childStatus: number; responseAllowsResume: boolean }
): void => {
  recordResumableOutcome(context, {
    childStatus: outcome.childStatus,
    responseAllowsResume: outcome.responseAllowsResume,
    resumeId: sessionID ?? '',
    resumeSource: OPENCODE_RESUME_SOURCE,
    homeDir: '',
    failReason: 'OpenCode run did not complete successfully',
    missingIdReason: 'OpenCode sessionID was not found',
  })
}

const opencodeFollowupFailReason = (
  matched: boolean,
  outcome: { childStatus: number; responseAllowsResume: boolean }
): string => {
  if (outcome.childStatus === 0 && outcome.responseAllowsResume && !matched) {
    return 'OpenCode follow-up sessionID did not match resume_id'
  }
  return 'OpenCode follow-up did not complete successfully'
}

const recordOpencodeFollowup = (
  context: WrapperContext,
  sessionID: string | null,
  outcome: { childStatus: number; responseAllowsResume: boolean }
): void => {
  const matched = sessionID === context.args.resumeArg
  recordFollowupOutcome(context, {
    childStatus: outcome.childStatus,
    responseAllowsResume: outcome.responseAllowsResume && matched,
    resumeId: sessionID ?? '',
    resumeSource: OPENCODE_RESUME_SOURCE,
    homeDir: '',
    failReason: opencodeFollowupFailReason(matched, outcome),
  })
}

const recordOpencodeSessionOutcome = (
  context: WrapperContext,
  sessionID: string | null,
  outcome: { childStatus: number; responseAllowsResume: boolean }
): void => {
  if (context.args.sessionMode === 'resumable') {
    recordOpencodeResumable(context, sessionID, outcome)
    return
  }
  if (context.args.sessionMode === 'followup') {
    recordOpencodeFollowup(context, sessionID, outcome)
  }
}

const keepOpencodeSession = (sessionMode: string): boolean =>
  sessionMode === 'resumable' || sessionMode === 'followup'

const emitSessionDeleteSkipped = (context: WrapperContext): void => {
  quietly(() => {
    appendObserveEvent(context.args.observeFile, context.workDir, {
      kind: 'session_delete_skipped',
      ts: metricsTimestamp(),
    })
  })
}

const emitSessionDeleteFailed = (
  context: WrapperContext,
  sessionID: string,
  timedOut: boolean
): void => {
  quietly(() => {
    appendObserveEvent(context.args.observeFile, context.workDir, {
      kind: 'session_delete_failed',
      ts: metricsTimestamp(),
      session_id: sessionID,
      timed_out: timedOut,
    })
  })
}

const deleteCapturedSession = (
  context: WrapperContext,
  command: string,
  sessionID: string
): void => {
  const aux = opencodeAuxLaunchOf(context)
  const result = deleteOpencodeSession({
    command,
    sessionID,
    env: aux.env,
    cwd: aux.cwd,
    pure: aux.pure,
  })
  if (!result.ok) {
    emitSessionDeleteFailed(context, sessionID, result.timedOut)
  }
}

const reclaimOpencodeSession = (
  context: WrapperContext,
  command: string,
  sessionID: string | null
): void => {
  if (keepOpencodeSession(context.args.sessionMode)) {
    return
  }
  if (sessionID === null) {
    emitSessionDeleteSkipped(context)
    return
  }
  deleteCapturedSession(context, command, sessionID)
}

const observeOpencodeChild = (input: {
  context: WrapperContext
  launch: OpencodeLaunch
  cliModel: string
  wait: WaitResult
  sessionID: string | null
}): { failure: ChildFailure; summaryWarning: string } => {
  const catalog = catalogIfNeeded(input.launch.command, input.context, input.wait.childStatus)
  const failure = classifyOpencodeRunFailure({
    context: input.context,
    cliModel: input.cliModel,
    childStatus: input.wait.childStatus,
    catalog,
  })
  recordFailureIfNeeded(input.context, input.wait.childStatus, failure)
  const summaryWarning = applyOpencodeEffort({
    context: input.context,
    command: input.launch.command,
    cliModel: input.cliModel,
    catalog,
    sessionID: input.sessionID,
  })
  return { failure, summaryWarning }
}

const assembleOpencodeResult = (input: {
  context: WrapperContext
  cliModel: string
  wait: WaitResult
  sessionID: string | null
  failure: ChildFailure
  summaryWarning: string
}): CliResult => {
  const { context, cliModel, wait, sessionID, failure, summaryWarning } = input
  completeResponse(
    context,
    {
      responderSessionId: responderSessionIdOf(context, cliModel),
      reportMode: reportModeForBackend('opencode'),
      collectStdoutText: () => opencodeStdoutText({ context, wait, failure }),
      summaryWarning,
    },
    wait
  )
  const outcome = finalizeResponse(context, wait.childStatus)
  recordOpencodeUsage(context)
  recordOpencodeSessionOutcome(context, sessionID, {
    childStatus: wait.childStatus,
    responseAllowsResume: outcome.responseAllowsResume,
  })
  return wrapperResult(context, outcome)
}

interface OpencodeRunOverride {
  afterWait: (() => void) | null
  waitErrorAfterChild: Error | null
  identityError: Error | null
  swallowLifecycleSignal: boolean
}

const opencodeOverride = (partial: Partial<OpencodeRunOverride>): OpencodeRunOverride => ({
  afterWait: partial.afterWait ?? null,
  waitErrorAfterChild: partial.waitErrorAfterChild ?? null,
  identityError: partial.identityError ?? null,
  swallowLifecycleSignal: partial.swallowLifecycleSignal === true,
})

const opencodeRunOverrides = new Map<string, OpencodeRunOverride>()

const opencodeOverrideOf = (observeFile: string): OpencodeRunOverride | null =>
  opencodeRunOverrides.get(observeFile) ?? null

const applyOpencodeAfterWait = (observeFile: string): void => {
  const override = opencodeOverrideOf(observeFile)
  if (override === null) {
    return
  }
  if (override.afterWait !== null) {
    override.afterWait()
  }
  if (override.waitErrorAfterChild !== null) {
    throw override.waitErrorAfterChild
  }
}

const throwIfIdentityOverride = (observeFile: string): void => {
  const override = opencodeOverrideOf(observeFile)
  if (override === null || override.identityError === null) {
    return
  }
  throw override.identityError
}

const sessionIdForObserveFile = (captureFile: string, observeFile: string): string | null => {
  try {
    throwIfIdentityOverride(observeFile)
    return sessionIdFromCapture(captureFile)
  } catch {
    return null
  }
}

const assembleObservedOpencode = (input: {
  context: WrapperContext
  launch: OpencodeLaunch
  cliModel: string
  wait: WaitResult
}): CliResult => {
  const sessionID = sessionIdForObserveFile(
    input.context.stdoutCapture,
    input.context.args.observeFile
  )
  const observed = observeOpencodeChild({ ...input, sessionID })
  return assembleOpencodeResult({ ...input, sessionID, ...observed })
}

interface OpencodeChildRun {
  context: WrapperContext
  launch: OpencodeLaunch
  cliModel: string
  worker: SpawnedWorker
}

interface OpencodeSignalHold {
  pending: NodeJS.Signals | null
  swallow: boolean
}

const opencodeSignalHoldOf = (observeFile: string): OpencodeSignalHold => {
  const override = opencodeOverrideOf(observeFile)
  return {
    pending: null,
    swallow: override !== null && override.swallowLifecycleSignal,
  }
}

const bindOpencodeSignalHold = (hold: OpencodeSignalHold, signal: NodeJS.Signals): (() => void) => {
  const onSignal = (): void => {
    hold.pending = signal
  }
  process.on(signal, onSignal)
  return onSignal
}

const releaseOpencodeSignalHold = (
  hold: OpencodeSignalHold,
  listeners: { sigint: () => void; sigterm: () => void }
): void => {
  process.removeListener('SIGINT', listeners.sigint)
  process.removeListener('SIGTERM', listeners.sigterm)
  if (hold.pending === null || hold.swallow) {
    return
  }
  process.kill(process.pid, hold.pending)
}

const attachOpencodeSignalHold = (observeFile: string): (() => void) => {
  const hold = opencodeSignalHoldOf(observeFile)
  const listeners = {
    sigint: bindOpencodeSignalHold(hold, 'SIGINT'),
    sigterm: bindOpencodeSignalHold(hold, 'SIGTERM'),
  }
  return (): void => {
    releaseOpencodeSignalHold(hold, listeners)
  }
}

const waitForOpencodeChild = async (run: OpencodeChildRun): Promise<WaitResult> => {
  const wait = await waitWithHeartbeat({
    observeFile: run.context.args.observeFile,
    runDir: run.context.workDir,
    backend: run.context.backend,
    worker: run.worker,
    stdoutCapture: run.context.stdoutCapture,
    stderrCapture: run.context.stderrCapture,
    responseFile: run.context.args.responseFile,
    env: run.context.env,
  })
  applyOpencodeAfterWait(run.context.args.observeFile)
  return wait
}

const reclaimObservedOpencodeSession = (run: OpencodeChildRun): void => {
  reclaimOpencodeSession(
    run.context,
    run.launch.command,
    sessionIdForObserveFile(run.context.stdoutCapture, run.context.args.observeFile)
  )
}

const finishOpencodeChild = async (run: OpencodeChildRun): Promise<CliResult> => {
  try {
    const wait = await waitForOpencodeChild(run)
    return assembleObservedOpencode({ ...run, wait })
  } finally {
    reclaimObservedOpencodeSession(run)
  }
}

const opencodePromptFile = (context: WrapperContext, launch: OpencodeLaunch): string => {
  const constraints = promptConstraints(context.args.taskType, '', 'stdout')
  return writePromptFile(
    context,
    workerPrompt(context, launch.requestStep.step, {
      constraints,
      tailLines: opencodePromptTailLines,
    })
  )
}

const spawnOpencodeWorker = (
  context: WrapperContext,
  launch: OpencodeLaunch
): { cliModel: string; worker: SpawnedWorker } => {
  const cliModel = stripOpencodeSelector(context.baseModel)
  const worker = spawnWorker({
    command: launch.command,
    args: opencodeCliArgs(context, cliModel),
    cwd: context.repoRoot,
    env: opencodeChildEnv(context),
    stdinFile: opencodePromptFile(context, launch),
    stdoutCapture: context.stdoutCapture,
    stderrCapture: context.stderrCapture,
  })
  return { cliModel, worker }
}

const runOpencodeChild = async (
  context: WrapperContext,
  launch: OpencodeLaunch
): Promise<CliResult> => {
  const spawned = spawnOpencodeWorker(context, launch)
  const releaseHold = attachOpencodeSignalHold(context.args.observeFile)
  try {
    return await finishOpencodeChild({ context, launch, ...spawned })
  } finally {
    releaseHold()
  }
}

interface TestContextOptions {
  model?: string
  taskType?: string
  env?: Env
  sessionMode?: string
  resumeArg?: string
  sessionHome?: string
}

const testContextSessionArgs = (options: TestContextOptions): string[] => {
  if (typeof options.sessionMode !== 'string') {
    return []
  }
  return [options.sessionMode, options.resumeArg ?? '', options.sessionHome ?? '']
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
      ...testContextSessionArgs(options),
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

const catalogStdout = (providerID: string, id: string, variants: Record<string, unknown>): string =>
  `${providerID}/${id}\n${JSON.stringify({ id, providerID, variants })}\n`

const catalogLookup = (
  model: string,
  variants: Record<string, unknown>
): OpencodeCatalogLookup => ({ ok: true, models: new Map([[model, { id: model, variants }]]) })

const usageForOpencodeObserveCase = (
  files: { requestFile: string; responseFile: string },
  input: { parseFailed: boolean; costUsd: number | null }
): Record<string, unknown> => {
  if (input.parseFailed) {
    return estimatedUsage({
      requestFile: files.requestFile,
      responseFile: files.responseFile,
      model: 'opencode/opencode-go/glm-5.2@high',
      backend: 'opencode',
      source: 'chars_4',
    })
  }
  const usage: Record<string, unknown> = {
    input_tokens: 10,
    output_tokens: 2,
    total_tokens: 12,
    cached_input_tokens: 30,
    cache_write_tokens: 2,
    reasoning_tokens: 7,
    measurement: 'measured',
    source: 'opencode_step_finish',
    model: 'opencode/opencode-go/glm-5.2@high',
    backend: 'opencode',
  }
  if (input.costUsd !== null) {
    usage.cost_usd = input.costUsd
  }
  return usage
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  const { chmodSync, existsSync, readFileSync, writeFileSync } = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  const { createTestScratchDir } = await import('./test-scratch.ts')

  const writeExecutable = (dir: string, name: string, source: string): string => {
    const file = path.join(dir, name)
    writeFileSync(file, source)
    chmodSync(file, 0o755)
    return file
  }

  const readTestJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'))

  const observeEventsOfKind = (observeFile: string, kind: string): Record<string, unknown>[] => {
    const doc = readTestJson(observeFile)
    const matched: Record<string, unknown>[] = []
    if (!isRecord(doc) || !Array.isArray(doc.events)) {
      return matched
    }
    for (const event of doc.events) {
      if (isRecord(event) && event.kind === kind) {
        matched.push(event)
      }
    }
    return matched
  }

  const completedReport = '---\nstatus: completed\n---\n# Summary\nlast\n'
  const TEST_SESSION_ID = 'ses_test_default'

  const OPENCODE_OBSERVE_EPOCH_MS = 1_787_360_343_099

  const writeSessionEvents = (dir: string, sessionID: string): string => {
    const eventsFile = path.join(dir, 'session-events.jsonl')
    writeFileSync(
      eventsFile,
      `${JSON.stringify({
        type: 'text',
        timestamp: OPENCODE_OBSERVE_EPOCH_MS,
        sessionID,
        part: { text: completedReport },
      })}\n`
    )
    return eventsFile
  }

  const opencodeObserveEvent = (type: string, part: Record<string, unknown>, offset = 0): string =>
    JSON.stringify({
      type,
      timestamp: OPENCODE_OBSERVE_EPOCH_MS + offset,
      sessionID: TEST_SESSION_ID,
      part,
    })

  const opencodeObserveEventLines = (mode: string): string[] => {
    const reportText = '---\nstatus: completed\n---\n# Summary\nlast'
    const text = opencodeObserveEvent('text', { text: reportText })
    const tool = opencodeObserveEvent('tool_use', {}, 1)
    const tokens = { input: 10, output: 2, reasoning: 7, cache: { read: 30, write: 2 } }
    if (mode === 'observe-missing-step') {
      return [text, tool]
    }
    const part: Record<string, unknown> = { tokens }
    if (mode === 'observe-measured') {
      part.cost = 0.25
    }
    return [text, tool, opencodeObserveEvent('step_finish', part, 2)]
  }

  const expectMonotonicTimingField = (value: unknown): void => {
    expect(value).toEqual(expect.any(Number))
    expect(Number(value)).toBeGreaterThanOrEqual(0)
    expect(Number(value)).toBeLessThan(OPENCODE_OBSERVE_EPOCH_MS)
  }

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

    it('adds -s for follow-up resume ids', () => {
      const dir = createTestScratchDir('wrapper-opencode-followup-args-test')
      expect(
        opencodeCliArgs(
          makeTestContext(dir, { sessionMode: 'followup', resumeArg: 'ses_follow_1' }),
          'opencode-go/glm-5.2'
        )
      ).toEqual([
        'run',
        '--format',
        'json',
        '-m',
        'opencode-go/glm-5.2',
        '--variant',
        'high',
        '-s',
        'ses_follow_1',
      ])
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

  describe('sessionIdFromCapture', () => {
    const writeCapture = (name: string, body: string | Buffer): string => {
      const capture = path.join(createTestScratchDir(name), 'stdout.capture')
      writeFileSync(capture, body)
      return capture
    }

    it('keeps a later valid id when an earlier candidate is invalid', () => {
      const capture = writeCapture(
        'wrapper-opencode-session-id-invalid-then-valid',
        `${[
          JSON.stringify({ type: 'text', sessionID: '', part: { text: 'x' } }),
          JSON.stringify({ type: 'text', sessionID: 1, part: { text: 'y' } }),
          JSON.stringify({ type: 'plugin', sessionID: 'ses_plugin' }),
          JSON.stringify({ type: 'text', sessionID: 'ses_valid_1', part: { text: 'z' } }),
        ].join('\n')}\n`
      )
      expect(sessionIdFromCapture(capture)).toBe('ses_valid_1')
    })

    it('returns null when recognized session ids disagree', () => {
      const capture = writeCapture(
        'wrapper-opencode-session-id-conflict',
        `${[
          JSON.stringify({ type: 'text', sessionID: 'ses_a', part: { text: 'a' } }),
          JSON.stringify({ type: 'step_finish', sessionID: 'ses_b', part: {} }),
        ].join('\n')}\n`
      )
      expect(sessionIdFromCapture(capture)).toBeNull()
    })

    it('keeps a verified id after a later oversized line', () => {
      const event = JSON.stringify({
        type: 'text',
        sessionID: 'ses_keep_1',
        part: { text: 'ok' },
      })
      const capture = writeCapture(
        'wrapper-opencode-session-id-oversized-line',
        `${event}\n${'x'.repeat(OPENCODE_CAPTURE_MAX_LINE_BYTES + 1)}\n`
      )
      expect(sessionIdFromCapture(capture)).toBe('ses_keep_1')
      expect(lastTextFromCapture(capture)).toBeNull()
    })

    it('keeps a verified id after a later oversized capture', () => {
      const event = JSON.stringify({
        type: 'text',
        sessionID: 'ses_keep_1',
        part: { text: 'ok' },
      })
      const capture = writeCapture(
        'wrapper-opencode-session-id-oversized-capture',
        Buffer.concat([Buffer.from(`${event}\n`), Buffer.alloc(OPENCODE_CAPTURE_MAX_BYTES, 120)])
      )
      expect(sessionIdFromCapture(capture)).toBe('ses_keep_1')
      expect(lastTextFromCapture(capture)).toBeNull()
    })

    it('returns null when the capture file cannot be read', () => {
      const dir = createTestScratchDir('wrapper-opencode-session-id-missing-file')
      expect(
        sessionIdForObserveFile(path.join(dir, 'missing.capture'), path.join(dir, 'obs.json'))
      ).toBeNull()
    })
  })

  interface FakeRunFixture {
    argsFile: string
    auxLog: string
    cli: string
    cmdLog: string
    configFile: string
    dir: string
    observeFile: string
    promptFile: string
    requestFile: string
    responseFile: string
  }

  const cmdLogOf = (fixture: FakeRunFixture): string => {
    if (!existsSync(fixture.cmdLog)) {
      return ''
    }
    return readFileSync(fixture.cmdLog, 'utf8')
  }

  const makeFakeRunFixture = (dir: string): FakeRunFixture => {
    const files = {
      argsFile: path.join(dir, 'args.log'),
      auxLog: path.join(dir, 'aux.log'),
      cmdLog: path.join(dir, 'cmd.log'),
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
log_cmd() {
  if [ -n "$OPENCODE_TEST_CMD_LOG" ]; then
    printf '%s\\n' "$1" >> "$OPENCODE_TEST_CMD_LOG"
  fi
}
if [ "$1" = "--version" ]; then
  printf '%s\\n' '1.0.0'
  exit 0
fi
if [ "$1" = "models" ]; then
  if [ -n "$OPENCODE_TEST_AUX_LOG" ]; then
    printf '%s\\n' "models $*" >> "$OPENCODE_TEST_AUX_LOG"
    printf '%s\\n' "cwd=$(pwd)" >> "$OPENCODE_TEST_AUX_LOG"
    printf '%s\\n' "config=$OPENCODE_CONFIG_CONTENT" >> "$OPENCODE_TEST_AUX_LOG"
  fi
  log_cmd "models $*"
  if [ "$OPENCODE_TEST_MODELS_MODE" = "fail" ]; then
    exit 1
  fi
  if [ "$OPENCODE_TEST_MODELS_MODE" = "partial" ]; then
    printf '%s\\n' 'opencode-go/glm-5.2'
    printf '%s\\n' '{'
    exit 0
  fi
  if [ -n "$OPENCODE_TEST_MODELS_FILE" ]; then
    cat "$OPENCODE_TEST_MODELS_FILE"
    exit 0
  fi
  printf '%s\\n' 'opencode-go/glm-5.2'
  printf '%s\\n' '{"id":"glm-5.2","providerID":"opencode-go","variants":{"high":{},"max":{}}}'
  exit 0
fi
if [ "$1" = "export" ]; then
  if [ -n "$OPENCODE_TEST_AUX_LOG" ]; then
    printf '%s\\n' "export $*" >> "$OPENCODE_TEST_AUX_LOG"
    printf '%s\\n' "cwd=$(pwd)" >> "$OPENCODE_TEST_AUX_LOG"
    printf '%s\\n' "config=$OPENCODE_CONFIG_CONTENT" >> "$OPENCODE_TEST_AUX_LOG"
  fi
  log_cmd "export $*"
  if [ "$OPENCODE_TEST_EXPORT_MODE" = "fail" ]; then
    exit 1
  fi
  if [ -n "$OPENCODE_TEST_EXPORT_FILE" ]; then
    cat "$OPENCODE_TEST_EXPORT_FILE"
    exit 0
  fi
  printf '%s\\n' "Exporting session: $2"
  printf '%s\\n' '{"info":{"model":{"id":"glm-5.2","providerID":"opencode-go","variant":"high"}},"messages":[]}'
  exit 0
fi
if [ "$1" = "session" ]; then
  if [ -n "$OPENCODE_TEST_CMD_LOG" ]; then
    printf '%s\\n' "session $*" >> "$OPENCODE_TEST_CMD_LOG"
    printf '%s\\n' "cwd=$(pwd)" >> "$OPENCODE_TEST_CMD_LOG"
    printf '%s\\n' "config=$OPENCODE_CONFIG_CONTENT" >> "$OPENCODE_TEST_CMD_LOG"
  fi
  if [ "$OPENCODE_TEST_SESSION_MODE" = "fail" ]; then
    exit 1
  fi
  if [ "$OPENCODE_TEST_SESSION_MODE" = "timeout" ]; then
    sleep 10
    exit 0
  fi
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
if [ "$OPENCODE_TEST_OUTPUT_MODE" = "session-then-oversized-line" ]; then
  if [ -n "$OPENCODE_TEST_EVENTS_FILE" ]; then
    cat "$OPENCODE_TEST_EVENTS_FILE"
  fi
  head -c ${OPENCODE_CAPTURE_MAX_LINE_BYTES + 1} /dev/zero | tr '\\0' 'x'
  printf '\\n'
  exit 0
fi
if [ "$OPENCODE_TEST_OUTPUT_MODE" = "session-then-oversized-capture" ]; then
  if [ -n "$OPENCODE_TEST_EVENTS_FILE" ]; then
    cat "$OPENCODE_TEST_EVENTS_FILE"
  fi
  i=0
  while [ "$i" -lt ${Math.floor(OPENCODE_CAPTURE_MAX_BYTES / 65_536) + 1} ]; do
    head -c 65536 /dev/zero | tr '\\0' 'x'
    printf '\\n'
    i=$((i + 1))
  done
  exit 0
fi
if [ -n "$OPENCODE_TEST_EVENTS_FILE" ]; then
  cat "$OPENCODE_TEST_EVENTS_FILE"
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
    options: { env?: Env; sessionArgs?: readonly string[]; model?: string } = {}
  ): Promise<CliResult> =>
    runWrapperOpencode(
      [
        options.model ?? 'opencode/opencode-go/glm-5.2@high',
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
        OPENCODE_TEST_AUX_LOG: fixture.auxLog,
        OPENCODE_TEST_CMD_LOG: fixture.cmdLog,
        ...options.env,
      },
      { scriptsDir: fixture.dir }
    )

  describe('runWrapperOpencode', () => {
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

    it('fails closed when follow-up is missing a resume handle', async () => {
      const dir = createTestScratchDir('wrapper-opencode-followup-missing-handle-test')
      const fixture = makeFakeRunFixture(dir)
      const result = await runFake(fixture, { sessionArgs: ['followup', '', ''] })
      expect(result.exitCode).toBe(5)
      expect(existsSync(fixture.argsFile)).toBe(false)
      expectFailedResponse(fixture)
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

  describe('runWrapperOpencode observe JSON', () => {
    const expectedObserveEvents = (
      fixture: FakeRunFixture,
      parseFailed: boolean
    ): Record<string, unknown>[] => {
      const created = {
        kind: 'run_created',
        ts: expect.any(String),
        run_dir: fixture.dir,
        request_file: fixture.requestFile,
        response_file: fixture.responseFile,
      }
      if (!parseFailed) {
        return [created]
      }
      return [
        created,
        {
          kind: 'usage_parse_failed',
          ts: expect.any(String),
          backend: 'opencode',
          source: 'opencode_step_finish',
          message: 'measured usage was not available',
        },
      ]
    }

    const expectPinnedObserve = (
      fixture: FakeRunFixture,
      input: { usage: Record<string, unknown>; modelTurns: number | null; parseFailed: boolean }
    ): void => {
      const doc = readTestJson(fixture.observeFile)
      expect(doc).toEqual({
        schema_version: 1,
        run: {
          task_type: 'chore',
          model: 'opencode/opencode-go/glm-5.2@high',
          backend: 'opencode',
          request_file: fixture.requestFile,
          response_file: fixture.responseFile,
          run_dir: fixture.dir,
          requester_session_id: '',
          effort: {
            requested: 'high',
            effective: { value: 'high', source: 'opencode_export' },
          },
        },
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
          ts: expect.any(String),
          backend: 'opencode',
          child_pid: expect.any(Number),
          stdout_bytes: expect.any(Number),
          stderr_bytes: 0,
          last_stream_change_at: expect.any(String),
        },
        events: expectedObserveEvents(fixture, input.parseFailed),
        streams: {
          stdout: {
            bytes: expect.any(Number),
            truncated: false,
            content: expect.stringContaining('"type":"text"'),
          },
          stderr: { bytes: 0, truncated: false, content: '' },
        },
        timing: {
          total_ms: expect.any(Number),
          time_to_first_useful_event_ms: expect.any(Number),
          report_ready_at_ms: expect.any(Number),
          model_turns: input.modelTurns,
          tool_calls: 1,
          structured_output_parse: null,
          measurement_source: 'opencode_json',
        },
        usage: input.usage,
      })
      if (!isRecord(doc) || !isRecord(doc.timing)) {
        throw new Error('observe timing is missing')
      }
      expectMonotonicTimingField(doc.timing.total_ms)
      expectMonotonicTimingField(doc.timing.time_to_first_useful_event_ms)
      expectMonotonicTimingField(doc.timing.report_ready_at_ms)
    }

    it.each([
      { mode: 'observe-measured', modelTurns: 1, parseFailed: false, costUsd: 0.25 },
      { mode: 'observe-missing-cost', modelTurns: 1, parseFailed: false, costUsd: null },
      { mode: 'observe-missing-step', modelTurns: null, parseFailed: true, costUsd: null },
    ])('pins the observe JSON for $mode', async ({ mode, modelTurns, parseFailed, costUsd }) => {
      const dir = createTestScratchDir(`wrapper-opencode-${mode}-test`)
      const fixture = makeFakeRunFixture(dir)
      const eventsFile = path.join(dir, 'observe-events.jsonl')
      writeFileSync(eventsFile, `${opencodeObserveEventLines(mode).join('\n')}\n`)
      const result = await runFake(fixture, { env: { OPENCODE_TEST_EVENTS_FILE: eventsFile } })
      expect(result.exitCode).toBe(0)
      const usage = usageForOpencodeObserveCase(fixture, { parseFailed, costUsd })
      expectPinnedObserve(fixture, { usage, modelTurns, parseFailed })
    })
  })

  describe('opencode catalog parse and post-run classifier', () => {
    it('builds model ids from providerID/id and rejects a leftover JSON block', () => {
      const stdout = `${catalogStdout('opencode-go', 'glm-5.2', { high: {} })}opencode/other\n{\n`
      const parsed = parseOpencodeModelsVerbose(
        catalogStdout('opencode-go', 'glm-5.2', { high: {}, max: {} })
      )
      expect(parsed.ok).toBe(true)
      if (parsed.ok) {
        expect(parsed.models.has('opencode-go/glm-5.2')).toBe(true)
        expect(parsed.models.has('opencode-go/glm-5.2 heading')).toBe(false)
      }
      expect(parseOpencodeModelsVerbose(stdout).ok).toBe(false)
    })

    it('classifies catalog miss, unavailable, unknown, and slash-model sanitization', () => {
      const miss = classifyOpencodeChildFailure({
        exitCode: 1,
        stdoutTail: '',
        requestedModel: 'opencode-go/missing-model',
        catalog: catalogLookup('opencode-go/glm-5.2', { high: {} }),
      })
      expect(miss).toEqual({
        kind: 'model_catalog_miss',
        retryable: true,
        model: 'opencode-go/missing-model',
      })
      expect(
        classifyOpencodeChildFailure({
          exitCode: 1,
          stdoutTail: '',
          requestedModel: 'opencode-go/glm-5.2',
          catalog: { ok: false },
        })
      ).toEqual({
        kind: 'model_catalog_unavailable',
        retryable: true,
        model: 'opencode-go/glm-5.2',
      })
      expect(
        classifyOpencodeChildFailure({
          exitCode: 1,
          stdoutTail: '',
          requestedModel: 'opencode-go/glm-5.2',
          catalog: catalogLookup('opencode-go/glm-5.2', {}),
        })
      ).toEqual({ kind: 'unknown' })
      expect(
        classifyOpencodeChildFailure({
          exitCode: 1,
          stdoutTail: '',
          requestedModel: 'opencode-go/glm-5.2@high',
          catalog: { ok: false },
        })
      ).toEqual({ kind: 'unknown' })
    })

    it('drops truncated or timed-out models output to catalog unavailable', () => {
      const dir = createTestScratchDir('wrapper-opencode-models-aux-test')
      const huge = writeExecutable(
        dir,
        'opencode-huge',
        '#!/bin/sh\ndd if=/dev/zero bs=1024 count=8 2>/dev/null | tr "\\0" "x"\n'
      )
      const sleepy = writeExecutable(dir, 'opencode-sleep', '#!/bin/sh\nsleep 2\n')
      const auxEnv = { PATH: '/usr/bin:/bin' }
      expect(fetchOpencodeCatalog(huge, auxEnv, { maxBytes: 512 }).ok).toBe(false)
      expect(fetchOpencodeCatalog(sleepy, auxEnv, { timeoutMs: 200 }).ok).toBe(false)
    })

    it('rejects empty output, heading-less JSON, and stdout that fills maxBuffer', () => {
      const dir = createTestScratchDir('wrapper-opencode-models-authoritative-test')
      const empty = writeExecutable(dir, 'opencode-empty', '#!/bin/sh\nexit 0\n')
      const exact = writeExecutable(
        dir,
        'opencode-exact',
        '#!/bin/sh\nhead -c 512 /dev/zero | tr "\\0" "x"\n'
      )
      const auxEnv = { PATH: '/usr/bin:/bin' }
      expect(parseOpencodeModelsVerbose('').ok).toBe(false)
      expect(
        parseOpencodeModelsVerbose(
          '{"id":"glm-5.2","providerID":"opencode-go","variants":{"high":{}}}\n'
        ).ok
      ).toBe(false)
      expect(fetchOpencodeCatalog(empty, auxEnv).ok).toBe(false)
      expect(fetchOpencodeCatalog(exact, auxEnv, { maxBytes: 512 }).ok).toBe(false)
    })
  })

  describe('opencode failure classification and effort wiring', () => {
    it('records model_catalog_miss on a child failure when the catalog lacks the model', async () => {
      const dir = createTestScratchDir('wrapper-opencode-catalog-miss-test')
      const fixture = makeFakeRunFixture(dir)
      const modelsFile = path.join(dir, 'models.txt')
      writeFileSync(modelsFile, catalogStdout('opencode-go', 'other', { high: {} }))
      const result = await runFake(fixture, {
        env: { OPENCODE_TEST_EXIT_CODE: '1', OPENCODE_TEST_MODELS_FILE: modelsFile },
      })
      const doc = readTestJson(fixture.observeFile)
      expect(result.exitCode).toBe(1)
      expect(doc).toMatchObject({
        error: { kind: 'model_catalog_miss', retryable: true, model: 'opencode-go/glm-5.2' },
      })
      expect(JSON.stringify(readTestJson(fixture.responseFile))).toContain(
        'Cause: model_catalog_miss'
      )
    })

    it('records model_catalog_unavailable when models output cannot be parsed in full', async () => {
      const dir = createTestScratchDir('wrapper-opencode-catalog-unavail-test')
      const fixture = makeFakeRunFixture(dir)
      const result = await runFake(fixture, {
        env: { OPENCODE_TEST_EXIT_CODE: '1', OPENCODE_TEST_MODELS_MODE: 'partial' },
      })
      expect(result.exitCode).toBe(1)
      expect(readTestJson(fixture.observeFile)).toMatchObject({
        error: { kind: 'model_catalog_unavailable', retryable: true, model: 'opencode-go/glm-5.2' },
      })
    })

    it('does not create the error key when the catalog lists the requested model', async () => {
      const dir = createTestScratchDir('wrapper-opencode-catalog-unknown-test')
      const fixture = makeFakeRunFixture(dir)
      await runFake(fixture, { env: { OPENCODE_TEST_EXIT_CODE: '1' } })
      expect(readTestJson(fixture.observeFile)).not.toHaveProperty('error')
    })

    it('emits effort_unsupported and a Summary warning when variants omit requested', async () => {
      const dir = createTestScratchDir('wrapper-opencode-effort-unsupported-test')
      const fixture = makeFakeRunFixture(dir)
      const eventsFile = writeSessionEvents(dir, 'ses_test_effort_1')
      const result = await runFake(fixture, {
        model: 'opencode/opencode-go/glm-5.2@low',
        env: { OPENCODE_TEST_EVENTS_FILE: eventsFile },
      })
      expect(result.exitCode).toBe(0)
      expect(observeEventsOfKind(fixture.observeFile, 'effort_unsupported')).toEqual([
        expect.objectContaining({
          kind: 'effort_unsupported',
          requested: 'low',
          model: 'opencode-go/glm-5.2',
          variants: ['high', 'max'],
        }),
      ])
      expect(JSON.stringify(readTestJson(fixture.responseFile))).toContain(
        OPENCODE_EFFORT_UNSUPPORTED_WARNING
      )
    })

    it('emits effort_unsupported for a model whose variants object is empty', async () => {
      const dir = createTestScratchDir('wrapper-opencode-effort-empty-variants-test')
      const fixture = makeFakeRunFixture(dir)
      const modelsFile = path.join(dir, 'models.txt')
      writeFileSync(modelsFile, catalogStdout('opencode-go', 'glm-5.2', {}))
      const eventsFile = writeSessionEvents(dir, 'ses_test_effort_2')
      await runFake(fixture, {
        env: {
          OPENCODE_TEST_EVENTS_FILE: eventsFile,
          OPENCODE_TEST_MODELS_FILE: modelsFile,
        },
      })
      expect(observeEventsOfKind(fixture.observeFile, 'effort_unsupported')).toHaveLength(1)
    })

    it('does not emit effort_unsupported when variants include requested or catalog fails', async () => {
      const dir = createTestScratchDir('wrapper-opencode-effort-supported-test')
      const fixture = makeFakeRunFixture(dir)
      const eventsFile = writeSessionEvents(dir, 'ses_test_effort_3')
      await runFake(fixture, { env: { OPENCODE_TEST_EVENTS_FILE: eventsFile } })
      expect(observeEventsOfKind(fixture.observeFile, 'effort_unsupported')).toEqual([])
      const failed = makeFakeRunFixture(
        createTestScratchDir('wrapper-opencode-effort-catalog-fail-test')
      )
      await runFake(failed, {
        env: {
          OPENCODE_TEST_EVENTS_FILE: writeSessionEvents(failed.dir, 'ses_test_effort_4'),
          OPENCODE_TEST_MODELS_MODE: 'fail',
        },
      })
      expect(observeEventsOfKind(failed.observeFile, 'effort_unsupported')).toEqual([])
    })

    it('records opencode_export effort without effort_mismatch', async () => {
      const dir = createTestScratchDir('wrapper-opencode-effort-export-test')
      const fixture = makeFakeRunFixture(dir)
      const eventsFile = writeSessionEvents(dir, 'ses_test_export_1')
      await runFake(fixture, { env: { OPENCODE_TEST_EVENTS_FILE: eventsFile } })
      expect(readTestJson(fixture.observeFile)).toMatchObject({
        run: {
          effort: {
            requested: 'high',
            effective: { value: 'high', source: 'opencode_export' },
          },
        },
      })
      expect(observeEventsOfKind(fixture.observeFile, 'effort_mismatch')).toEqual([])
      expect(readFileSync(fixture.auxLog, 'utf8')).toContain('export ses_test_export_1')
    })

    it('does not call models or export on a successful run without effort', async () => {
      const fixture = makeFakeRunFixture(
        createTestScratchDir('wrapper-opencode-no-effort-aux-test')
      )
      await runFake(fixture, { model: 'opencode/opencode-go/glm-5.2' })
      expect(existsSync(fixture.auxLog)).toBe(false)
    })
  })

  describe('opencode aux isolation and effort fallbacks', () => {
    it('records requested effort as not_exposed when export is unreadable', async () => {
      const dir = createTestScratchDir('wrapper-opencode-effort-export-fail-test')
      const fixture = makeFakeRunFixture(dir)
      await runFake(fixture, {
        env: {
          OPENCODE_TEST_EVENTS_FILE: writeSessionEvents(dir, 'ses_test_export_fail'),
          OPENCODE_TEST_EXPORT_MODE: 'fail',
        },
      })
      expect(readTestJson(fixture.observeFile)).toMatchObject({
        run: {
          effort: {
            requested: 'high',
            effective: { value: null, source: 'not_exposed' },
          },
        },
      })
    })

    it('keeps effort_unsupported on a failed response Summary after a non-zero exit', async () => {
      const dir = createTestScratchDir('wrapper-opencode-effort-failed-warning-test')
      const fixture = makeFakeRunFixture(dir)
      const result = await runFake(fixture, {
        model: 'opencode/opencode-go/glm-5.2@low',
        env: { OPENCODE_TEST_EXIT_CODE: '1' },
      })
      expect(result.exitCode).toBe(1)
      expect(observeEventsOfKind(fixture.observeFile, 'effort_unsupported')).toHaveLength(1)
      expect(JSON.stringify(readTestJson(fixture.responseFile))).toContain(
        OPENCODE_EFFORT_UNSUPPORTED_WARNING
      )
    })

    it('starts models and export with the child env, cwd, and --pure', async () => {
      const dir = createTestScratchDir('wrapper-opencode-aux-isolation-test')
      const fixture = makeFakeRunFixture(dir)
      const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
      }).trimEnd()
      await runFake(fixture, {
        env: {
          OPENCODE_CONFIG_CONTENT: '{"leaked":true}',
          DELEGATE_OPENCODE_PURE: '1',
          OPENCODE_TEST_EVENTS_FILE: writeSessionEvents(dir, 'ses_test_aux_iso'),
        },
      })
      const auxLog = readFileSync(fixture.auxLog, 'utf8')
      expect(auxLog).toContain('models --verbose --pure')
      expect(auxLog).toContain('export ses_test_aux_iso --pure')
      expect(auxLog).toContain(`cwd=${repoRoot}`)
      expect(auxLog).toContain('config={}')
      expect(auxLog).not.toContain('leaked')
    })

    it('treats a heading-less models JSON as catalog unavailable', async () => {
      const dir = createTestScratchDir('wrapper-opencode-catalog-lone-json-test')
      const fixture = makeFakeRunFixture(dir)
      const modelsFile = path.join(dir, 'models.txt')
      writeFileSync(
        modelsFile,
        '{"id":"glm-5.2","providerID":"opencode-go","variants":{"high":{}}}\n'
      )
      const result = await runFake(fixture, {
        env: { OPENCODE_TEST_EXIT_CODE: '1', OPENCODE_TEST_MODELS_FILE: modelsFile },
      })
      expect(result.exitCode).toBe(1)
      expect(readTestJson(fixture.observeFile)).toMatchObject({
        error: { kind: 'model_catalog_unavailable', retryable: true, model: 'opencode-go/glm-5.2' },
      })
    })

    it('records requested effort as not_exposed when export JSON cannot be parsed', async () => {
      const dir = createTestScratchDir('wrapper-opencode-effort-export-parse-test')
      const fixture = makeFakeRunFixture(dir)
      const exportFile = path.join(dir, 'export.txt')
      writeFileSync(exportFile, 'not-json\n')
      await runFake(fixture, {
        env: {
          OPENCODE_TEST_EVENTS_FILE: writeSessionEvents(dir, 'ses_test_export_parse'),
          OPENCODE_TEST_EXPORT_FILE: exportFile,
        },
      })
      expect(readTestJson(fixture.observeFile)).toMatchObject({
        run: {
          effort: {
            requested: 'high',
            effective: { value: null, source: 'not_exposed' },
          },
        },
      })
    })
  })

  const expectSessionDeleted = (fixture: FakeRunFixture, sessionID: string): void => {
    expect(cmdLogOf(fixture)).toContain(`session delete ${sessionID}`)
  }

  const expectSessionKept = (fixture: FakeRunFixture): void => {
    expect(cmdLogOf(fixture)).not.toContain('session delete')
  }

  const writeTextEvents = (dir: string, payload: Record<string, unknown>): string => {
    const eventsFile = path.join(dir, 'session-events.jsonl')
    writeFileSync(eventsFile, `${JSON.stringify({ type: 'text', ...payload })}\n`)
    return eventsFile
  }

  const writeJsonlEvents = (dir: string, events: Record<string, unknown>[]): string => {
    const eventsFile = path.join(dir, 'session-events.jsonl')
    writeFileSync(eventsFile, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`)
    return eventsFile
  }

  const withOpencodeOverride = async (
    observeFile: string,
    override: OpencodeRunOverride,
    run: () => Promise<void>
  ): Promise<void> => {
    opencodeRunOverrides.set(observeFile, override)
    try {
      await run()
    } finally {
      opencodeRunOverrides.delete(observeFile)
    }
  }

  const expectResumableObserve = (observeFile: string, resumeId: string): void => {
    expect(readTestJson(observeFile)).toMatchObject({
      backend_session: {
        resume_id: resumeId,
        resume_source: 'opencode_json',
        persistence: 'resumable',
      },
    })
  }

  const expectUnavailableObserve = (observeFile: string): void => {
    expect(readTestJson(observeFile)).toMatchObject({
      backend_session: { persistence: 'unavailable', resume_id: null },
    })
  }

  describe('opencode session reuse', () => {
    it('records resume_id on resumable runs and does not delete the session', async () => {
      const dir = createTestScratchDir('wrapper-opencode-resumable-session-test')
      const fixture = makeFakeRunFixture(dir)
      const result = await runFake(fixture, { sessionArgs: ['resumable', '', ''] })
      expect(result.exitCode).toBe(0)
      expect(readTestJson(fixture.observeFile)).toMatchObject({
        backend_session: {
          backend: 'opencode',
          model: 'opencode/opencode-go/glm-5.2@high',
          resume_id: TEST_SESSION_ID,
          resume_source: 'opencode_json',
          persistence: 'resumable',
          home_dir: null,
        },
      })
      expectSessionKept(fixture)
    })

    it('passes -s on follow-up runs and does not delete the session', async () => {
      const dir = createTestScratchDir('wrapper-opencode-followup-session-test')
      const fixture = makeFakeRunFixture(dir)
      const result = await runFake(fixture, { sessionArgs: ['followup', 'ses_follow_1', ''] })
      expect(result.exitCode).toBe(0)
      expect(readFileSync(fixture.argsFile, 'utf8').split('\n')).toEqual(
        expect.arrayContaining(['-s', 'ses_follow_1'])
      )
      expectSessionKept(fixture)
    })

    it('deletes the captured session on a normal run and omits backend_session', async () => {
      const dir = createTestScratchDir('wrapper-opencode-normal-session-delete-test')
      const fixture = makeFakeRunFixture(dir)
      const result = await runFake(fixture)
      expect(result.exitCode).toBe(0)
      expect(readTestJson(fixture.observeFile)).not.toHaveProperty('backend_session')
      expectSessionDeleted(fixture, TEST_SESSION_ID)
    })

    it('deletes the session after export on a normal run', async () => {
      const dir = createTestScratchDir('wrapper-opencode-session-delete-after-export-test')
      const fixture = makeFakeRunFixture(dir)
      await runFake(fixture, {
        env: { OPENCODE_TEST_EVENTS_FILE: writeSessionEvents(dir, 'ses_order_1') },
      })
      const log = cmdLogOf(fixture)
      const exportAt = log.indexOf('export ses_order_1')
      const deleteAt = log.indexOf('session delete ses_order_1')
      expect(exportAt).toBeGreaterThanOrEqual(0)
      expect(deleteAt).toBeGreaterThan(exportAt)
    })

    it('does not re-record an unmatched follow-up handle', async () => {
      const dir = createTestScratchDir('wrapper-opencode-followup-mismatch-test')
      const fixture = makeFakeRunFixture(dir)
      const result = await runFake(fixture, { sessionArgs: ['followup', 'ses_follow_1', ''] })
      expect(result.exitCode).toBe(0)
      expectUnavailableObserve(fixture.observeFile)
      expectSessionKept(fixture)
    })

    it('marks follow-up unavailable when capture has no session id', async () => {
      const dir = createTestScratchDir('wrapper-opencode-followup-missing-id-test')
      const fixture = makeFakeRunFixture(dir)
      const eventsFile = writeTextEvents(dir, { part: { text: completedReport } })
      const result = await runFake(fixture, {
        sessionArgs: ['followup', 'ses_follow_1', ''],
        env: { OPENCODE_TEST_EVENTS_FILE: eventsFile },
      })
      expect(result.exitCode).toBe(0)
      expectUnavailableObserve(fixture.observeFile)
      expectSessionKept(fixture)
    })

    it('keeps persistence across resumable then matching follow-up', async () => {
      const initial = makeFakeRunFixture(
        createTestScratchDir('wrapper-opencode-resumable-followup-1')
      )
      const first = await runFake(initial, { sessionArgs: ['resumable', '', ''] })
      expect(first.exitCode).toBe(0)
      expectResumableObserve(initial.observeFile, TEST_SESSION_ID)
      const follow = makeFakeRunFixture(
        createTestScratchDir('wrapper-opencode-resumable-followup-2')
      )
      const second = await runFake(follow, { sessionArgs: ['followup', TEST_SESSION_ID, ''] })
      expect(second.exitCode).toBe(0)
      expectResumableObserve(follow.observeFile, TEST_SESSION_ID)
      expectSessionKept(follow)
    })
  })

  describe('opencode session lifecycle', () => {
    it('deletes the session after a child non-zero exit', async () => {
      const dir = createTestScratchDir('wrapper-opencode-session-delete-child-error-test')
      const fixture = makeFakeRunFixture(dir)
      await runFake(fixture, { env: { OPENCODE_TEST_EXIT_CODE: '7' } })
      expectSessionDeleted(fixture, TEST_SESSION_ID)
    })

    it('deletes the session after a child signal', async () => {
      const dir = createTestScratchDir('wrapper-opencode-session-delete-child-signal-test')
      const fixture = makeFakeRunFixture(dir)
      await runFake(fixture, { env: { OPENCODE_TEST_EXIT_MODE: 'signal' } })
      expectSessionDeleted(fixture, TEST_SESSION_ID)
    })

    it('deletes the session after a response parse failure', async () => {
      const dir = createTestScratchDir('wrapper-opencode-session-delete-parse-fail-test')
      const fixture = makeFakeRunFixture(dir)
      const eventsFile = writeTextEvents(dir, {
        sessionID: 'ses_parse_fail',
        part: { text: 'not-a-report' },
      })
      const result = await runFake(fixture, { env: { OPENCODE_TEST_EVENTS_FILE: eventsFile } })
      expect(result.exitCode).toBe(1)
      expectSessionDeleted(fixture, 'ses_parse_fail')
    })

    it('records session_delete_skipped when sessionID is missing', async () => {
      const dir = createTestScratchDir('wrapper-opencode-session-delete-skipped-test')
      const fixture = makeFakeRunFixture(dir)
      const eventsFile = writeTextEvents(dir, { part: { text: completedReport } })
      const result = await runFake(fixture, { env: { OPENCODE_TEST_EVENTS_FILE: eventsFile } })
      expect(result.exitCode).toBe(0)
      expectSessionKept(fixture)
      expect(observeEventsOfKind(fixture.observeFile, 'session_delete_skipped')).toHaveLength(1)
    })

    it('records session_delete_failed when session delete exits non-zero', async () => {
      const dir = createTestScratchDir('wrapper-opencode-session-delete-fail-test')
      const fixture = makeFakeRunFixture(dir)
      const result = await runFake(fixture, { env: { OPENCODE_TEST_SESSION_MODE: 'fail' } })
      expect(result.exitCode).toBe(0)
      expect(observeEventsOfKind(fixture.observeFile, 'session_delete_failed')).toEqual([
        expect.objectContaining({
          kind: 'session_delete_failed',
          session_id: TEST_SESSION_ID,
          timed_out: false,
        }),
      ])
    })

    it('records session_delete_failed when session delete times out', async () => {
      const dir = createTestScratchDir('wrapper-opencode-session-delete-timeout-test')
      const fixture = makeFakeRunFixture(dir)
      const result = await runFake(fixture, { env: { OPENCODE_TEST_SESSION_MODE: 'timeout' } })
      expect(result.exitCode).toBe(0)
      expect(observeEventsOfKind(fixture.observeFile, 'session_delete_failed')).toEqual([
        expect.objectContaining({
          kind: 'session_delete_failed',
          session_id: TEST_SESSION_ID,
          timed_out: true,
        }),
      ])
    })

    it('starts session delete with the child env, cwd, and --pure', async () => {
      const dir = createTestScratchDir('wrapper-opencode-session-delete-isolation-test')
      const fixture = makeFakeRunFixture(dir)
      const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
      }).trimEnd()
      await runFake(fixture, {
        env: {
          OPENCODE_CONFIG_CONTENT: '{"leaked":true}',
          DELEGATE_OPENCODE_PURE: '1',
        },
      })
      const log = cmdLogOf(fixture)
      expect(log).toContain(`session delete ${TEST_SESSION_ID} --pure`)
      expect(log).toContain(`cwd=${repoRoot}`)
      expect(log).toContain('config={}')
      expect(log).not.toContain('leaked')
    })

    it('times out a hung session delete helper', () => {
      const dir = createTestScratchDir('wrapper-opencode-session-delete-helper-timeout-test')
      const sleepy = writeExecutable(dir, 'opencode-sleep', '#!/bin/sh\nsleep 2\n')
      const result = deleteOpencodeSession({
        command: sleepy,
        sessionID: 'ses_timeout',
        env: { PATH: '/usr/bin:/bin' },
        limits: { timeoutMs: 200 },
      })
      expect(result.ok).toBe(false)
      expect(result.timedOut).toBe(true)
    })
  })

  describe('opencode session identity reclaim', () => {
    it('skips delete when captured session ids disagree', async () => {
      const dir = createTestScratchDir('wrapper-opencode-session-id-conflict-run')
      const fixture = makeFakeRunFixture(dir)
      const eventsFile = writeJsonlEvents(dir, [
        { type: 'text', sessionID: 'ses_a', part: { text: completedReport } },
        { type: 'text', sessionID: 'ses_b', part: { text: completedReport } },
      ])
      const result = await runFake(fixture, { env: { OPENCODE_TEST_EVENTS_FILE: eventsFile } })
      expect(result.exitCode).toBe(0)
      expectSessionKept(fixture)
      expect(observeEventsOfKind(fixture.observeFile, 'session_delete_skipped')).toHaveLength(1)
    })

    it('deletes a later valid id when earlier candidates are invalid', async () => {
      const dir = createTestScratchDir('wrapper-opencode-session-id-invalid-then-valid-run')
      const fixture = makeFakeRunFixture(dir)
      const eventsFile = writeJsonlEvents(dir, [
        { type: 'text', sessionID: '', part: { text: 'x' } },
        { type: 'text', sessionID: 1, part: { text: 'y' } },
        { type: 'plugin', sessionID: 'ses_plugin' },
        { type: 'text', sessionID: 'ses_valid_1', part: { text: completedReport } },
      ])
      const result = await runFake(fixture, { env: { OPENCODE_TEST_EVENTS_FILE: eventsFile } })
      expect(result.exitCode).toBe(0)
      expectSessionDeleted(fixture, 'ses_valid_1')
    })

    it.each(['session-then-oversized-line', 'session-then-oversized-capture'] as const)(
      'deletes a verified session after %s',
      async (outputMode) => {
        const dir = createTestScratchDir(`wrapper-opencode-${outputMode}-reclaim-test`)
        const fixture = makeFakeRunFixture(dir)
        const result = await runFake(fixture, {
          env: {
            OPENCODE_TEST_OUTPUT_MODE: outputMode,
            OPENCODE_TEST_EVENTS_FILE: writeSessionEvents(dir, 'ses_keep_1'),
          },
        })
        expect(result.exitCode).toBe(1)
        expectSessionDeleted(fixture, 'ses_keep_1')
      }
    )
  })

  describe('opencode session reclaim after wait', () => {
    it('reclaims the session when waiting for the child rejects', async () => {
      const dir = createTestScratchDir('wrapper-opencode-wait-reject-test')
      const fixture = makeFakeRunFixture(dir)
      await withOpencodeOverride(
        fixture.observeFile,
        opencodeOverride({ waitErrorAfterChild: new Error('opencode-wait-reject') }),
        async () => {
          await expect(runFake(fixture)).rejects.toThrow('opencode-wait-reject')
          expectSessionDeleted(fixture, TEST_SESSION_ID)
        }
      )
    })

    it('records session_delete_skipped when session identity extraction throws', async () => {
      const dir = createTestScratchDir('wrapper-opencode-identity-throw-test')
      const fixture = makeFakeRunFixture(dir)
      await withOpencodeOverride(
        fixture.observeFile,
        opencodeOverride({ identityError: new Error('opencode-identity-read') }),
        async () => {
          const result = await runFake(fixture)
          expect(result.exitCode).toBe(0)
          expectSessionKept(fixture)
          expect(observeEventsOfKind(fixture.observeFile, 'session_delete_skipped')).toHaveLength(1)
        }
      )
    })

    it('reclaims the session when SIGTERM arrives after the child exits', async () => {
      const dir = createTestScratchDir('wrapper-opencode-late-sigterm-test')
      const fixture = makeFakeRunFixture(dir)
      const received: string[] = []
      const onTerm = (): void => {
        received.push('SIGTERM')
      }
      process.on('SIGTERM', onTerm)
      try {
        await withOpencodeOverride(
          fixture.observeFile,
          opencodeOverride({
            swallowLifecycleSignal: true,
            afterWait: () => {
              process.emit('SIGTERM')
            },
          }),
          async () => {
            const result = await runFake(fixture)
            expect(result.exitCode).toBe(0)
            expectSessionDeleted(fixture, TEST_SESSION_ID)
          }
        )
        expect(received.length).toBeGreaterThan(0)
      } finally {
        process.removeListener('SIGTERM', onTerm)
      }
    })
  })
}
