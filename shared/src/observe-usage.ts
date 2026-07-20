import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  collectJsonlFiles,
  getPath,
  hasFileContent,
  isDirectory,
  isRecord,
  jqCoalesce,
  numberOrNull,
  parseJsonObjects,
  readFileOrEmpty,
} from './jq-compat.ts'
import { bodyStats, estimatedTokens } from './protocol.ts'

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

  describe('countSectionChars / tokensFromChars', () => {
    it('returns null for a missing file and 0 for malformed protocol JSON', () => {
      expect(countSectionChars('/nonexistent-protocol.json')).toBeNull()
      expect(tokensFromChars(null)).toBeNull()
      expect(tokensFromChars(9)).toBe(3)
    })
  })
}
