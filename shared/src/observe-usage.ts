import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  collectJsonlFiles,
  getPath,
  hasFileContent,
  isDirectory,
  isRecord,
  jqCoalesce,
  numberOrNull,
  parseJsonLine,
  parseJsonObjects,
  readFileOrEmpty,
} from './jq-compat.ts'
import { bodyStats, estimatedTokens } from './protocol.ts'

export const OPENCODE_CAPTURE_MAX_BYTES = 8 * 1024 * 1024
export const OPENCODE_CAPTURE_MAX_LINE_BYTES = 1 * 1024 * 1024
const OPENCODE_CAPTURE_READ_BYTES = 64 * 1024
const OPENCODE_EVENT_TYPES = new Set(['step_start', 'text', 'tool_use', 'step_finish', 'error'])

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isNonNegativeFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

interface OpencodeUsageAccumulator {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  costComplete: boolean
  steps: number
}

interface OpencodeCaptureAccumulator {
  lastText: string | null
  sawTextEvent: boolean
  firstUseful: boolean
  recognized: number
  stepFinishCount: number
  toolUseCount: number
  usage: OpencodeUsageAccumulator
  usageFailed: boolean
}

const opencodeUsageAccumulator = (): OpencodeUsageAccumulator => ({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  costComplete: true,
  steps: 0,
})

const opencodeCaptureAccumulator = (): OpencodeCaptureAccumulator => ({
  lastText: null,
  sawTextEvent: false,
  firstUseful: false,
  recognized: 0,
  stepFinishCount: 0,
  toolUseCount: 0,
  usage: opencodeUsageAccumulator(),
  usageFailed: false,
})

interface OpencodeCaptureState {
  line: string
  lineBytes: number
  accumulator: OpencodeCaptureAccumulator
}

const opencodeCaptureState = (): OpencodeCaptureState => ({
  line: '',
  lineBytes: 0,
  accumulator: opencodeCaptureAccumulator(),
})

interface OpencodeCaptureFragment {
  text: string
  nextOffset: number
  hasNewline: boolean
}

const opencodeCaptureFragmentOf = (text: string, offset: number): OpencodeCaptureFragment => {
  const newline = text.indexOf('\n', offset)
  if (newline === -1) {
    return { text: text.slice(offset), nextOffset: text.length, hasNewline: false }
  }
  return { text: text.slice(offset, newline), nextOffset: newline + 1, hasNewline: true }
}

type OpencodeEventConsumer = (
  event: Record<string, unknown>,
  accumulator: OpencodeCaptureAccumulator
) => void

const opencodeEventConsumer: { run: OpencodeEventConsumer } = {
  run: () => {
    // replaced after consumeOpencodeCaptureEvent is defined
  },
}

const consumeOpencodeCaptureLine = (line: string, state: OpencodeCaptureState): void => {
  const value = parseJsonLine(line)
  if (isRecord(value)) {
    opencodeEventConsumer.run(value, state.accumulator)
  }
}

const opencodeCaptureFragmentBytes = (fragment: OpencodeCaptureFragment): number => {
  let newlineBytes = 0
  if (fragment.hasNewline) {
    newlineBytes = 1
  }
  return Buffer.byteLength(fragment.text) + newlineBytes
}

const finishOpencodeCaptureLine = (
  fragment: OpencodeCaptureFragment,
  state: OpencodeCaptureState
): void => {
  if (!fragment.hasNewline) {
    return
  }
  consumeOpencodeCaptureLine(state.line, state)
  state.line = ''
  state.lineBytes = 0
}

const consumeOpencodeCaptureFragment = (
  fragment: OpencodeCaptureFragment,
  state: OpencodeCaptureState
): boolean => {
  state.lineBytes += opencodeCaptureFragmentBytes(fragment)
  if (state.lineBytes > OPENCODE_CAPTURE_MAX_LINE_BYTES) {
    return false
  }
  state.line += fragment.text
  finishOpencodeCaptureLine(fragment, state)
  return true
}

const appendOpencodeCaptureText = (text: string, state: OpencodeCaptureState): boolean => {
  for (let offset = 0; offset < text.length;) {
    const fragment = opencodeCaptureFragmentOf(text, offset)
    if (fragment.nextOffset <= offset) {
      return false
    }
    if (!consumeOpencodeCaptureFragment(fragment, state)) {
      return false
    }
    offset = fragment.nextOffset
  }
  return true
}

interface OpencodeCaptureSession {
  state: OpencodeCaptureState
  decoder: StringDecoder
  offset: number
  totalBytes: number
  truncated: boolean
  finished: boolean
}

