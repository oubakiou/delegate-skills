import { readFileSync } from 'node:fs'
import {
  getPath,
  hasFileContent,
  isRecord,
  numberOrNull,
  parseJsonObjects,
  readFileOrEmpty,
} from './jq-compat.ts'

// bash 版 observe-json.sh の timing 系関数と同一契約
// (等価性は scripts/observe-parity.test.ts が bash 実装との突き合わせで検証する)。

// /proc/uptime 由来の monotonic ms。読めない環境 (macOS 等) は null を返し、
// 呼び出し側が timing フィールドを null に倒す
const uptimeToMs = (uptime: string): number => {
  const [secText] = uptime.split('.')
  let frac = ''
  if (uptime.includes('.')) {
    frac = uptime.slice(uptime.indexOf('.') + 1)
  }
  const fracHundredths = `${frac}00`.slice(0, 2)
  return Number(secText) * 1000 + Number(fracHundredths) * 10
}

export const monotonicMs = (): number | null => {
  try {
    const [firstField] = readFileSync('/proc/uptime', 'utf8').split(/\s/)
    return uptimeToMs(firstField)
  } catch {
    return null
  }
}

export const elapsedMs = (startMs: number | null): number | null => {
  const nowMs = monotonicMs()
  if (startMs === null || nowMs === null) {
    return null
  }
  return nowMs - startMs
}

const textLength = (value: unknown): number => {
  if (typeof value === 'string') {
    return value.length
  }
  return 0
}

const contentItemsOf = (event: Record<string, unknown>): unknown[] => {
  const content = getPath(event, ['message', 'content'])
  if (Array.isArray(content)) {
    return content
  }
  return []
}

const isUsefulClaudeContent = (item: unknown): boolean => {
  if (!isRecord(item)) {
    return false
  }
  if (item.type === 'tool_use') {
    return true
  }
  return item.type === 'text' && textLength(item.text) > 0
}

const claudeFirstUseful = (events: Record<string, unknown>[]): boolean =>
  events.some(
    (event) => event.type === 'assistant' && contentItemsOf(event).some(isUsefulClaudeContent)
  )

const CODEX_TOOL_ITEM_TYPES = new Set([
  'command_execution',
  'local_shell_call',
  'file_change',
  'patch_apply',
  'mcp_tool_call',
  'web_search',
])

const isUsefulCodexItem = (event: Record<string, unknown>): boolean => {
  if (typeof event.type !== 'string' || !event.type.startsWith('item.')) {
    return false
  }
  const itemType = getPath(event, ['item', 'type'])
  if (typeof itemType !== 'string') {
    return false
  }
  if (CODEX_TOOL_ITEM_TYPES.has(itemType)) {
    return true
  }
  return itemType === 'agent_message' && textLength(getPath(event, ['item', 'text'])) > 0
}

const cursorHasTextContent = (event: Record<string, unknown>): boolean => {
  const content = getPath(event, ['message', 'content'])
  if (typeof content === 'string') {
    return content.length > 0
  }
  if (Array.isArray(content)) {
    return content.some(
      (item) => isRecord(item) && item.type === 'text' && textLength(item.text) > 0
    )
  }
  return false
}

const isUsefulCursorEvent = (event: Record<string, unknown>): boolean => {
  if (event.type === 'tool_call' && event.subtype === 'started') {
    return true
  }
  return event.type === 'assistant' && cursorHasTextContent(event)
}

// 「最初の有用イベント」= 最初の tool 実行または本文 delta。event type の文字列一致
// だけだと空 assistant・reasoning-only の行でも確定して系統的に短い値を記録するため、
// stream の構造まで見て判定する。非対応 backend（text 出力の devin / grok）は false
export const firstUsefulSeen = (backend: string, stdoutCapture: string): boolean => {
  if (!hasFileContent(stdoutCapture)) {
    return false
  }
  const events = parseJsonObjects(readFileOrEmpty(stdoutCapture))
  if (backend === 'claude') {
    return claudeFirstUseful(events)
  }
  if (backend === 'codex') {
    return events.some(isUsefulCodexItem)
  }
  if (backend === 'cursor') {
    return events.some(isUsefulCursorEvent)
  }
  return false
}

export interface StreamCounts {
  model_turns: number | null
  tool_calls: number | null
  source: string
}

const UNAVAILABLE: StreamCounts = { model_turns: null, tool_calls: null, source: 'unavailable' }

const typedEvents = (text: string): Record<string, unknown>[] =>
  parseJsonObjects(text).filter((event) => typeof event.type === 'string')

