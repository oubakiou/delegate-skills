import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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

// bash 版 read-request.sh と同一契約 (protocol v1)。
// Usage: read-request <request_file> [index|meta|all|<N>]
// exit: 2=引数エラー・JSON 破損 / 1=ファイル不在・selector 不正 / 5=範囲外 (jq error 互換)

const failure = (exitCode: number, stderr: string): CliResult => ({
  exitCode,
  stderr,
  stdout: '',
})

export interface ProtocolDoc {
  raw: Record<string, unknown>
  sections: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readJson = (file: string): { ok: boolean; value: unknown } => {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) }
  } catch {
    return { ok: false, value: null }
  }
}

const sectionsOf = (raw: Record<string, unknown>): string[] => {
  const value: unknown = raw.sections
  if (Array.isArray(value)) {
    return value.map(String)
  }
  return []
}

export const loadProtocolFile = (file: string, label: string): ProtocolDoc | CliResult => {
  if (!existsSync(file)) {
    return failure(1, `ERROR: ${label} が見つかりません: ${file}\n`)
  }
  const parsed = readJson(file)
  if (!parsed.ok) {
    // jq の parse error と同じ exit 2
    return failure(2, `ERROR: ${label} が JSON として読めません: ${file}\n`)
  }
  if (!isRecord(parsed.value)) {
    return failure(2, `ERROR: ${label} が JSON object ではありません: ${file}\n`)
  }
  return { raw: parsed.value, sections: sectionsOf(parsed.value) }
}

export const isCliResult = (value: ProtocolDoc | CliResult): value is CliResult =>
  'exitCode' in value

// jq -r と同じく null は "null" として出力する
export const rawStringField = (doc: ProtocolDoc, key: string): string => {
  const value: unknown = doc.raw[key]
  if (typeof value === 'string') {
    return value
  }
  return JSON.stringify(value ?? null)
}

export const pickMeta = (doc: ProtocolDoc, keys: readonly string[]): Record<string, unknown> => {
  const meta: Record<string, unknown> = {}
  for (const key of keys) {
    meta[key] = doc.raw[key] ?? null
  }
  return meta
}

export const sectionAt = (doc: ProtocolDoc, index: number): string | CliResult => {
  if (index >= 0 && index < doc.sections.length) {
    return doc.sections[index]
  }
  // bash 版は jq の error() 経由で exit 5
  return failure(5, `jq: error: section[${index}] は範囲外\n`)
}

export const selectorOrDefault = (arg: string | undefined, fallback: string): string => {
  if (typeof arg === 'string' && arg !== '') {
    return arg
  }
  return fallback
}

const REQUEST_META_KEYS = [
  'protocol_version',
  'type',
  'task_type',
  'model',
  'task_type_chain',
  'requester_session_id',
]

const selectRequestOutput = (doc: ProtocolDoc, selector: string): string | CliResult => {
  if (selector === 'index') {
    return rawStringField(doc, 'index')
  }
  if (selector === 'meta') {
    return prettyJson(pickMeta(doc, REQUEST_META_KEYS)).replace(/\n$/, '')
  }
  if (selector === 'all') {
    return sectionBanner(doc.sections)
  }
  if (/^[0-9]+$/.test(selector)) {
    return sectionAt(doc, Number(selector))
  }
  return failure(1, `ERROR: 不明な selector: ${selector}（index|meta|all|<整数N> のいずれか）\n`)
}

const appendReadRequestMetrics = (
  env: Env,
  target: { requestFile: string; selector: string; doc: ProtocolDoc },
  measured: string
): void => {
  const selected = selectedStats(measured)
  appendMetrics(env.DELEGATE_METRICS_FILE, {
    kind: 'read_request',
    ts: metricsTimestamp(),
    selector: target.selector,
    task_type: rawStringField(target.doc, 'task_type'),
    request_file: target.requestFile,
    request: {
      bytes: statSync(target.requestFile).size,
      sections: target.doc.sections.length,
    },
    selected: {
      bytes: selected.bytes,
      chars: selected.chars,
      lines: selected.lines,
      estimated_tokens: estimatedTokens(selected.chars),
    },
  })
}

const emitRequestOutput = (
  raw: string,
  env: Env,
  target: { requestFile: string; selector: string; doc: ProtocolDoc }
): CliResult => {
  const metricsFile = env.DELEGATE_METRICS_FILE
  const metricsEnabled = typeof metricsFile === 'string' && metricsFile !== ''
  const emitted = emitForMetrics(raw, metricsEnabled)
  if (metricsEnabled) {
    appendReadRequestMetrics(env, target, emitted.measured)
  }
  return { exitCode: 0, stderr: '', stdout: emitted.stdout }
}

const selectFromFile = (
  requestFile: string,
  selector: string
): { doc: ProtocolDoc; raw: string } | CliResult => {
  const doc = loadProtocolFile(requestFile, 'request_file')
  if (isCliResult(doc)) {
    return doc
  }
  const raw = selectRequestOutput(doc, selector)
  if (typeof raw !== 'string') {
    return raw
  }
  return { doc, raw }
}

export const runReadRequest = (argv: readonly string[], env: Env): CliResult => {
  if (argv.length < 1) {
    return failure(2, 'Usage: read-request <request_file> [index|meta|all|<N>]\n')
  }
  const [requestFile, selectorArg] = argv
  const selector = selectorOrDefault(selectorArg, 'index')
  const selected = selectFromFile(requestFile, selector)
  if ('exitCode' in selected) {
    return selected
  }
  return emitRequestOutput(selected.raw, env, { requestFile, selector, doc: selected.doc })
}

// in-source test 専用 helper (bundle からは treeshake で除去される)
const writeTestRequestFixture = (): string => {
  mkdirSync('.temp', { recursive: true })
  const file = `.temp/read-request-test-${Math.random().toString(36).slice(2)}.json`
  writeFileSync(
    file,
    JSON.stringify({
      protocol_version: 1,
      type: 'request',
      task_type: 'chore',
      model: 'haiku',
      task_type_chain: [],
      requester_session_id: 'sid',
      index: '# 0. Objective',
      sections: ['# Objective\n\nhello'],
    })
  )
  return file
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  const writeFixture = writeTestRequestFixture
  describe('runReadRequest', () => {
    it('keeps the exit code table (usage 2 / missing 1 / bad selector 1 / range 5)', () => {
      expect(runReadRequest([], {}).exitCode).toBe(2)
      expect(runReadRequest(['/nonexistent.json'], {}).exitCode).toBe(1)
      const file = writeFixture()
      expect(runReadRequest([file, 'bogus'], {}).exitCode).toBe(1)
      expect(runReadRequest([file, '9'], {}).exitCode).toBe(5)
    })

    it('selects index by default and sections by number', () => {
      const file = writeFixture()
      expect(runReadRequest([file], {}).stdout).toBe('# 0. Objective\n')
      expect(runReadRequest([file, '0'], {}).stdout).toBe('# Objective\n\nhello\n')
      expect(runReadRequest([file, 'all'], {}).stdout).toBe(
        '===== section[0] =====\n# Objective\n\nhello\n'
      )
    })

    it('emits meta as pretty JSON with null for missing keys', () => {
      const file = writeFixture()
      const result = runReadRequest([file, 'meta'], {})
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        protocol_version: 1,
        type: 'request',
        task_type: 'chore',
        model: 'haiku',
        task_type_chain: [],
        requester_session_id: 'sid',
      })
    })
  })
}