const opencodeCaptureSession = (): OpencodeCaptureSession => ({
  state: opencodeCaptureState(),
  decoder: new StringDecoder('utf8'),
  offset: 0,
  totalBytes: 0,
  truncated: false,
  finished: false,
})

const captureSessions = new Map<string, OpencodeCaptureSession>()

const closeOpencodeCapture = (fd: number | null): void => {
  if (fd === null) {
    return
  }
  try {
    closeSync(fd)
  } catch {
    // capture cleanup is best-effort
  }
}

const openOpencodeCaptureFd = (captureFile: string): number | null => {
  try {
    return openSync(captureFile, 'r')
  } catch {
    return null
  }
}

const readOpencodeCaptureChunk = (
  session: OpencodeCaptureSession,
  input: { fd: number; buffer: Buffer; size: number }
): number => {
  const want = Math.min(input.buffer.length, input.size - session.offset)
  if (want <= 0) {
    return 0
  }
  return readSync(input.fd, input.buffer, 0, want, session.offset)
}

const consumeOpencodeCaptureChunk = (session: OpencodeCaptureSession, chunk: Buffer): boolean => {
  session.offset += chunk.length
  session.totalBytes += chunk.length
  if (session.totalBytes > OPENCODE_CAPTURE_MAX_BYTES) {
    return false
  }
  return appendOpencodeCaptureText(session.decoder.write(chunk), session.state)
}

const scanOpencodeCaptureChunks = (fd: number, session: OpencodeCaptureSession): boolean => {
  const buffer = Buffer.alloc(OPENCODE_CAPTURE_READ_BYTES)
  const { size } = fstatSync(fd)
  while (session.offset < size) {
    const bytesRead = readOpencodeCaptureChunk(session, { fd, buffer, size })
    if (bytesRead <= 0) {
      session.offset = size
      return true
    }
    if (!consumeOpencodeCaptureChunk(session, buffer.subarray(0, bytesRead))) {
      return false
    }
  }
  return true
}

const readOpencodeCaptureFd = (fd: number, session: OpencodeCaptureSession): void => {
  if (fstatSync(fd).size > OPENCODE_CAPTURE_MAX_BYTES) {
    session.truncated = true
    return
  }
  if (!scanOpencodeCaptureChunks(fd, session)) {
    session.truncated = true
  }
}

const finishOpencodeCaptureSession = (session: OpencodeCaptureSession): void => {
  session.finished = true
  if (session.truncated) {
    return
  }
  if (!appendOpencodeCaptureText(session.decoder.end(), session.state)) {
    session.truncated = true
    return
  }
  if (session.state.line !== '') {
    consumeOpencodeCaptureLine(session.state.line, session.state)
    session.state.line = ''
  }
}

const sessionOfOpencodeCapture = (captureFile: string): OpencodeCaptureSession => {
  const existing = captureSessions.get(captureFile)
  if (existing) {
    return existing
  }
  const created = opencodeCaptureSession()
  captureSessions.set(captureFile, created)
  return created
}

const readAndMaybeFinishCapture = (
  fd: number,
  session: OpencodeCaptureSession,
  finish: boolean
): OpencodeCaptureSession => {
  if (!session.finished && !session.truncated) {
    readOpencodeCaptureFd(fd, session)
    if (finish) {
      finishOpencodeCaptureSession(session)
    }
  }
  return session
}

const advanceOpencodeCaptureSession = (
  captureFile: string,
  finish: boolean
): OpencodeCaptureSession | null => {
  const fd = openOpencodeCaptureFd(captureFile)
  if (fd === null) {
    return captureSessions.get(captureFile) ?? null
  }
  try {
    return readAndMaybeFinishCapture(fd, sessionOfOpencodeCapture(captureFile), finish)
  } finally {
    closeOpencodeCapture(fd)
  }
}

const isUsefulOpencodeEvent = (event: Record<string, unknown>): boolean => {
  if (event.type === 'tool_use') {
    return true
  }
  const text = getPath(event, ['part', 'text'])
  return event.type === 'text' && typeof text === 'string' && text.length > 0
}

const peekOpencodeFirstUseful = (session: OpencodeCaptureSession): boolean => {
  if (session.state.accumulator.firstUseful) {
    return true
  }
  const value = parseJsonLine(session.state.line)
  if (!isRecord(value)) {
    return false
  }
  return isUsefulOpencodeEvent(value)
}

