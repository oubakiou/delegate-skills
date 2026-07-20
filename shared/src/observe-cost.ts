import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

// 凍結中の bash 版 observe-json.sh の cost 推定関数と同一契約。両実装が並存する間は
// scripts/observe-parity.test.ts が同一入力での等価性を検証する。
// トークン実測は取れるが費用を報告しない backend 向けに、同梱の単価表から換算した
// 概算を実測 cost_usd とは別フィールドで併記する。単価表に該当モデルが無い・単価が
// null の場合はフィールド自体を省略する（null は埋めない）。

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNumber = (value: unknown): value is number => typeof value === 'number'

const hasContent = (file: string): boolean => {
  try {
    return statSync(file).size > 0
  } catch {
    return false
  }
}

// 単価表は shared/ では lib と同階層、各 skill 配布では scripts/ の親に置かれる
export const resolvePricesFile = (libDir: string): string | null => {
  const sameDir = path.join(libDir, 'model-token-prices.json')
  if (hasContent(sameDir)) {
    return sameDir
  }
  const parentDir = path.join(libDir, '..', 'model-token-prices.json')
  if (hasContent(parentDir)) {
    return parentDir
  }
  return null
}

export interface PriceTable {
  models: unknown[]
  aliases: unknown[]
}

const readJsonFile = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export const loadPriceTable = (pricesFile: string): PriceTable | null => {
  const parsed = readJsonFile(pricesFile)
  if (!isRecord(parsed)) {
    return null
  }
  const table: PriceTable = { models: [], aliases: [] }
  if (Array.isArray(parsed.models)) {
    table.models = parsed.models
  }
  if (Array.isArray(parsed.aliases)) {
    table.aliases = parsed.aliases
  }
  return table
}

const PROVIDER_FOR: Readonly<Partial<Record<string, string>>> = {
  codex: 'openai',
  claude: 'anthropic',
  devin: 'cognition',
  cursor: 'cursor',
}

// observe usage の model は backend 固定プレフィックス・@effort suffix 付きの
// documented name（devin-glm-5.2 / gpt-5.5@high 等）だが、単価表は基底 model 名で持つ
const normalizedModel = (model: string, backend: string): string => {
  const base = model.replace(/@.*$/, '')
  if (backend === 'devin' && base.startsWith('devin-')) {
    return base.slice('devin-'.length)
  }
  if (backend === 'cursor' && base.startsWith('cursor-')) {
    return base.slice('cursor-'.length)
  }
  return base
}

const resolveAlias = (name: string, aliases: readonly unknown[]): unknown => {
  for (const alias of aliases) {
    if (isRecord(alias) && alias.alias === name) {
      // jq の // は null / false を fallback に落とす
      const target: unknown = alias.alias_for
      if (target !== null && target !== false && typeof target !== 'undefined') {
        return target
      }
      return name
    }
  }
  return name
}

const matchesFor = (name: string, table: PriceTable): Record<string, unknown>[] => {
  const resolved = resolveAlias(name, table.aliases)
  return table.models.filter(
    (model): model is Record<string, unknown> => isRecord(model) && model.model === resolved
  )
}

const CURSOR_SLUG_PATTERN = /-(?<slug>high|max)$/

// cursor は effort が model slug に載る（-high / -max）ため、完全一致が無い場合に
// 限り suffix を剥がした基底名でも照合する
const candidateNames = (base: string, backend: string): string[] => {
  if (backend === 'cursor' && CURSOR_SLUG_PATTERN.test(base)) {
    return [base, base.replace(CURSOR_SLUG_PATTERN, '')]
  }
  return [base]
}

const selectEntry = (
  usageModel: string,
  backend: string,
  table: PriceTable
): Record<string, unknown> | null => {
  const base = normalizedModel(usageModel, backend)
  let matches: Record<string, unknown>[] = []
  for (const name of candidateNames(base, backend)) {
    const found = matchesFor(name, table)
    if (found.length > 0) {
      matches = found
      break
    }
  }
  const provider = PROVIDER_FOR[backend] ?? null
  const preferred = matches.find((entry) => entry.pricing_source === provider)
  return preferred ?? matches[0] ?? null
}

// jq の `== null` はフィールド欠落も真になる
const isNullish = (value: unknown): boolean => value === null || typeof value === 'undefined'

const isAugmentable = (usage: Record<string, unknown>): boolean =>
  usage.measurement === 'measured' &&
  isNullish(usage.cost_usd) &&
  isNumber(usage.input_tokens) &&
  isNumber(usage.output_tokens)

const pricingSourceLabel = (entry: Record<string, unknown>): string => {
  const source: unknown = entry.pricing_source
  if (typeof source === 'string') {
    return `model-token-prices.json:${source}`
  }
  return 'model-token-prices.json:unknown'
}

interface TokenRates {
  inputTokens: number
  outputTokens: number
  inputRate: number
  outputRate: number
}

