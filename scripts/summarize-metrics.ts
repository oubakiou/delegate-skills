import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

interface MetricRecord {
  backend?: string
  body?: TokenShape
  duration_ms?: number | null
  inline?: boolean
  kind?: string
  model?: string
  model_turns?: number | null
  report_ready_at_ms?: number | null
  request?: TokenShape
  response?: TokenShape
  selected?: TokenShape
  selector?: string
  structured_output_parse?: boolean | null
  time_to_first_useful_event_ms?: number | null
  tool_calls?: number | null
}

interface TokenShape {
  bytes?: number
  estimated_tokens?: number
}

interface DurationStats {
  excluded: number
  p50: number | null
  p95: number | null
  samples: number
}

interface ParseCounts {
  false: number
  null: number
  true: number
}

interface DispatchGroupSummary {
  count: number
  durationMs: DurationStats
  modelTurns: DurationStats
  parseFailureRate: number | null
  reportReadyAtMs: DurationStats
  structuredOutputParse: ParseCounts
  timeToFirstUsefulEventMs: DurationStats
  toolCalls: DurationStats
}

interface KindSummary {
  bodyEstimatedTokens: number
  count: number
  requestEstimatedTokens: number
  responseEstimatedTokens: number
  selectedEstimatedTokens: number
}

interface Summary {
  byKind: Record<string, KindSummary>
  dispatchByBackendModel: Record<string, DispatchGroupSummary>
  inline: {
    false: number
    true: number
  }
  orchestrationEvents: number
  phaseDurations: Record<string, DurationStats>
  records: number
  selectors: Record<string, number>
  totals: {
    bodyEstimatedTokens: number
    mainReadResponseEstimatedTokens: number
    requestEstimatedTokens: number
    responseEstimatedTokens: number
    selectedEstimatedTokens: number
    workerReadRequestEstimatedTokens: number
  }
}

interface TokenValues {
  body: number
  request: number
  response: number
  selected: number
}

const emptyKindSummary = (): KindSummary => ({
  bodyEstimatedTokens: 0,
  count: 0,
  requestEstimatedTokens: 0,
  responseEstimatedTokens: 0,
  selectedEstimatedTokens: 0,
})