export interface OpencodeCaptureSummary {
  lastText: string | null
  sawTextEvent: boolean
  firstUseful: boolean
  recognized: number
  stepFinishCount: number
  toolUseCount: number
}

const summaryOfOpencodeSession = (
  session: OpencodeCaptureSession
): OpencodeCaptureSummary | null => {
  if (session.truncated) {
    return null
  }
  const { accumulator } = session.state
  return {
    lastText: accumulator.lastText,
    sawTextEvent: accumulator.sawTextEvent,
    firstUseful: accumulator.firstUseful,
    recognized: accumulator.recognized,
    stepFinishCount: accumulator.stepFinishCount,
    toolUseCount: accumulator.toolUseCount,
  }
}

export const summarizeOpencodeCapture = (captureFile: string): OpencodeCaptureSummary | null => {
  const session = advanceOpencodeCaptureSession(captureFile, true)
  if (session === null) {
    return null
  }
  return summaryOfOpencodeSession(session)
}

export const opencodeCaptureFirstUseful = (captureFile: string): boolean => {
  const session = advanceOpencodeCaptureSession(captureFile, false)
  if (session === null) {
    return false
  }
  return peekOpencodeFirstUseful(session)
}

// bash 版 observe-json.sh の usage 抽出関数と同一契約
// (等価性は scripts/observe-parity.test.ts が bash 実装との突き合わせで検証する)。

// jq の join は null を空文字、数値・真偽値を文字列化し、配列・object 要素では
// エラーになる (エラーは 2>/dev/null | wc -m 経由で 0 に落ちる)
const joinableSection = (section: unknown): string | null => {
  if (typeof section === 'string') {
    return section
  }
  if (section === null) {
    return ''
  }
  if (typeof section === 'number' || typeof section === 'boolean') {
    return String(section)
  }
  return null
}

const sectionsFromFile = (file: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return jqCoalesce(getPath(parsed, ['sections'])) ?? []
  } catch {
    return null
  }
}

// jq -j '.sections // [] | join("\n\n")' | wc -m 相当。
// ファイル不在・空は null（bash の空文字列）、JSON 破損は 0 を返す
export const countSectionChars = (file: string): number | null => {
  if (!hasFileContent(file)) {
    return null
  }
  const sections = sectionsFromFile(file)
  if (!Array.isArray(sections)) {
    return 0
  }
  const parts = sections.map(joinableSection)
  if (parts.includes(null)) {
    return 0
  }
  return bodyStats(Buffer.from(parts.join('\n\n'))).chars
}

export const tokensFromChars = (chars: number | null): number | null => {
  if (chars === null) {
    return null
  }
  return estimatedTokens(chars)
}

export interface EstimatedUsageInput {
  requestFile: string
  responseFile: string
  model: string
  backend: string
  source: string
}

// chars/4 推定は request/response のプロトコルペイロードだけを数え、子ワーカーの
// 実消費（コンテキスト読み込み・ツール往復・思考）を含まない確定的な下限値。
// 「精度が粗い実測近似」と誤読されないよう、根拠を機械可読に明示する
export const estimatedUsage = (input: EstimatedUsageInput): Record<string, unknown> => {
  const inputTokens = tokensFromChars(countSectionChars(input.requestFile))
  const outputTokens = tokensFromChars(countSectionChars(input.responseFile))
  let totalTokens: number | null = null
  if (inputTokens !== null && outputTokens !== null) {
    totalTokens = inputTokens + outputTokens
  }
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cost_usd: null,
    measurement: 'estimated',
    estimation_basis: 'protocol_payload_only',
    source: input.source,
    model: input.model,
    backend: input.backend,
  }
}

const usageOf = (event: Record<string, unknown>): unknown =>
  jqCoalesce(
    event.usage,
    getPath(event, ['message', 'usage']),
    getPath(event, ['response', 'usage']),
    getPath(event, ['event', 'usage']),
    getPath(event, ['data', 'usage']),
    getPath(event, ['payload', 'info', 'total_token_usage']),
    getPath(event, ['payload', 'info', 'last_token_usage'])
  )

interface UsageItem {
  input_tokens: number | null
  cached_input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  cost_usd: number | null
}

