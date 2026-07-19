import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import type { CliResult } from './cli-result.ts'
import type { Env } from './build-request.ts'
import {
  appendMetrics,
  emitForMetrics,
  estimatedTokens,
  metricsTimestamp,
  prettyJson,
  sectionBanner,
  selectedStats,
} from './protocol.ts'
import {
  isCliResult,
  loadProtocolFile,
  pickMeta,
  rawStringField,
  sectionAt,
  selectorOrDefault,
  type ProtocolDoc,
} from './read-request.ts'

// bash 版 read-response.sh と同一契約 (protocol v1)。
// Usage: read-response <response_file> [status|auto|decision|index|meta|all|<N>]
// auto / decision は DELEGATE_RESPONSE_INLINE_MAX (byte, 既定 10240) のサイズゲート。
// exit: 2=引数エラー・JSON 破損・閾値不正 / 1=ファイル不在・selector 不正 / 5=範囲外

const failure = (exitCode: number, stderr: string): CliResult => ({
  exitCode,
  stderr,
  stdout: '',
})

const RESPONSE_META_KEYS = ['protocol_version', 'type', 'status', 'responder_session_id']

const DEFAULT_INLINE_MAX = 10_240

interface SectionEntry {
  key: number
  value: string
}

const entryFor = (doc: ProtocolDoc, name: string): SectionEntry | null => {
  const pattern = new RegExp(`^#+\\s*${name}\\s*$`)
  for (const [key, value] of doc.sections.entries()) {
    if (pattern.test(value.split('\n')[0])) {
      return { key, value }
    }
  }
  return null
}

// jq の $text[:$cap] と同じく code point 単位で切り詰める
const clip = (text: string, cap: number): string => {
  const points = text.match(/./gsu) ?? []
  if (points.length > cap) {
    return `${points.slice(0, cap).join('')}\n…(truncated。全文は <N> で取得)`
  }
  return text
}

const inlineAllOutput = (doc: ProtocolDoc): string =>
  `status: ${rawStringField(doc, 'status')}\n${sectionBanner(doc.sections)}`

const largeHeader = (doc: ProtocolDoc): string =>
  `status: ${rawStringField(doc, 'status')}\n===== index =====\n${rawStringField(doc, 'index')}\n`

const autoLargeOutput = (doc: ProtocolDoc): string => {
  const summary = entryFor(doc, 'Summary')
  if (summary === null) {
    return `${largeHeader(doc)}large response: ${doc.sections.length} sections（Summary section 無し。必要 section のみ <N> で取得）`
  }
  return `${largeHeader(doc)}===== section[${summary.key}] (Summary) =====\n${summary.value}\n（他 section は必要分のみ <N> で取得）`
}

const namedSectionBlock = (doc: ProtocolDoc, name: string, cap: number | null): string => {
  const entry = entryFor(doc, name)
  if (entry === null) {
    return ''
  }
  let text = entry.value
  if (cap !== null) {
    text = clip(entry.value, cap)
  }
  return `===== section[${entry.key}] (${name}) =====\n${text}\n`
}

const decisionLargeOutput = (doc: ProtocolDoc, cap: number): string =>
  `${largeHeader(doc)}${namedSectionBlock(doc, 'Summary', null)}${namedSectionBlock(doc, 'Findings', cap)}${namedSectionBlock(doc, 'Blockers', cap)}（他 section は必要分のみ <N> で取得）`

interface SelectorOutcome {
  raw: string
  inline: boolean
  threshold: number
}

const parseThreshold = (env: Env): number | CliResult => {
  const rawValue = env.DELEGATE_RESPONSE_INLINE_MAX
  if (typeof rawValue !== 'string' || rawValue === '') {
    return DEFAULT_INLINE_MAX
  }
  if (!/^[0-9]+$/.test(rawValue)) {
    // bash 版は数値比較 (test) がここで落ちる
    return failure(2, `ERROR: DELEGATE_RESPONSE_INLINE_MAX が整数ではありません: ${rawValue}\n`)
  }
  return Number(rawValue)
}

