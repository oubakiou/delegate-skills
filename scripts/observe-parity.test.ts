import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  augmentCostEstimate,
  loadPriceTable,
  resolvePricesFile,
} from '../shared/src/observe-cost.ts'
import {
  effortFromCodexSessions,
  effortFromCursorConfig,
  splitModelEffort,
  validateModelEffort,
} from '../shared/src/observe-effort.ts'

// 凍結中の bash 版 observe-json.sh の pure 関数と TS モジュールを同一入力で
// 突き合わせる等価性検証。bash 版の削除と同時にこのファイルも削除する。

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const makeWorkDir = (): string => {
  const tempRoot = path.join(repoRoot, '.temp')
  mkdirSync(tempRoot, { recursive: true })
  return mkdtempSync(path.join(tempRoot, 'observe-parity-'))
}

const parseJson = (text: string): unknown => JSON.parse(text) as unknown

interface BashResult {
  status: number
  stdout: string
  stderr: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const stringProp = (value: Record<string, unknown>, key: string): string => {
  const raw: unknown = value[key]
  if (typeof raw === 'string') {
    return raw
  }
  return ''
}

const failureToBashResult = (error: unknown): BashResult => {
  const result: BashResult = { status: 1, stdout: '', stderr: '' }
  if (isRecord(error)) {
    if (typeof error.status === 'number') {
      result.status = error.status
    }
    result.stdout = stringProp(error, 'stdout')
    result.stderr = stringProp(error, 'stderr')
  }
  return result
}

const runBashFn = (snippet: string): BashResult => {
  try {
    const stdout = execFileSync(
      'bash',
      ['-c', `set -uo pipefail\nsource shared/observe-json.sh\n${snippet}`],
      { cwd: repoRoot, encoding: 'utf8' }
    )
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return failureToBashResult(error)
  }
}

const CODEX_SESSION_SCENARIOS: [string, string[]][] = [
  ['measured', ['{"type":"turn_context","payload":{"effort":"high"}}']],
  ['renamed-field', ['{"type":"turn_context","payload":{"model_reasoning_effort":"xhigh"}}']],
  ['default', ['{"type":"turn_context","payload":{"model":"gpt-5.5"}}']],
  [
    'last-wins',
    [
      '{"type":"turn_context","payload":{"effort":"low"}}',
      'not-json',
      '{"type":"turn_context","payload":{"reasoning_effort":"medium"}}',
    ],
  ],
  ['no-context', ['{"type":"other"}']],
]

const expectCodexSessionParity = (home: string): void => {
  const bash = runBashFn(`delegate_observe_effort_from_codex_sessions '${home}'`)
  const result = effortFromCodexSessions(home)
  if (result === null) {
    expect(bash.status, home).not.toBe(0)
  } else {
    expect(bash.status, home).toBe(0)
    expect(parseJson(bash.stdout), home).toEqual(result)
  }
}

const CURSOR_CONFIG_FIXTURE = JSON.stringify({
  modelParameters: {
    'glm-5.2': [
      { id: 'reasoning', value: 'high' },
      { id: 'fast', value: 'true' },
    ],
    'grok-4.5': [{ id: 'effort', value: 'low' }],
    'kimi-k2.7-code': [{ id: 'fast', value: false }],
  },
  selectedModel: { modelId: 'composer-2.5', parameters: [{ id: 'effort', value: 'medium' }] },
})

const measuredUsage = (
  model: string,
  backend: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  input_tokens: 12_345,
  output_tokens: 678,
  total_tokens: 13_023,
  cost_usd: null,
  measurement: 'measured',
  source: 'test',
  model,
  backend,
  ...extra,
})