const emptySummary = (records: MetricRecord[]): Summary => ({
  byKind: {},
  dispatchByBackendModel: {},
  inline: {
    false: 0,
    true: 0,
  },
  orchestrationEvents: records.length,
  phaseDurations: {},
  records: records.length,
  selectors: {},
  totals: {
    bodyEstimatedTokens: 0,
    mainReadResponseEstimatedTokens: 0,
    requestEstimatedTokens: 0,
    responseEstimatedTokens: 0,
    selectedEstimatedTokens: 0,
    workerReadRequestEstimatedTokens: 0,
  },
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isMetricRecord = (value: unknown): value is MetricRecord => isRecord(value)

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

const tokenValue = (shape: TokenShape | undefined): number => {
  if (!shape) {
    return 0
  }
  const estimatedTokens = shape.estimated_tokens
  if (typeof estimatedTokens === 'number' && Number.isFinite(estimatedTokens)) {
    return estimatedTokens
  }
  const { bytes } = shape
  if (typeof bytes === 'number' && Number.isFinite(bytes)) {
    return Math.floor((bytes + 3) / 4)
  }
  return 0
}

const parseMetricLine = (line: string, index: number): MetricRecord => {
  try {
    const parsed: unknown = JSON.parse(line)
    if (!isMetricRecord(parsed)) {
      throw new Error('line is not a JSON object')
    }
    return parsed
  } catch (error) {
    throw new Error(`Invalid JSONL at line ${index + 1}: ${errorMessage(error)}`, {
      cause: error,
    })
  }
}

export const parseJsonl = (input: string): MetricRecord[] => {
  const records: MetricRecord[] = []
  const lines = input.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (trimmed.length > 0) {
      records.push(parseMetricLine(trimmed, index))
    }
  }
  return records
}

const kindFor = (record: MetricRecord): string => {
  if (typeof record.kind === 'string') {
    return record.kind
  }
  return 'unknown'
}

const kindSummaryFor = (summary: Summary, kind: string): KindSummary => {
  const existing = summary.byKind[kind]
  if (existing) {
    return existing
  }
  const created = emptyKindSummary()
  summary.byKind[kind] = created
  return created
}

const tokenValuesFor = (record: MetricRecord): TokenValues => ({
  body: tokenValue(record.body),
  request: tokenValue(record.request),
  response: tokenValue(record.response),
  selected: tokenValue(record.selected),
})

const addKindTokenTotals = (kindSummary: KindSummary, tokens: TokenValues): void => {
  kindSummary.bodyEstimatedTokens += tokens.body
  kindSummary.requestEstimatedTokens += tokens.request
  kindSummary.responseEstimatedTokens += tokens.response
  kindSummary.selectedEstimatedTokens += tokens.selected
}

const addSummaryTokenTotals = (summary: Summary, tokens: TokenValues): void => {
  summary.totals.bodyEstimatedTokens += tokens.body
  summary.totals.requestEstimatedTokens += tokens.request
  summary.totals.responseEstimatedTokens += tokens.response
  summary.totals.selectedEstimatedTokens += tokens.selected
}

const addTokenTotals = (summary: Summary, kindSummary: KindSummary, record: MetricRecord): void => {
  const tokens = tokenValuesFor(record)
  addKindTokenTotals(kindSummary, tokens)
  addSummaryTokenTotals(summary, tokens)
}

const addProxyTotals = (summary: Summary, kind: string, record: MetricRecord): void => {
  if (kind === 'read_request') {
    summary.totals.workerReadRequestEstimatedTokens += tokenValue(record.selected)
  }
  if (kind === 'read_response') {
    summary.totals.mainReadResponseEstimatedTokens += tokenValue(record.selected)
  }
}

const addSelector = (summary: Summary, record: MetricRecord): void => {
  if (typeof record.selector === 'string') {
    summary.selectors[record.selector] = (summary.selectors[record.selector] ?? 0) + 1
  }
}

const addInline = (summary: Summary, record: MetricRecord): void => {
  if (record.inline === true) {
    summary.inline.true += 1
  } else if (record.inline === false) {
    summary.inline.false += 1
  }
}

// p50/p95 は nearest-rank。null（計測不能）は分母から除外し、除外数を併記する。
// p95 は少サンプルで tail がノイズになるため最低 20 サンプル未満は null にする
const P95_MIN_SAMPLES = 20

// 親側フェーズ wall time を duration_ms で持つ record 種別
const PHASE_KINDS = new Set(['prepare', 'dispatch', 'read_response'])

const percentileNearestRank = (sorted: number[], quantile: number): number | null => {
  if (sorted.length === 0) {
    return null
  }
  const rank = Math.max(1, Math.ceil(quantile * sorted.length))
  return sorted[rank - 1] ?? null
}

const p95For = (sorted: number[]): number | null => {
  if (sorted.length < P95_MIN_SAMPLES) {
    return null
  }
  return percentileNearestRank(sorted, 0.95)
}

const durationStats = (values: (number | null | undefined)[]): DurationStats => {
  const present = values.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  )
  const sorted = present.toSorted((left, right) => left - right)
  return {
    excluded: values.length - sorted.length,
    p50: percentileNearestRank(sorted, 0.5),
    p95: p95For(sorted),
    samples: sorted.length,
  }
}

const addParseCount = (parse: ParseCounts, value: boolean | null | undefined): void => {
  if (value === true) {
    parse.true += 1
    return
  }
  if (value === false) {
    parse.false += 1
    return
  }
  parse.null += 1
}

const parseCountsFor = (group: MetricRecord[]): ParseCounts => {
  const parse: ParseCounts = { false: 0, null: 0, true: 0 }
  for (const record of group) {
    addParseCount(parse, record.structured_output_parse)
  }
  return parse
}

const parseFailureRateFor = (parse: ParseCounts): number | null => {
  const attempts = parse.true + parse.false
  if (attempts === 0) {
    return null
  }
  return parse.false / attempts
}

const dispatchGroupSummary = (group: MetricRecord[]): DispatchGroupSummary => {
  const parse = parseCountsFor(group)
  return {
    count: group.length,
    durationMs: durationStats(group.map((record) => record.duration_ms)),
    modelTurns: durationStats(group.map((record) => record.model_turns)),
    parseFailureRate: parseFailureRateFor(parse),
    reportReadyAtMs: durationStats(group.map((record) => record.report_ready_at_ms)),
    structuredOutputParse: parse,
    timeToFirstUsefulEventMs: durationStats(
      group.map((record) => record.time_to_first_useful_event_ms)
    ),
    toolCalls: durationStats(group.map((record) => record.tool_calls)),
  }
}

interface DurationCollectors {
  dispatchGroups: Map<string, MetricRecord[]>
  phaseDurationValues: Map<string, (number | null | undefined)[]>
}

const addPhaseDuration = (
  collectors: DurationCollectors,
  kind: string,
  record: MetricRecord
): void => {
  if (!PHASE_KINDS.has(kind)) {
    return
  }
  const values = collectors.phaseDurationValues.get(kind) ?? []
  values.push(record.duration_ms)
  collectors.phaseDurationValues.set(kind, values)
}

const addDispatchGroup = (
  collectors: DurationCollectors,
  kind: string,
  record: MetricRecord
): void => {
  if (kind !== 'dispatch') {
    return
  }
  const key = `${record.backend ?? 'unknown'}/${record.model ?? 'unknown'}`
  const group = collectors.dispatchGroups.get(key) ?? []
  group.push(record)
  collectors.dispatchGroups.set(key, group)
}