const gatedOutput = (
  doc: ProtocolDoc,
  target: { responseFile: string; selector: string },
  env: Env
): SelectorOutcome | CliResult => {
  const threshold = parseThreshold(env)
  if (typeof threshold !== 'number') {
    return threshold
  }
  const { size } = statSync(target.responseFile)
  if (size < threshold) {
    return { raw: inlineAllOutput(doc), inline: true, threshold }
  }
  if (target.selector === 'decision') {
    return { raw: decisionLargeOutput(doc, threshold), inline: false, threshold }
  }
  return { raw: autoLargeOutput(doc), inline: false, threshold }
}

const fixedSelectorOutcome = (doc: ProtocolDoc, selector: string): SelectorOutcome | null => {
  switch (selector) {
    case 'status': {
      return { raw: rawStringField(doc, 'status'), inline: false, threshold: 0 }
    }
    case 'index': {
      return { raw: rawStringField(doc, 'index'), inline: false, threshold: 0 }
    }
    case 'meta': {
      const meta = prettyJson(pickMeta(doc, RESPONSE_META_KEYS)).replace(/\n$/, '')
      return { raw: meta, inline: false, threshold: 0 }
    }
    case 'all': {
      return { raw: sectionBanner(doc.sections), inline: true, threshold: 0 }
    }
    default: {
      return null
    }
  }
}

const numericOutcome = (doc: ProtocolDoc, selector: string): SelectorOutcome | CliResult => {
  const section = sectionAt(doc, Number(selector))
  if (typeof section !== 'string') {
    return section
  }
  return { raw: section, inline: true, threshold: 0 }
}

const plainOutput = (doc: ProtocolDoc, selector: string): SelectorOutcome | CliResult => {
  const fixed = fixedSelectorOutcome(doc, selector)
  if (fixed !== null) {
    return fixed
  }
  if (/^[0-9]+$/.test(selector)) {
    return numericOutcome(doc, selector)
  }
  return failure(
    1,
    `ERROR: 不明な selector: ${selector}（status|auto|decision|index|meta|all|<整数N> のいずれか）\n`
  )
}

const selectResponseOutput = (
  doc: ProtocolDoc,
  target: { responseFile: string; selector: string },
  env: Env
): SelectorOutcome | CliResult => {
  if (target.selector === 'auto' || target.selector === 'decision') {
    return gatedOutput(doc, target, env)
  }
  return plainOutput(doc, target.selector)
}

interface ReadResponseMetricsInput {
  responseFile: string
  selector: string
  doc: ProtocolDoc
  outcome: SelectorOutcome
  durationMs: number
}

const appendReadResponseMetrics = (
  env: Env,
  input: ReadResponseMetricsInput,
  measured: string
): void => {
  const selected = selectedStats(measured)
  const responseBytes = statSync(input.responseFile).size
  appendMetrics(env.DELEGATE_METRICS_FILE, {
    kind: 'read_response',
    ts: metricsTimestamp(),
    duration_ms: input.durationMs,
    selector: input.selector,
    status: rawStringField(input.doc, 'status'),
    response_file: input.responseFile,
    inline: input.outcome.inline,
    threshold: input.outcome.threshold,
    response: {
      bytes: responseBytes,
      sections: input.doc.sections.length,
      estimated_tokens: estimatedTokens(responseBytes),
    },
    selected: {
      bytes: selected.bytes,
      chars: selected.chars,
      lines: selected.lines,
      estimated_tokens: estimatedTokens(selected.chars),
    },
  })
}

const emitResponseOutput = (env: Env, input: ReadResponseMetricsInput): CliResult => {
  const metricsFile = env.DELEGATE_METRICS_FILE
  const metricsEnabled = typeof metricsFile === 'string' && metricsFile !== ''
  const emitted = emitForMetrics(input.outcome.raw, metricsEnabled)
  if (metricsEnabled) {
    appendReadResponseMetrics(env, input, emitted.measured)
  }
  return { exitCode: 0, stderr: '', stdout: emitted.stdout }
}

