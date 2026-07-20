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
import { firstUsefulSeen, monotonicMs, timingStreamCounts } from '../shared/src/observe-timing.ts'
import {
  estimatedUsage,
  usageFromCapture,
  usageFromCodexSessions,
  usageFromDevinExport,
} from '../shared/src/observe-usage.ts'

// bash 版 observe-json.sh の pure 関数と TS モジュールを同一入力で突き合わせる
// 等価性検証。bash 実装が存在する限り両者の契約一致を保証する。

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

const CLAUDE_STREAM = [
  '{"type":"system","subtype":"init"}',
  '{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":2},"content":[{"type":"tool_use","name":"Bash"}]}}',
  'not-json',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}',
  '{"type":"result","num_turns":3,"total_cost_usd":0.12,"usage":{"input_tokens":100,"cache_read_input_tokens":40,"output_tokens":25}}',
].join('\n')

const CODEX_STREAM = [
  '{"type":"thread.started"}',
  '{"type":"item.completed","item":{"type":"command_execution"}}',
  '{"type":"item.completed","item":{"type":"reasoning"}}',
  '{"type":"turn.completed","usage":{"input_tokens":50,"cached_input_tokens":10,"output_tokens":5}}',
].join('\n')

const CURSOR_STREAM = [
  '{"type":"system"}',
  '{"type":"tool_call","subtype":"started"}',
  '{"type":"tool_call","subtype":"completed"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
  '{"type":"result","usage":{"inputTokens":30,"outputTokens":7,"cacheReadTokens":3}}',
].join('\n')

const CODEX_SESSION_USAGE = [
  '{"type":"event_msg","payload":{"info":{"total_token_usage":{"input_tokens":9,"output_tokens":1,"total_tokens":10}}}}',
].join('\n')

const writeCapture = (dir: string, name: string, text: string): string => {
  const file = path.join(dir, name)
  writeFileSync(file, `${text}\n`)
  return file
}

const expectCaptureUsageParity = (captureFile: string, source: string): void => {
  const bash = runBashFn(
    `delegate_observe_usage_from_capture '${captureFile}' 'model-x' 'backend-x' '${source}'`
  )
  const result = usageFromCapture(captureFile, { model: 'model-x', backend: 'backend-x', source })
  if (result === null) {
    expect(bash.status, captureFile).not.toBe(0)
  } else {
    expect(bash.status, captureFile).toBe(0)
    expect(parseJson(bash.stdout), captureFile).toEqual(result)
  }
}

describe('observe usage parity (bash vs TS)', () => {
  it('parses stream captures identically across backends', () => {
    const workDir = makeWorkDir()
    expectCaptureUsageParity(
      writeCapture(workDir, 'claude.jsonl', CLAUDE_STREAM),
      'claude_stream_json'
    )
    expectCaptureUsageParity(writeCapture(workDir, 'codex.jsonl', CODEX_STREAM), 'codex_json')
    expectCaptureUsageParity(writeCapture(workDir, 'cursor.jsonl', CURSOR_STREAM), 'cursor_json')
    expectCaptureUsageParity(
      writeCapture(workDir, 'session.jsonl', CODEX_SESSION_USAGE),
      'codex_session_jsonl'
    )
    expectCaptureUsageParity(
      writeCapture(workDir, 'garbage.jsonl', 'plain text\n{"type":"noise"}'),
      'x'
    )
    expectCaptureUsageParity(path.join(workDir, 'missing.jsonl'), 'x')
  })

  it('walks codex session directories identically', () => {
    const home = path.join(makeWorkDir(), 'codex-home')
    mkdirSync(path.join(home, 'sessions', '2026', '07'), { recursive: true })
    writeFileSync(
      path.join(home, 'sessions', '2026', '07', 'rollout.jsonl'),
      `${CODEX_SESSION_USAGE}\n`
    )
    const bash = runBashFn(`delegate_observe_usage_from_codex_sessions '${home}' 'gpt-5.5' 'codex'`)
    expect(bash.status).toBe(0)
    expect(parseJson(bash.stdout)).toEqual(
      usageFromCodexSessions(home, { model: 'gpt-5.5', backend: 'codex' })
    )
  })

  it('extracts devin ATIF usage identically for final metrics and summed steps', () => {
    const workDir = makeWorkDir()
    const cases: [string, unknown][] = [
      [
        'final.json',
        {
          final_metrics: {
            total_prompt_tokens: 100,
            total_completion_tokens: 20,
            total_cost_usd: 0.5,
          },
        },
      ],
      [
        'steps.json',
        {
          steps: [
            { metrics: { prompt_tokens: 10, completion_tokens: 2 } },
            { metrics: { prompt_tokens: 5, completion_tokens: 1, cost_usd: 0.1 } },
            {},
          ],
        },
      ],
      ['no-metrics.json', { steps: [{}, {}] }],
      ['empty-final.json', { final_metrics: {} }],
    ]
    for (const [name, doc] of cases) {
      const file = path.join(workDir, name)
      writeFileSync(file, JSON.stringify(doc))
      const bash = runBashFn(`delegate_observe_usage_from_devin_export '${file}' 'swe-1.7' 'devin'`)
      const result = usageFromDevinExport(file, { model: 'swe-1.7', backend: 'devin' })
      if (result === null) {
        expect(bash.stdout.trim(), name).toBe('')
      } else {
        expect(parseJson(bash.stdout), name).toEqual(result)
      }
    }
  })

  it('degrades malformed or non-string protocol JSON like the bash jq pipeline', () => {
    const workDir = makeWorkDir()
    const responseFile = path.join(workDir, 'missing.json')
    const cases: [string, string][] = [
      ['broken.json', 'not-json{'],
      ['numeric-sections.json', '{"sections":[1,true,null]}'],
      ['nested-sections.json', '{"sections":[["x"]]}'],
      ['string-sections.json', '{"sections":"str"}'],
    ]
    for (const [name, content] of cases) {
      const requestFile = path.join(workDir, name)
      writeFileSync(requestFile, content)
      // 実運用の呼び出し文脈 (errexit 抑制下) と同じ挙動を比較する
      const bash = runBashFn(
        `set +e
delegate_observe_estimated_usage_json '${requestFile}' '${responseFile}' 'haiku' 'claude' 'chars_4'`
      )
      expect(parseJson(bash.stdout), name).toEqual(
        estimatedUsage({
          requestFile,
          responseFile,
          model: 'haiku',
          backend: 'claude',
          source: 'chars_4',
        })
      )
    }
  })

  it('builds the chars/4 estimated usage identically', () => {
    const workDir = makeWorkDir()
    const requestFile = path.join(workDir, 'req.json')
    writeFileSync(
      requestFile,
      JSON.stringify({ sections: ['# Objective\n\n日本語本文', '# Scope\n\nもう一節'] })
    )
    const responseFile = path.join(workDir, 'res.json')
    const bashMissing = runBashFn(
      `delegate_observe_estimated_usage_json '${requestFile}' '${responseFile}' 'haiku' 'claude' 'chars_4'`
    )
    expect(parseJson(bashMissing.stdout)).toEqual(
      estimatedUsage({
        requestFile,
        responseFile,
        model: 'haiku',
        backend: 'claude',
        source: 'chars_4',
      })
    )
    writeFileSync(responseFile, JSON.stringify({ sections: ['# Summary\n\nok'] }))
    const bash = runBashFn(
      `delegate_observe_estimated_usage_json '${requestFile}' '${responseFile}' 'haiku' 'claude' 'chars_4'`
    )
    expect(parseJson(bash.stdout)).toEqual(
      estimatedUsage({
        requestFile,
        responseFile,
        model: 'haiku',
        backend: 'claude',
        source: 'chars_4',
      })
    )
  })
})