const addRecord = (
  summary: Summary,
  collectors: DurationCollectors,
  record: MetricRecord
): void => {
  const kind = kindFor(record)
  const kindSummary = kindSummaryFor(summary, kind)
  kindSummary.count += 1
  addTokenTotals(summary, kindSummary, record)
  addProxyTotals(summary, kind, record)
  addSelector(summary, record)
  addInline(summary, record)
  addPhaseDuration(collectors, kind, record)
  addDispatchGroup(collectors, kind, record)
}

export const summarize = (records: MetricRecord[]): Summary => {
  const summary = emptySummary(records)
  const collectors: DurationCollectors = {
    dispatchGroups: new Map(),
    phaseDurationValues: new Map(),
  }
  for (const record of records) {
    addRecord(summary, collectors, record)
  }
  for (const [kind, values] of collectors.phaseDurationValues) {
    summary.phaseDurations[kind] = durationStats(values)
  }
  for (const [key, group] of collectors.dispatchGroups) {
    summary.dispatchByBackendModel[key] = dispatchGroupSummary(group)
  }
  return summary
}

const pad = (value: string, width: number): string => value.padEnd(width, ' ')

const formatColumns = (header: string[], rows: string[][]): string => {
  const widths = header.map((label, column) =>
    Math.max(
      label.length,
      ...rows.map((row) => {
        const value = row[column]
        if (value) {
          return value.length
        }
        return 0
      })
    )
  )
  const format = (row: string[]): string =>
    row
      .map((value, column) => {
        const width = widths[column]
        if (width) {
          return pad(value, width)
        }
        return value
      })
      .join('  ')
  return [
    format(header),
    format(widths.map((width) => '-'.repeat(width))),
    ...rows.map(format),
  ].join('\n')
}

const renderTable = (summary: Summary): string => {
  const rows = Object.entries(summary.byKind)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([kind, item]) => [
      kind,
      String(item.count),
      String(item.bodyEstimatedTokens),
      String(item.selectedEstimatedTokens),
      String(item.requestEstimatedTokens),
      String(item.responseEstimatedTokens),
    ])
  const header = ['kind', 'count', 'body_tok', 'selected_tok', 'request_tok', 'response_tok']
  return formatColumns(header, rows)
}

const formatStat = (value: number | null): string => {
  if (value === null) {
    return '-'
  }
  return String(value)
}

const formatRate = (value: number | null): string => {
  if (value === null) {
    return '-'
  }
  return value.toFixed(2)
}

const renderDispatchTable = (summary: Summary): string => {
  const rows = Object.entries(summary.dispatchByBackendModel)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [
      key,
      String(item.count),
      formatStat(item.durationMs.p50),
      formatStat(item.durationMs.p95),
      formatStat(item.timeToFirstUsefulEventMs.p50),
      formatStat(item.reportReadyAtMs.p50),
      formatStat(item.modelTurns.p50),
      formatStat(item.toolCalls.p50),
      formatRate(item.parseFailureRate),
    ])
  const header = [
    'dispatch backend/model',
    'count',
    'dur_p50_ms',
    'dur_p95_ms',
    'ttfue_p50_ms',
    'report_p50_ms',
    'turns_p50',
    'tools_p50',
    'parse_fail',
  ]
  return formatColumns(header, rows)
}

const renderPhaseDurations = (summary: Summary): string => {
  const parts = Object.entries(summary.phaseDurations)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(
      ([kind, stats]) =>
        `${kind}=${formatStat(stats.p50)}(n=${stats.samples},excluded=${stats.excluded})`
    )
  return `phase_duration_p50_ms: ${parts.join(' ')}`
}

export const renderHuman = (summary: Summary): string => {
  const lines = [
    `records: ${summary.records}`,
    `orchestration_events: ${summary.orchestrationEvents}`,
    `worker_read_request_estimated_tokens: ${summary.totals.workerReadRequestEstimatedTokens}`,
    `main_read_response_estimated_tokens: ${summary.totals.mainReadResponseEstimatedTokens}`,
    `inline_true: ${summary.inline.true}`,
    `inline_false: ${summary.inline.false}`,
    '',
    renderTable(summary),
  ]
  if (Object.keys(summary.phaseDurations).length > 0) {
    lines.push('', renderPhaseDurations(summary))
  }
  if (Object.keys(summary.dispatchByBackendModel).length > 0) {
    lines.push('', renderDispatchTable(summary))
  }
  if (Object.keys(summary.selectors).length > 0) {
    lines.push('', `selectors: ${JSON.stringify(summary.selectors)}`)
  }
  return lines.join('\n')
}