const resolveOutcome = (
  target: { responseFile: string; selector: string },
  env: Env
): { doc: ProtocolDoc; outcome: SelectorOutcome } | CliResult => {
  const doc = loadProtocolFile(target.responseFile, 'response_file')
  if (isCliResult(doc)) {
    return doc
  }
  const outcome = selectResponseOutput(doc, target, env)
  if ('exitCode' in outcome) {
    return outcome
  }
  return { doc, outcome }
}

export const runReadResponse = (argv: readonly string[], env: Env): CliResult => {
  const startedAt = performance.now()
  if (argv.length < 1) {
    return failure(
      2,
      'Usage: read-response <response_file> [status|auto|decision|index|meta|all|<N>]\n'
    )
  }
  const [responseFile, selectorArg] = argv
  const selector = selectorOrDefault(selectorArg, 'status')
  const resolved = resolveOutcome({ responseFile, selector }, env)
  if ('exitCode' in resolved) {
    return resolved
  }
  return emitResponseOutput(env, {
    responseFile,
    selector,
    doc: resolved.doc,
    outcome: resolved.outcome,
    durationMs: Math.round(performance.now() - startedAt),
  })
}

// in-source test 専用 helper (bundle からは treeshake で除去される)
const writeTestResponseFixture = (sections: string[]): string => {
  mkdirSync('.temp', { recursive: true })
  const file = `.temp/read-response-test-${Math.random().toString(36).slice(2)}.json`
  writeFileSync(
    file,
    JSON.stringify({
      protocol_version: 1,
      type: 'response',
      status: 'completed',
      responder_session_id: 'worker',
      index: '# idx',
      sections,
    })
  )
  return file
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  const writeFixture = writeTestResponseFixture
  describe('runReadResponse', () => {
    it('keeps the exit code table (usage 2 / missing 1 / bad selector 1 / range 5)', () => {
      expect(runReadResponse([], {}).exitCode).toBe(2)
      expect(runReadResponse(['/nonexistent.json'], {}).exitCode).toBe(1)
      const file = writeFixture(['# Summary\n\nok'])
      expect(runReadResponse([file, 'bogus'], {}).exitCode).toBe(1)
      expect(runReadResponse([file, '9'], {}).exitCode).toBe(5)
    })

    it('prints status by default and inlines small responses for auto/decision', () => {
      const file = writeFixture(['# Summary\n\nok'])
      expect(runReadResponse([file], {}).stdout).toBe('completed\n')
      const auto = runReadResponse([file, 'auto'], {})
      expect(auto.stdout).toBe('status: completed\n===== section[0] =====\n# Summary\n\nok\n')
      expect(runReadResponse([file, 'decision'], {}).stdout).toBe(auto.stdout)
    })

    it('returns the Summary section and clipped Findings for large responses', () => {
      const longFindings = `# Findings\n\n${'あ'.repeat(200)}`
      const file = writeFixture(['# Summary\n\n要約', longFindings, '# Blockers\n\nなし'])
      const env = { DELEGATE_RESPONSE_INLINE_MAX: '50' }
      const auto = runReadResponse([file, 'auto'], env)
      expect(auto.stdout).toContain('(Summary) =====\n# Summary\n\n要約')
      expect(auto.stdout).not.toContain('Findings')
      const decision = runReadResponse([file, 'decision'], env)
      expect(decision.stdout).toContain('(Findings)')
      expect(decision.stdout).toContain('…(truncated。全文は <N> で取得)')
      expect(decision.stdout).toContain('(Blockers) =====\n# Blockers\n\nなし')
    })

    it('falls back to the section list line when a large response has no Summary', () => {
      const file = writeFixture([`# Notes\n\n${'x'.repeat(200)}`])
      const result = runReadResponse([file, 'auto'], { DELEGATE_RESPONSE_INLINE_MAX: '50' })
      expect(result.stdout).toContain('large response: 1 sections（Summary section 無し')
    })

    it('fails closed with exit 2 on a non-integer inline threshold', () => {
      const file = writeFixture(['# Summary\n\nok'])
      const result = runReadResponse([file, 'auto'], { DELEGATE_RESPONSE_INLINE_MAX: 'bogus' })
      expect(result.exitCode).toBe(2)
    })
  })
}