const expectFirstUsefulParity = (backend: string, captureFile: string): void => {
  const bash = runBashFn(`delegate_observe_first_useful_seen '${backend}' '${captureFile}'`)
  const seen = firstUsefulSeen(backend, captureFile)
  if (seen) {
    expect(bash.status, `${backend}:${captureFile}`).toBe(0)
  } else {
    expect(bash.status, `${backend}:${captureFile}`).not.toBe(0)
  }
}

describe('observe timing parity (bash vs TS)', () => {
  it('detects the first useful event identically', () => {
    const workDir = makeWorkDir()
    expectFirstUsefulParity('claude', writeCapture(workDir, 'c1.jsonl', CLAUDE_STREAM))
    expectFirstUsefulParity(
      'claude',
      writeCapture(
        workDir,
        'c2.jsonl',
        '{"type":"assistant","message":{"content":[{"type":"text","text":""}]}}'
      )
    )
    expectFirstUsefulParity('codex', writeCapture(workDir, 'x1.jsonl', CODEX_STREAM))
    expectFirstUsefulParity(
      'codex',
      writeCapture(workDir, 'x2.jsonl', '{"type":"item.completed","item":{"type":"reasoning"}}')
    )
    expectFirstUsefulParity('cursor', writeCapture(workDir, 'u1.jsonl', CURSOR_STREAM))
    expectFirstUsefulParity('devin', writeCapture(workDir, 'd1.jsonl', CLAUDE_STREAM))
    expectFirstUsefulParity('claude', path.join(workDir, 'missing.jsonl'))
  })

  it('derives stream counts identically', () => {
    const workDir = makeWorkDir()
    const devinExport = path.join(workDir, 'atif.json')
    writeFileSync(devinExport, JSON.stringify({ steps: [{}, {}, {}] }))
    const cases: [string, string, string][] = [
      ['claude', writeCapture(workDir, 't1.jsonl', CLAUDE_STREAM), ''],
      [
        'claude',
        writeCapture(
          workDir,
          't2.jsonl',
          '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}'
        ),
        '',
      ],
      ['codex', writeCapture(workDir, 't3.jsonl', CODEX_STREAM), ''],
      ['cursor', writeCapture(workDir, 't4.jsonl', CURSOR_STREAM), ''],
      ['devin', writeCapture(workDir, 't5.jsonl', 'text output'), devinExport],
      ['claude', writeCapture(workDir, 't6.jsonl', 'garbage only'), ''],
      ['grok', writeCapture(workDir, 't7.jsonl', CLAUDE_STREAM), ''],
      ['claude', path.join(workDir, 'missing.jsonl'), ''],
    ]
    for (const [backend, capture, exportFile] of cases) {
      const bash = runBashFn(
        `delegate_observe_timing_stream_counts '${backend}' '${capture}' '${exportFile}'`
      )
      expect(bash.status, `${backend}:${capture}`).toBe(0)
      expect(parseJson(bash.stdout), `${backend}:${capture}`).toEqual(
        timingStreamCounts({ backend, stdoutCapture: capture, devinExport: exportFile })
      )
    }
  })

  it('reads a monotonic clock compatible with the bash implementation', () => {
    const bash = runBashFn('delegate_observe_monotonic_ms')
    const bashMs = Number(bash.stdout)
    const tsMs = monotonicMs()
    expect(bash.status).toBe(0)
    expect(tsMs).not.toBeNull()
    expect(Math.abs((tsMs ?? 0) - bashMs)).toBeLessThan(2000)
  })
})