const claudeStreamCounts = (text: string): StreamCounts | null => {
  const events = typedEvents(text)
  if (events.length === 0) {
    return null
  }
  const assistants = events.filter((event) => event.type === 'assistant')
  const numTurnsValues = events
    .filter((event) => event.type === 'result')
    .map((event) => numberOrNull(event.num_turns))
    .filter((value) => value !== null)
  const toolCalls = assistants
    .flatMap(contentItemsOf)
    .filter((item) => isRecord(item) && item.type === 'tool_use').length
  let modelTurns: number | null = numTurnsValues[numTurnsValues.length - 1] ?? null
  if (modelTurns === null && assistants.length > 0) {
    modelTurns = assistants.length
  }
  return { model_turns: modelTurns, tool_calls: toolCalls, source: 'claude_stream_json' }
}

const isCodexEventType = (type: string): boolean =>
  type.startsWith('thread.') ||
  type.startsWith('turn.') ||
  type.startsWith('item.') ||
  type === 'error'

const codexStreamCounts = (text: string): StreamCounts | null => {
  const events = typedEvents(text).filter((event) => isCodexEventType(String(event.type)))
  if (events.length === 0) {
    return null
  }
  const turns = events.filter((event) => event.type === 'turn.completed').length
  const toolCalls = events.filter((event) => {
    if (event.type !== 'item.completed') {
      return false
    }
    const itemType = getPath(event, ['item', 'type'])
    return typeof itemType === 'string' && CODEX_TOOL_ITEM_TYPES.has(itemType)
  }).length
  let modelTurns: number | null = null
  if (turns > 0) {
    modelTurns = turns
  }
  return { model_turns: modelTurns, tool_calls: toolCalls, source: 'codex_json' }
}

const CURSOR_EVENT_TYPES = new Set(['system', 'user', 'assistant', 'tool_call', 'result'])

const cursorStreamCounts = (text: string): StreamCounts | null => {
  const events = typedEvents(text).filter((event) => CURSOR_EVENT_TYPES.has(String(event.type)))
  if (events.length === 0) {
    return null
  }
  const toolCalls = events.filter(
    (event) => event.type === 'tool_call' && event.subtype === 'started'
  ).length
  return { model_turns: null, tool_calls: toolCalls, source: 'cursor_stream_json' }
}

const devinStreamCounts = (devinExport: string): StreamCounts | null => {
  if (!hasFileContent(devinExport)) {
    return null
  }
  let parsed: unknown = null
  try {
    parsed = JSON.parse(readFileSync(devinExport, 'utf8'))
  } catch {
    return null
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.steps)) {
    return null
  }
  return { model_turns: parsed.steps.length, tool_calls: null, source: 'devin_atif' }
}

export interface TimingCountsInput {
  backend: string
  stdoutCapture: string
  devinExport?: string
}

// stream capture から model_turns / tool_calls を抽出する。取得できない項目は null、
// 認識できるイベントが 1 つも無い capture は source: "unavailable" に倒す（fail-soft）。
// devin は stdout が text のため ATIF export の steps 数を model_turns として使う
export const timingStreamCounts = (input: TimingCountsInput): StreamCounts => {
  let counts: StreamCounts | null = null
  if (input.backend === 'devin') {
    counts = devinStreamCounts(input.devinExport ?? '')
  } else if (hasFileContent(input.stdoutCapture)) {
    const text = readFileOrEmpty(input.stdoutCapture)
    if (input.backend === 'claude') {
      counts = claudeStreamCounts(text)
    } else if (input.backend === 'codex') {
      counts = codexStreamCounts(text)
    } else if (input.backend === 'cursor') {
      counts = cursorStreamCounts(text)
    }
  }
  return counts ?? UNAVAILABLE
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  describe('timingStreamCounts', () => {
    it('falls back to unavailable for unsupported backends or unreadable captures', () => {
      expect(timingStreamCounts({ backend: 'grok', stdoutCapture: '/nonexistent.jsonl' })).toEqual({
        model_turns: null,
        tool_calls: null,
        source: 'unavailable',
      })
      expect(timingStreamCounts({ backend: 'devin', stdoutCapture: '' })).toEqual({
        model_turns: null,
        tool_calls: null,
        source: 'unavailable',
      })
    })
  })

  describe('elapsedMs', () => {
    it('returns null when the start value is missing', () => {
      expect(elapsedMs(null)).toBeNull()
    })
  })
}