describe('observe effort parity (bash vs TS)', () => {
  it('splits model@effort identically', () => {
    for (const model of [
      'haiku',
      'gpt-5.5@high',
      'cursor-glm-5.2@max',
      'model@',
      '@high',
      'a@b@c',
    ]) {
      const bash = runBashFn(`delegate_observe_split_model_effort '${model}'`)
      expect(bash.status).toBe(0)
      expect(parseJson(bash.stdout)).toEqual(splitModelEffort(model))
    }
  })

  it('validates effort suffixes with identical exit and stderr line', () => {
    const cases: [string, string][] = [
      ['claude', 'haiku'],
      ['claude', 'sonnet@high'],
      ['claude', 'sonnet@bogus'],
      ['codex', 'gpt-5.5@ultra'],
      ['codex', 'gpt-5.5@bogus'],
      ['codex', 'gpt-5.5@hi@gh'],
      ['codex', '@high'],
      ['codex', 'model@'],
      ['cursor', 'cursor-glm-5.2@high'],
      ['cursor', 'cursor-glm-5.2@low'],
      ['cursor', 'cursor-glm-5.2-high@max'],
      ['cursor', 'cursor-grok-4.5@medium'],
      ['cursor', 'cursor-grok-4.5@max'],
      ['cursor', 'composer-2.5@high'],
      ['devin', 'swe-1.7@high'],
      ['grok', 'grok-build@low'],
    ]
    for (const [backend, model] of cases) {
      const bash = runBashFn(`delegate_observe_validate_model_effort '${backend}' '${model}'`)
      const result = validateModelEffort(backend, model)
      if (result.ok) {
        expect(bash.status, `${backend}/${model}`).toBe(0)
      } else {
        expect(bash.status, `${backend}/${model}`).not.toBe(0)
        expect(bash.stderr.trimEnd(), `${backend}/${model}`).toBe(result.message)
      }
    }
  })

  it('extracts codex session effort identically', () => {
    const workDir = makeWorkDir()
    for (const [name, lines] of CODEX_SESSION_SCENARIOS) {
      const home = path.join(workDir, name)
      mkdirSync(path.join(home, 'sessions', 'sub'), { recursive: true })
      writeFileSync(path.join(home, 'sessions', 'sub', 'rollout.jsonl'), `${lines.join('\n')}\n`)
      expectCodexSessionParity(home)
    }
    const missingHome = path.join(workDir, 'missing')
    expect(effortFromCodexSessions(missingHome)).toBeNull()
    expect(
      runBashFn(`delegate_observe_effort_from_codex_sessions '${missingHome}'`).status
    ).not.toBe(0)
  })

  it('extracts cursor effective effort identically', () => {
    const workDir = makeWorkDir()
    const config = path.join(workDir, 'cli-config.json')
    writeFileSync(config, CURSOR_CONFIG_FIXTURE)
    const cases = [
      'glm-5.2',
      'glm-5.2-high',
      'grok-4.5',
      'composer-2.5',
      'kimi-k2.7-code',
      'unknown-model',
    ]
    for (const model of cases) {
      const bash = runBashFn(`delegate_observe_effort_from_cursor_config '${model}' '${config}'`)
      expect(bash.status, model).toBe(0)
      expect(parseJson(bash.stdout), model).toEqual(effortFromCursorConfig(model, config))
    }
  })

  it('extracts the cursor slug effort even without a readable cli-config', () => {
    const missingConfig = path.join(makeWorkDir(), 'nope.json')
    const bashMissing = runBashFn(
      `delegate_observe_effort_from_cursor_config 'glm-5.2-max' '${missingConfig}'`
    )
    expect(parseJson(bashMissing.stdout)).toEqual(
      effortFromCursorConfig('glm-5.2-max', missingConfig)
    )
  })
})

describe('observe cost parity (bash vs TS)', () => {
  const pricesFile = resolvePricesFile(path.join(repoRoot, 'shared'))
  const table = loadPriceTable(pricesFile ?? '')

  const bashAugment = (usage: Record<string, unknown>, backend: string): unknown => {
    const bash = runBashFn(
      `delegate_observe_augment_cost_estimate '${JSON.stringify(usage)}' '${backend}'`
    )
    expect(bash.status).toBe(0)
    return parseJson(bash.stdout)
  }

  it('resolves the same prices file as the bash implementation', () => {
    expect(pricesFile).not.toBeNull()
    expect(table).not.toBeNull()
  })

  it('augments measured usage identically across backends and prefixes', () => {
    const cases: [string, string][] = [
      ['gpt-5.5', 'codex'],
      ['gpt-5.5@high', 'codex'],
      ['devin-glm-5.2', 'devin'],
      ['cursor-glm-5.2-high', 'cursor'],
      ['composer-2.5', 'cursor'],
      ['haiku', 'claude'],
      ['no-such-model', 'codex'],
    ]
    for (const [model, backend] of cases) {
      const usage = measuredUsage(model, backend)
      expect(bashAugment(usage, backend), `${backend}/${model}`).toEqual(
        augmentCostEstimate(usage, backend, table)
      )
    }
  })

  it('applies the cached input rate identically when cached tokens are present', () => {
    const usage = measuredUsage('gpt-5.5', 'codex', { cached_input_tokens: 10_000 })
    expect(bashAugment(usage, 'codex')).toEqual(augmentCostEstimate(usage, 'codex', table))
    const boundary = measuredUsage('gpt-5.5', 'codex', { cached_input_tokens: 12_345 })
    expect(bashAugment(boundary, 'codex')).toEqual(augmentCostEstimate(boundary, 'codex', table))
    const overCached = measuredUsage('gpt-5.5', 'codex', { cached_input_tokens: 99_999 })
    expect(bashAugment(overCached, 'codex')).toEqual(
      augmentCostEstimate(overCached, 'codex', table)
    )
  })

  it('treats a missing cost_usd field like an explicit null, matching jq == null', () => {
    const usage = measuredUsage('gpt-5.5', 'codex')
    // jq の `.cost_usd == null` はフィールド欠落でも真
    const withoutCostField = Object.fromEntries(
      Object.entries(usage).filter(([key]) => key !== 'cost_usd')
    )
    const augmented = augmentCostEstimate(withoutCostField, 'codex', table)
    expect(bashAugment(withoutCostField, 'codex')).toEqual(augmented)
    expect(augmented).toHaveProperty('cost_usd_estimated')
  })

  it('passes estimated usage and measured-cost usage through unchanged', () => {
    const estimated = {
      input_tokens: 10,
      output_tokens: 5,
      cost_usd: null,
      measurement: 'estimated',
      model: 'gpt-5.5',
      backend: 'codex',
    }
    expect(bashAugment(estimated, 'codex')).toEqual(augmentCostEstimate(estimated, 'codex', table))
    const withCost = measuredUsage('gpt-5.5', 'codex', { cost_usd: 0.5 })
    expect(bashAugment(withCost, 'codex')).toEqual(augmentCostEstimate(withCost, 'codex', table))
  })
})