const estimateFields = (
  usage: Record<string, unknown>,
  entry: Record<string, unknown>,
  rates: TokenRates
): Record<string, unknown> => {
  const cached: unknown = usage.cached_input_tokens ?? null
  const cachedRate: unknown = entry.cached_input
  if (isNumber(cached) && isNumber(cachedRate) && cached <= rates.inputTokens) {
    return {
      cost_usd_estimated:
        ((rates.inputTokens - cached) * rates.inputRate +
          cached * cachedRate +
          rates.outputTokens * rates.outputRate) /
        1_000_000,
      cost_estimate_basis: 'cached_input_rate_applied',
      pricing_source: pricingSourceLabel(entry),
    }
  }
  return {
    cost_usd_estimated:
      (rates.inputTokens * rates.inputRate + rates.outputTokens * rates.outputRate) / 1_000_000,
    cost_estimate_basis: 'uncached_input_rate_upper_bound',
    pricing_source: pricingSourceLabel(entry),
  }
}

export const augmentCostEstimate = (
  usage: Record<string, unknown>,
  backend: string,
  table: PriceTable | null
): Record<string, unknown> => {
  if (table === null || !isAugmentable(usage) || typeof usage.model !== 'string') {
    return usage
  }
  const entry = selectEntry(usage.model, backend, table)
  if (entry === null) {
    return usage
  }
  const { input_tokens: inputTokens, output_tokens: outputTokens } = usage
  const { input: inputRate, output: outputRate } = entry
  if (
    !isNumber(inputTokens) ||
    !isNumber(outputTokens) ||
    !isNumber(inputRate) ||
    !isNumber(outputRate)
  ) {
    return usage
  }
  return {
    ...usage,
    ...estimateFields(usage, entry, { inputTokens, outputTokens, inputRate, outputRate }),
  }
}

// in-source test 専用 fixture (bundle からは treeshake で除去される)
const makeTestUsage = (extra: Record<string, unknown>): Record<string, unknown> => ({
  input_tokens: 1000,
  output_tokens: 100,
  cost_usd: null,
  measurement: 'measured',
  model: 'gpt-x',
  backend: 'codex',
  ...extra,
})

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  const usage = makeTestUsage
  const table: PriceTable = {
    models: [
      { model: 'gpt-x', pricing_source: 'openai', input: 2, cached_input: 0.5, output: 10 },
      { model: 'gpt-x', pricing_source: 'other', input: 9, output: 99 },
      { model: 'unpriced', pricing_source: 'openai', input: null, output: null },
    ],
    aliases: [{ alias: 'gpt-alias', alias_for: 'gpt-x' }],
  }
  describe('augmentCostEstimate', () => {
    it('prefers the backend provider entry and applies uncached rates', () => {
      const result = augmentCostEstimate(usage({}), 'codex', table)
      expect(result.cost_usd_estimated).toBeCloseTo((1000 * 2 + 100 * 10) / 1_000_000, 12)
      expect(result.cost_estimate_basis).toBe('uncached_input_rate_upper_bound')
      expect(result.pricing_source).toBe('model-token-prices.json:openai')
    })

    it('applies the cached rate only when cached tokens fit within input tokens', () => {
      const cached = augmentCostEstimate(usage({ cached_input_tokens: 600 }), 'codex', table)
      expect(cached.cost_estimate_basis).toBe('cached_input_rate_applied')
      expect(cached.cost_usd_estimated).toBeCloseTo(
        (400 * 2 + 600 * 0.5 + 100 * 10) / 1_000_000,
        12
      )
      const over = augmentCostEstimate(usage({ cached_input_tokens: 5000 }), 'codex', table)
      expect(over.cost_estimate_basis).toBe('uncached_input_rate_upper_bound')
    })

    it('resolves aliases and omits the fields for unpriced or unknown models', () => {
      const aliased = augmentCostEstimate(usage({ model: 'gpt-alias' }), 'codex', table)
      expect(aliased.cost_usd_estimated).toBeCloseTo((1000 * 2 + 100 * 10) / 1_000_000, 12)
      expect(augmentCostEstimate(usage({ model: 'unpriced' }), 'codex', table)).not.toHaveProperty(
        'cost_usd_estimated'
      )
      expect(augmentCostEstimate(usage({ model: 'nope' }), 'codex', table)).not.toHaveProperty(
        'cost_usd_estimated'
      )
    })

    it('leaves estimated or already-costed usage untouched', () => {
      expect(
        augmentCostEstimate(usage({ measurement: 'estimated' }), 'codex', table)
      ).not.toHaveProperty('cost_usd_estimated')
      expect(augmentCostEstimate(usage({ cost_usd: 0.4 }), 'codex', table)).not.toHaveProperty(
        'cost_usd_estimated'
      )
    })
  })
}