const isDirectRun = (): boolean => {
  const [, entry] = process.argv
  if (!entry) {
    return false
  }
  return import.meta.url === pathToFileURL(entry).href
}

const runCli = (): void => {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const file = args.find((arg) => arg !== '--json')
  if (!file) {
    throw new Error('Usage: node scripts/summarize-metrics.ts [--json] <metrics.jsonl>')
  }
  const summary = summarize(parseJsonl(readFileSync(file, 'utf8')))
  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  } else {
    process.stdout.write(`${renderHuman(summary)}\n`)
  }
}

if (!import.meta.vitest && isDirectRun()) {
  runCli()
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('summarize metrics', () => {
    it('aggregates proxy token totals and selectors', () => {
      const records = parseJsonl(`
{"kind":"read_request","selector":"all","selected":{"estimated_tokens":10}}
{"kind":"read_response","selector":"auto","inline":true,"response":{"estimated_tokens":7},"selected":{"estimated_tokens":4}}
{"kind":"build_request","body":{"estimated_tokens":3},"request":{"bytes":17}}
`)
      const summary = summarize(records)
      expect(summary.records).toBe(3)
      expect(summary.totals.workerReadRequestEstimatedTokens).toBe(10)
      expect(summary.totals.mainReadResponseEstimatedTokens).toBe(4)
      expect(summary.selectors).toEqual({ all: 1, auto: 1 })
      expect(summary.inline.true).toBe(1)
      expect(summary.phaseDurations.read_response).toEqual({
        excluded: 1,
        p50: null,
        p95: null,
        samples: 0,
      })
      expect(summary.byKind.build_request).toEqual({
        bodyEstimatedTokens: 3,
        count: 1,
        requestEstimatedTokens: 5,
        responseEstimatedTokens: 0,
        selectedEstimatedTokens: 0,
      })
    })

    const expectCodexDispatchGroup = (codex: DispatchGroupSummary): void => {
      expect(codex.count).toBe(2)
      expect(codex.durationMs).toEqual({ excluded: 0, p50: 1200, p95: null, samples: 2 })
      expect(codex.modelTurns).toEqual({ excluded: 1, p50: 3, p95: null, samples: 1 })
      expect(codex.timeToFirstUsefulEventMs.excluded).toBe(1)
      expect(codex.structuredOutputParse).toEqual({ false: 0, null: 2, true: 0 })
      expect(codex.parseFailureRate).toBeNull()
    }

    it('aggregates dispatch records per backend/model with null exclusion', () => {
      const summary = summarize(
        parseJsonl(`
{"kind":"dispatch","backend":"codex","model":"gpt-5.5","duration_ms":1200,"model_turns":3,"tool_calls":2,"time_to_first_useful_event_ms":900,"report_ready_at_ms":1100,"structured_output_parse":null,"measurement_source":"codex_json"}
{"kind":"dispatch","backend":"codex","model":"gpt-5.5","duration_ms":1800,"model_turns":null,"tool_calls":4,"time_to_first_useful_event_ms":null,"report_ready_at_ms":null,"structured_output_parse":null,"measurement_source":"codex_json"}
{"kind":"dispatch","backend":"claude","model":"haiku","duration_ms":600,"model_turns":2,"tool_calls":1,"time_to_first_useful_event_ms":300,"report_ready_at_ms":500,"structured_output_parse":null,"measurement_source":"claude_stream_json"}
`)
      )
      expectCodexDispatchGroup(summary.dispatchByBackendModel['codex/gpt-5.5'])
      expect(summary.dispatchByBackendModel['claude/haiku'].count).toBe(1)
      expect(summary.phaseDurations.dispatch).toEqual({
        excluded: 0,
        p50: 1200,
        p95: null,
        samples: 3,
      })
    })

    it('reports p95 only at 20 or more samples and counts parse failures', () => {
      const lines = Array.from({ length: 20 }, (_unused, index) => {
        const duration = (index + 1) * 100
        return `{"kind":"dispatch","backend":"claude","model":"haiku","duration_ms":${duration},"structured_output_parse":${String(index !== 0)}}`
      }).join('\n')
      const group = summarize(parseJsonl(lines)).dispatchByBackendModel['claude/haiku']
      expect(group.durationMs).toEqual({ excluded: 0, p50: 1000, p95: 1900, samples: 20 })
      expect(group.structuredOutputParse).toEqual({ false: 1, null: 0, true: 19 })
      expect(group.parseFailureRate).toBeCloseTo(0.05, 10)

      const below = summarize(parseJsonl(lines.split('\n').slice(0, 19).join('\n')))
      expect(below.dispatchByBackendModel['claude/haiku'].durationMs.p95).toBeNull()
      expect(below.dispatchByBackendModel['claude/haiku'].durationMs.p50).toBe(1000)
    })
  })
}
