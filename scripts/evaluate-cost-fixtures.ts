import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

interface FixtureSummary {
  name?: string
  orchestrationEvents?: number
  totals?: {
    mainReadResponseEstimatedTokens?: number
    workerReadRequestEstimatedTokens?: number
  }
}

interface EvaluationRow {
  breakEvenInputRatio: number | null
  mainReadResponse: number
  name: string
  netMainInputSaved: number
  orchestrationEvents: number
  verdict: string
  workerReadRequest: number
}

const tokenValue = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  return 0
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isFixtureSummary = (value: unknown): value is FixtureSummary => isRecord(value)

const totalsFor = (item: FixtureSummary): Record<string, unknown> => {
  const { totals } = item
  if (isRecord(totals)) {
    return totals
  }
  return {}
}

const fixtureName = (item: FixtureSummary, index: number): string => {
  if (typeof item.name === 'string' && item.name.length > 0) {
    return item.name
  }
  return `fixture-${index + 1}`
}

const breakEvenRatio = (workerReadRequest: number, mainReadResponse: number): number | null => {
  const netMainInputSaved = workerReadRequest - mainReadResponse
  if (netMainInputSaved <= 0) {
    return null
  }
  return workerReadRequest / netMainInputSaved
}

const verdictFor = (name: string, workerReadRequest: number, mainReadResponse: number): string => {
  if (name.includes('scriptable')) {
    return 'not-cost-candidate'
  }
  if (workerReadRequest <= mainReadResponse) {
    return 'unlikely'
  }
  if (workerReadRequest >= mainReadResponse * 3) {
    return 'strong-candidate'
  }
  return 'candidate'
}

export const evaluateFixtures = (fixtures: FixtureSummary[]): EvaluationRow[] =>
  fixtures.map((item, index) => {
    const name = fixtureName(item, index)
    const totals = totalsFor(item)
    const workerReadRequest = tokenValue(totals.workerReadRequestEstimatedTokens)
    const mainReadResponse = tokenValue(totals.mainReadResponseEstimatedTokens)
    return {
      breakEvenInputRatio: breakEvenRatio(workerReadRequest, mainReadResponse),
      mainReadResponse,
      name,
      netMainInputSaved: workerReadRequest - mainReadResponse,
      orchestrationEvents: tokenValue(item.orchestrationEvents),
      verdict: verdictFor(name, workerReadRequest, mainReadResponse),
      workerReadRequest,
    }
  })

const parseFixtures = (input: string): FixtureSummary[] => {
  const parsed: unknown = JSON.parse(input)
  if (!Array.isArray(parsed)) {
    throw new Error('Expected fixture summary JSON array')
  }
  const fixtures: FixtureSummary[] = []
  for (const item of parsed) {
    if (!isFixtureSummary(item)) {
      throw new Error('Expected fixture summary JSON objects')
    }
    fixtures.push(item)
  }
  return fixtures
}

const formatRatio = (value: number | null): string => {
  if (value === null) {
    return 'n/a'
  }
  return value.toFixed(2)
}

const pad = (value: string, width: number): string => value.padEnd(width, ' ')

export const renderEvaluation = (rows: EvaluationRow[]): string => {
  const tableRows = rows.map((row) => [
    row.name,
    String(row.workerReadRequest),
    String(row.mainReadResponse),
    String(row.netMainInputSaved),
    formatRatio(row.breakEvenInputRatio),
    String(row.orchestrationEvents),
    row.verdict,
  ])
  const header = [
    'fixture',
    'worker_read',
    'main_response',
    'net_main_saved',
    'min_input_ratio',
    'events',
    'verdict',
  ]
  const widths = header.map((label, column) =>
    Math.max(
      label.length,
      ...tableRows.map((row) => {
        const value = row[column]
        if (value) {
          return value.length
        }
        return 0
      })
    )
  )
  const format = (row: string[]): string =>
    row.map((value, column) => pad(value, widths[column] ?? value.length)).join('  ')
  return [
    format(header),
    format(widths.map((width) => '-'.repeat(width))),
    ...tableRows.map(format),
    '',
    'min_input_ratio is a lower bound that ignores main orchestration output, cache effects, and worker fixed cost.',
    'scriptable fixtures are marked not-cost-candidate because shell-only work has effective avoided main content near zero.',
  ].join('\n')
}

const isDirectRun = (): boolean => {
  const [, entry] = process.argv
  if (!entry) {
    return false
  }
  return import.meta.url === pathToFileURL(entry).href
}

const readInput = (file: string | undefined): string => {
  if (file) {
    return readFileSync(file, 'utf8')
  }
  return readFileSync(0, 'utf8')
}

const writeOutput = (rows: EvaluationRow[], json: boolean): void => {
  if (json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
    return
  }
  process.stdout.write(`${renderEvaluation(rows)}\n`)
}

const runCli = (): void => {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const file = args.find((arg) => arg !== '--json')
  const input = readInput(file)
  const rows = evaluateFixtures(parseFixtures(input))
  writeOutput(rows, json)
}

if (!import.meta.vitest && isDirectRun()) {
  runCli()
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('evaluate cost fixtures', () => {
    it('computes lower-bound break-even ratios', () => {
      const [row] = evaluateFixtures([
        {
          name: 'read-heavy-chore',
          orchestrationEvents: 5,
          totals: {
            mainReadResponseEstimatedTokens: 89,
            workerReadRequestEstimatedTokens: 407,
          },
        },
      ])
      expect(row).toEqual({
        breakEvenInputRatio: 407 / 318,
        mainReadResponse: 89,
        name: 'read-heavy-chore',
        netMainInputSaved: 318,
        orchestrationEvents: 5,
        verdict: 'strong-candidate',
        workerReadRequest: 407,
      })
    })
  })
}