const tokenUsage = (usage: Record<string, unknown>): UsageItem => ({
  input_tokens: numberOrNull(
    jqCoalesce(usage.input_tokens, usage.inputTokens, usage.prompt_tokens, usage.promptTokens)
  ),
  cached_input_tokens: numberOrNull(
    jqCoalesce(
      usage.cached_input_tokens,
      usage.cachedInputTokens,
      usage.cache_read_input_tokens,
      usage.cacheReadTokens
    )
  ),
  output_tokens: numberOrNull(
    jqCoalesce(
      usage.output_tokens,
      usage.outputTokens,
      usage.completion_tokens,
      usage.completionTokens
    )
  ),
  total_tokens: numberOrNull(jqCoalesce(usage.total_tokens, usage.totalTokens)),
  cost_usd: numberOrNull(jqCoalesce(usage.total_cost_usd, usage.cost_usd, usage.costUsd)),
})

const hasMeasuredValue = (item: UsageItem): boolean =>
  item.input_tokens !== null ||
  item.output_tokens !== null ||
  item.total_tokens !== null ||
  item.cost_usd !== null

const usageItemFromEvent = (event: Record<string, unknown>): UsageItem | null => {
  const usage = usageOf(event)
  if (!isRecord(usage)) {
    return null
  }
  const item = tokenUsage(usage)
  const eventCost = numberOrNull(jqCoalesce(event.total_cost_usd, event.cost_usd, event.costUsd))
  if (eventCost !== null) {
    item.cost_usd = eventCost
  }
  if (!hasMeasuredValue(item)) {
    return null
  }
  return item
}

const sumOrNull = (left: number | null, right: number | null): number | null => {
  if (left !== null && right !== null) {
    return left + right
  }
  return null
}

export interface UsageContext {
  model: string
  backend: string
  source: string
}

interface OpencodeStepUsage {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  costComplete: boolean
}

interface OpencodeStepParts {
  part: Record<string, unknown>
  tokens: Record<string, unknown>
}

const addSafeInteger = (left: number, right: number): number | null => {
  const sum = left + right
  if (!Number.isSafeInteger(sum) || sum < 0) {
    return null
  }
  return sum
}

const addFiniteNumber = (left: number, right: number): number | null => {
  const sum = left + right
  if (!Number.isFinite(sum) || sum < 0) {
    return null
  }
  return sum
}

const requiredOpencodeToken = (value: unknown): number | null => {
  if (isNonNegativeSafeInteger(value)) {
    return value
  }
  return null
}

const optionalOpencodeToken = (container: unknown, key: string): number | null => {
  if (!isRecord(container) || !Object.hasOwn(container, key)) {
    return 0
  }
  if (isNonNegativeSafeInteger(container[key])) {
    return container[key]
  }
  return null
}

const opencodeCacheTokens = (
  tokens: Record<string, unknown>
): { read: number; write: number } | null => {
  if (!Object.hasOwn(tokens, 'cache')) {
    return { read: 0, write: 0 }
  }
  const { cache } = tokens
  if (!isRecord(cache)) {
    return null
  }
  const read = optionalOpencodeToken(cache, 'read')
  const write = optionalOpencodeToken(cache, 'write')
  if (read === null || write === null) {
    return null
  }
  return { read, write }
}

const opencodeStepCost = (
  part: Record<string, unknown>
): { costUsd: number; costComplete: boolean } => {
  if (!Object.hasOwn(part, 'cost')) {
    return { costUsd: 0, costComplete: false }
  }
  if (isNonNegativeFiniteNumber(part.cost)) {
    return { costUsd: part.cost, costComplete: true }
  }
  return { costUsd: 0, costComplete: false }
}

const optionalOpencodeTokensOf = (
  tokens: Record<string, unknown>
): Omit<OpencodeStepUsage, 'inputTokens' | 'outputTokens' | 'costUsd' | 'costComplete'> | null => {
  const reasoningTokens = optionalOpencodeToken(tokens, 'reasoning')
  const cache = opencodeCacheTokens(tokens)
  if (reasoningTokens === null || cache === null) {
    return null
  }
  return {
    reasoningTokens,
    cacheReadTokens: cache.read,
    cacheWriteTokens: cache.write,
  }
}

const opencodeStepPartsOf = (event: Record<string, unknown>): OpencodeStepParts | null => {
  if (event.type !== 'step_finish') {
    return null
  }
  const part = getPath(event, ['part'])
  const tokens = getPath(part, ['tokens'])
  if (!isRecord(part) || !isRecord(tokens)) {
    return null
  }
  return { part, tokens }
}

const opencodeStepUsageRecord = (
  parts: OpencodeStepParts,
  inputTokens: number,
  outputTokens: number
): OpencodeStepUsage | null => {
  const optional = optionalOpencodeTokensOf(parts.tokens)
  if (optional === null) {
    return null
  }
  return { inputTokens, outputTokens, ...optional, ...opencodeStepCost(parts.part) }
}

