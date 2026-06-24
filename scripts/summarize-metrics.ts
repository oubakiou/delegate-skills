import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

interface MetricRecord {
  body?: TokenShape
  inline?: boolean
  kind?: string
  request?: TokenShape
  response?: TokenShape
  selected?: TokenShape
  selector?: string
}

interface TokenShape {
  bytes?: number
  estimated_tokens?: number
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
  inline: {
    false: number
    true: number
  }
  orchestrationEvents: number
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
  inline: {
    false: 0,
    true: 0,
  },
  orchestrationEvents: records.length,
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

export const summarize = (records: MetricRecord[]): Summary => {
  const summary = emptySummary(records)
  for (const record of records) {
    const kind = kindFor(record)
    const kindSummary = kindSummaryFor(summary, kind)
    kindSummary.count += 1
    addTokenTotals(summary, kindSummary, record)
    addProxyTotals(summary, kind, record)
    addSelector(summary, record)
    addInline(summary, record)
  }
  return summary
}

const pad = (value: string, width: number): string => value.padEnd(width, ' ')

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
      expect(summary.byKind.build_request).toEqual({
        bodyEstimatedTokens: 3,
        count: 1,
        requestEstimatedTokens: 5,
        responseEstimatedTokens: 0,
        selectedEstimatedTokens: 0,
      })
    })
  })
}