const opencodeStepUsageOf = (event: Record<string, unknown>): OpencodeStepUsage | null => {
  const parts = opencodeStepPartsOf(event)
  if (parts === null) {
    return null
  }
  const inputTokens = requiredOpencodeToken(parts.tokens.input)
  const outputTokens = requiredOpencodeToken(parts.tokens.output)
  if (inputTokens === null || outputTokens === null) {
    return null
  }
  return opencodeStepUsageRecord(parts, inputTokens, outputTokens)
}

interface AddedOpencodeTokens {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

const addedOpencodeTokens = (
  accumulator: OpencodeUsageAccumulator,
  step: OpencodeStepUsage
): AddedOpencodeTokens | null => {
  const inputTokens = addSafeInteger(accumulator.inputTokens, step.inputTokens)
  const outputTokens = addSafeInteger(accumulator.outputTokens, step.outputTokens)
  const reasoningTokens = addSafeInteger(accumulator.reasoningTokens, step.reasoningTokens)
  const cacheReadTokens = addSafeInteger(accumulator.cacheReadTokens, step.cacheReadTokens)
  const cacheWriteTokens = addSafeInteger(accumulator.cacheWriteTokens, step.cacheWriteTokens)
  if (
    inputTokens === null ||
    outputTokens === null ||
    reasoningTokens === null ||
    cacheReadTokens === null ||
    cacheWriteTokens === null
  ) {
    return null
  }
  return { inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens }
}

const addOpencodeCost = (accumulator: OpencodeUsageAccumulator, step: OpencodeStepUsage): void => {
  accumulator.costComplete &&= step.costComplete
  if (!accumulator.costComplete) {
    return
  }
  const costUsd = addFiniteNumber(accumulator.costUsd, step.costUsd)
  if (costUsd === null) {
    accumulator.costComplete = false
    return
  }
  accumulator.costUsd = costUsd
}

const addOpencodeStep = (
  accumulator: OpencodeUsageAccumulator,
  step: OpencodeStepUsage
): boolean => {
  const added = addedOpencodeTokens(accumulator, step)
  if (added === null) {
    return false
  }
  Object.assign(accumulator, added)
  addOpencodeCost(accumulator, step)
  accumulator.steps += 1
  return true
}

const opencodeUsageRecord = (
  accumulator: OpencodeUsageAccumulator,
  context: Omit<UsageContext, 'source'>
): Record<string, unknown> | null => {
  const totalTokens = addSafeInteger(accumulator.inputTokens, accumulator.outputTokens)
  if (totalTokens === null) {
    return null
  }
  const usage: Record<string, unknown> = {
    input_tokens: accumulator.inputTokens,
    output_tokens: accumulator.outputTokens,
    total_tokens: totalTokens,
    cached_input_tokens: accumulator.cacheReadTokens,
    cache_write_tokens: accumulator.cacheWriteTokens,
    reasoning_tokens: accumulator.reasoningTokens,
    measurement: 'measured',
    source: 'opencode_step_finish',
    model: context.model,
    backend: context.backend,
  }
  if (accumulator.costComplete) {
    usage.cost_usd = accumulator.costUsd
  }
  return usage
}

const usageFromAccumulator = (
  accumulator: OpencodeCaptureAccumulator,
  context: Omit<UsageContext, 'source'>
): Record<string, unknown> | null => {
  if (accumulator.usageFailed || accumulator.usage.steps === 0) {
    return null
  }
  return opencodeUsageRecord(accumulator.usage, context)
}

const consumeOpencodeTimingEvent = (
  event: Record<string, unknown>,
  accumulator: OpencodeCaptureAccumulator
): void => {
  if (typeof event.type !== 'string' || !OPENCODE_EVENT_TYPES.has(event.type)) {
    return
  }
  accumulator.recognized += 1
  if (event.type === 'tool_use') {
    accumulator.toolUseCount += 1
  }
  if (event.type === 'step_finish') {
    accumulator.stepFinishCount += 1
  }
  if (isUsefulOpencodeEvent(event)) {
    accumulator.firstUseful = true
  }
}

const consumeOpencodeTextEvent = (
  event: Record<string, unknown>,
  accumulator: OpencodeCaptureAccumulator
): void => {
  if (event.type !== 'text') {
    return
  }
  accumulator.sawTextEvent = true
  const text = getPath(event, ['part', 'text'])
  if (typeof text === 'string') {
    accumulator.lastText = text
    return
  }
  accumulator.lastText = null
}

const consumeOpencodeUsageEvent = (
  event: Record<string, unknown>,
  accumulator: OpencodeCaptureAccumulator
): void => {
  if (event.type !== 'step_finish' || accumulator.usageFailed) {
    return
  }
  const step = opencodeStepUsageOf(event)
  if (step === null || !addOpencodeStep(accumulator.usage, step)) {
    accumulator.usageFailed = true
  }
}

const consumeOpencodeCaptureEvent = (
  event: Record<string, unknown>,
  accumulator: OpencodeCaptureAccumulator
): void => {
  consumeOpencodeTimingEvent(event, accumulator)
  consumeOpencodeTextEvent(event, accumulator)
  consumeOpencodeUsageEvent(event, accumulator)
}

opencodeEventConsumer.run = consumeOpencodeCaptureEvent

const opencodeUsageFromEvents = (
  events: readonly Record<string, unknown>[],
  context: Omit<UsageContext, 'source'>
): Record<string, unknown> | null => {
  const accumulator = opencodeCaptureAccumulator()
  for (const event of events) {
    consumeOpencodeCaptureEvent(event, accumulator)
  }
  return usageFromAccumulator(accumulator, context)
}

export const usageFromOpencodeEvents = (
  events: readonly Record<string, unknown>[],
  context: Omit<UsageContext, 'source'>
): Record<string, unknown> | null => opencodeUsageFromEvents(events, context)

export const parseOpencodeUsageEvents = (
  text: string,
  context: Omit<UsageContext, 'source'>
): Record<string, unknown> | null => usageFromOpencodeEvents(parseJsonObjects(text), context)

export const usageFromOpencodeCapture = (
  captureFile: string,
  context: Omit<UsageContext, 'source'>
): Record<string, unknown> | null => {
  const session = advanceOpencodeCaptureSession(captureFile, true)
  if (session === null) {
    return null
  }
  if (session.truncated) {
    return null
  }
  return usageFromAccumulator(session.state.accumulator, context)
}

// JSONL イベント列から最後の measured usage を選ぶ。無ければ null
export const parseUsageEvents = (
  text: string,
  context: UsageContext
): Record<string, unknown> | null => {
  const items: UsageItem[] = []
  for (const event of parseJsonObjects(text)) {
    const item = usageItemFromEvent(event)
    if (item !== null) {
      items.push(item)
    }
  }
  if (items.length === 0) {
    return null
  }
  const last = items[items.length - 1]
  return {
    input_tokens: last.input_tokens,
    cached_input_tokens: last.cached_input_tokens,
    output_tokens: last.output_tokens,
    total_tokens: last.total_tokens ?? sumOrNull(last.input_tokens, last.output_tokens),
    cost_usd: last.cost_usd,
    measurement: 'measured',
    source: context.source,
    model: context.model,
    backend: context.backend,
  }
}

export const usageFromCapture = (
  captureFile: string,
  context: UsageContext
): Record<string, unknown> | null => {
  if (!hasFileContent(captureFile)) {
    return null
  }
  return parseUsageEvents(readFileOrEmpty(captureFile), context)
}

export const usageFromCodexSessions = (
  codexHome: string,
  context: Omit<UsageContext, 'source'>
): Record<string, unknown> | null => {
  const sessionsDir = path.join(codexHome, 'sessions')
  if (!isDirectory(sessionsDir)) {
    return null
  }
  const text = collectJsonlFiles(sessionsDir)
    .map((file) => readFileOrEmpty(file))
    .join('')
  return parseUsageEvents(text, { ...context, source: 'codex_session_jsonl' })
}

interface DevinUsage {
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: null
  cost_usd: number | null
}

const devinFinalMetricsUsage = (metrics: unknown): DevinUsage => ({
  input_tokens: numberOrNull(
    jqCoalesce(getPath(metrics, ['total_prompt_tokens']), getPath(metrics, ['prompt_tokens']))
  ),
  output_tokens: numberOrNull(
    jqCoalesce(
      getPath(metrics, ['total_completion_tokens']),
      getPath(metrics, ['completion_tokens'])
    )
  ),
  total_tokens: null,
  cost_usd: numberOrNull(
    jqCoalesce(getPath(metrics, ['total_cost_usd']), getPath(metrics, ['cost_usd']))
  ),
})

const stepsOf = (parsed: unknown): unknown[] => {
  const stepsValue = jqCoalesce(getPath(parsed, ['steps'])) ?? []
  if (Array.isArray(stepsValue)) {
    return stepsValue
  }
  return []
}

interface DevinAccumulator {
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  found: boolean
}

const accumulateStepMetrics = (accumulator: DevinAccumulator, step: unknown): void => {
  const metrics = jqCoalesce(getPath(step, ['metrics']))
  if (metrics === null) {
    return
  }
  accumulator.inputTokens += numberOrNull(getPath(metrics, ['prompt_tokens'])) ?? 0
  accumulator.outputTokens += numberOrNull(getPath(metrics, ['completion_tokens'])) ?? 0
  accumulator.costUsd ??= numberOrNull(getPath(metrics, ['cost_usd']))
  accumulator.found = true
}

const devinSummedStepUsage = (parsed: unknown): DevinUsage | null => {
  const accumulator: DevinAccumulator = {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    found: false,
  }
  for (const step of stepsOf(parsed)) {
    accumulateStepMetrics(accumulator, step)
  }
  if (!accumulator.found) {
    return null
  }
  return {
    input_tokens: accumulator.inputTokens,
    output_tokens: accumulator.outputTokens,
    total_tokens: null,
    cost_usd: accumulator.costUsd,
  }
}

const devinHasMeasuredValue = (usage: DevinUsage): boolean =>
  usage.input_tokens !== null || usage.output_tokens !== null || usage.cost_usd !== null

const parseJsonFile = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const devinUsageOf = (parsed: unknown): DevinUsage | null => {
  // jq の `if .final_metrics? then ...` は null / false を偽と扱う
  const finalMetrics = jqCoalesce(getPath(parsed, ['final_metrics']))
  if (finalMetrics !== null) {
    return devinFinalMetricsUsage(finalMetrics)
  }
  return devinSummedStepUsage(parsed)
}

export const usageFromDevinExport = (
  exportFile: string,
  context: Omit<UsageContext, 'source'>
): Record<string, unknown> | null => {
  if (!hasFileContent(exportFile)) {
    return null
  }
  const usage = devinUsageOf(parseJsonFile(exportFile))
  if (usage === null || !devinHasMeasuredValue(usage)) {
    return null
  }
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: sumOrNull(usage.input_tokens, usage.output_tokens),
    cost_usd: usage.cost_usd,
    measurement: 'measured',
    source: 'devin_atif_export',
    model: context.model,
    backend: context.backend,
  }
}

const opencodeStepFinishLine = (part: Record<string, unknown>): string =>
  JSON.stringify({ type: 'step_finish', timestamp: 1_787_360_343_099, part })

const opencodeTokens = (input: number, output: number): Record<string, unknown> => ({
  input,
  output,
  total: 9999,
  reasoning: 7,
  cache: { read: 30, write: 2 },
})

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  describe('parseUsageEvents', () => {
    it('takes the last measured item, prefers event-level cost, and sums missing totals', () => {
      const text = [
        '{"usage":{"input_tokens":1,"output_tokens":1}}',
        '{"total_cost_usd":0.5,"usage":{"inputTokens":10,"cacheReadTokens":4,"outputTokens":2}}',
      ].join('\n')
      expect(parseUsageEvents(text, { model: 'm', backend: 'b', source: 's' })).toEqual({
        input_tokens: 10,
        cached_input_tokens: 4,
        output_tokens: 2,
        total_tokens: 12,
        cost_usd: 0.5,
        measurement: 'measured',
        source: 's',
        model: 'm',
        backend: 'b',
      })
    })

    it('returns null when no event carries a measured value', () => {
      expect(
        parseUsageEvents('{"usage":{}}\n{"type":"noise"}', {
          model: 'm',
          backend: 'b',
          source: 's',
        })
      ).toBeNull()
    })
  })

  describe('parseOpencodeUsageEvents', () => {
    const context = { model: 'opencode/provider/model', backend: 'opencode' }

    it('records a single measured step, including a valid zero cost', () => {
      const usage = parseOpencodeUsageEvents(
        opencodeStepFinishLine({ tokens: opencodeTokens(10, 2), cost: 0 }),
        context
      )
      expect(usage).toEqual({
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
        cached_input_tokens: 30,
        cache_write_tokens: 2,
        reasoning_tokens: 7,
        cost_usd: 0,
        measurement: 'measured',
        source: 'opencode_step_finish',
        model: context.model,
        backend: context.backend,
      })
      expect(usage).not.toHaveProperty('cost_usd_estimated')
    })

    it('sums multiple steps and defaults missing cache and reasoning fields to zero', () => {
      const text = [
        opencodeStepFinishLine({ tokens: opencodeTokens(100, 20), cost: 0.25 }),
        'not-json',
        opencodeStepFinishLine({ tokens: { input: 50, output: 5, total: 9999 }, cost: 0.5 }),
      ].join('\n')
      expect(parseOpencodeUsageEvents(text, context)).toEqual({
        input_tokens: 150,
        output_tokens: 25,
        total_tokens: 175,
        cached_input_tokens: 30,
        cache_write_tokens: 2,
        reasoning_tokens: 7,
        cost_usd: 0.75,
        measurement: 'measured',
        source: 'opencode_step_finish',
        model: context.model,
        backend: context.backend,
      })
    })

    it('omits cost when any step has a missing or non-numeric cost', () => {
      const missing = parseOpencodeUsageEvents(
        [
          opencodeStepFinishLine({ tokens: opencodeTokens(10, 2), cost: 0.1 }),
          opencodeStepFinishLine({ tokens: opencodeTokens(5, 1) }),
        ].join('\n'),
        context
      )
      const nonNumeric = parseOpencodeUsageEvents(
        [opencodeStepFinishLine({ tokens: opencodeTokens(10, 2), cost: 'free' })].join('\n'),
        context
      )
      expect(missing).toMatchObject({ measurement: 'measured', total_tokens: 18 })
      expect(nonNumeric).toMatchObject({ measurement: 'measured', total_tokens: 12 })
      expect(missing).not.toHaveProperty('cost_usd')
      expect(nonNumeric).not.toHaveProperty('cost_usd')
      expect(missing).not.toHaveProperty('cost_usd_estimated')
      expect(nonNumeric).not.toHaveProperty('cost_usd_estimated')
    })

    it('returns null when step_finish or its required token fields are absent', () => {
      expect(parseOpencodeUsageEvents('not-json\n{"type":"text"}', context)).toBeNull()
      expect(parseOpencodeUsageEvents(opencodeStepFinishLine({}), context)).toBeNull()
      expect(
        parseOpencodeUsageEvents(opencodeStepFinishLine({ tokens: { input: 1 } }), context)
      ).toBeNull()
    })

    it('rejects negative, fractional, and non-safe-integer required tokens', () => {
      const invalidInput = [
        { input: -1, output: 2 },
        { input: 1.5, output: 2 },
        { input: Number.MAX_SAFE_INTEGER + 1, output: 0 },
      ]
      for (const tokens of invalidInput) {
        expect(
          parseOpencodeUsageEvents(opencodeStepFinishLine({ tokens, cost: 0 }), context)
        ).toBeNull()
      }
    })

    it('falls back when an optional token key is present but invalid', () => {
      const invalidOptional = [
        { input: 1, output: 2, reasoning: -1 },
        { input: 1, output: 2, cache: { read: 1.5 } },
        { input: 1, output: 2, cache: 3 },
      ]
      for (const tokens of invalidOptional) {
        expect(
          parseOpencodeUsageEvents(opencodeStepFinishLine({ tokens, cost: 0 }), context)
        ).toBeNull()
      }
    })

    it('omits cost when a cost is negative, non-finite, or overflows', () => {
      const negative = parseOpencodeUsageEvents(
        opencodeStepFinishLine({ tokens: opencodeTokens(1, 1), cost: -0.1 }),
        context
      )
      const overflow = parseOpencodeUsageEvents(
        [
          opencodeStepFinishLine({ tokens: opencodeTokens(1, 1), cost: 1e308 }),
          opencodeStepFinishLine({ tokens: opencodeTokens(1, 1), cost: 1e308 }),
        ].join('\n'),
        context
      )
      expect(negative).toMatchObject({ measurement: 'measured', total_tokens: 2 })
      expect(overflow).toMatchObject({ measurement: 'measured', total_tokens: 4 })
      expect(negative).not.toHaveProperty('cost_usd')
      expect(overflow).not.toHaveProperty('cost_usd')
    })

    it('fails when summed tokens overflow the safe integer range', () => {
      const text = [
        opencodeStepFinishLine({ tokens: { input: Number.MAX_SAFE_INTEGER, output: 0 }, cost: 0 }),
        opencodeStepFinishLine({ tokens: { input: 1, output: 0 }, cost: 0 }),
      ].join('\n')
      expect(parseOpencodeUsageEvents(text, context)).toBeNull()
    })
  })

  describe('countSectionChars / tokensFromChars', () => {
    it('returns null for a missing file and 0 for malformed protocol JSON', () => {
      expect(countSectionChars('/nonexistent-protocol.json')).toBeNull()
      expect(tokensFromChars(null)).toBeNull()
      expect(tokensFromChars(9)).toBe(3)
    })
  })
}
