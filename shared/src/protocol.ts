import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// protocol v1 の request / response で共有する変換・計測ヘルパー。
// 出力形式は bash(jq) 実装との byte 互換を保つ (pretty JSON は 2-space indent)。

export interface BodyStats {
  bytes: number
  chars: number
  lines: number
}

const utf8SequenceLength = (lead: number): number => {
  if (lead < 0x80) {
    return 1
  }
  if (lead >= 0xc2 && lead <= 0xdf) {
    return 2
  }
  if (lead >= 0xe0 && lead <= 0xef) {
    return 3
  }
  if (lead >= 0xf0 && lead <= 0xf4) {
    return 4
  }
  return 0
}

const isValidUtf8Sequence = (body: Buffer, offset: number, length: number): boolean => {
  if (offset + length > body.length) {
    return false
  }
  for (let position = offset + 1; position < offset + length; position += 1) {
    const byte = body[position]
    if (byte < 0x80 || byte > 0xbf) {
      return false
    }
  }
  return true
}

// wc -m 相当 (UTF-8 locale)。toString('utf8') 経由だと不正バイトが U+FFFD として
// 数えられ wc -m (不正バイトは文字として数えない) と乖離するため、byte 走査で数える
const wcCharCount = (body: Buffer): number => {
  let count = 0
  let offset = 0
  while (offset < body.length) {
    const length = utf8SequenceLength(body[offset])
    if (length > 0 && isValidUtf8Sequence(body, offset, length)) {
      count += 1
      offset += length
    } else {
      offset += 1
    }
  }
  return count
}

export const bodyStats = (body: Buffer): BodyStats => ({
  bytes: body.length,
  chars: wcCharCount(body),
  // wc -l 相当 (改行 byte 数)
  lines: body.filter((byte) => byte === 0x0a).length,
})

export const estimatedTokens = (chars: number): number => Math.floor((chars + 3) / 4)

export const prettyJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

export const metricsTimestamp = (): string => {
  const now = new Date()
  return `${now.toISOString().slice(0, 19)}Z`
}

// telemetry は opt-in (DELEGATE_METRICS_FILE) かつ計測失敗で本処理を止めない
export const appendMetrics = (
  metricsFile: string | null | undefined,
  record: Record<string, unknown>
): void => {
  if (typeof metricsFile !== 'string' || metricsFile === '') {
    return
  }
  try {
    mkdirSync(path.dirname(metricsFile), { recursive: true })
    appendFileSync(metricsFile, `${JSON.stringify(record)}\n`)
  } catch {
    // 計測は best-effort
  }
}

// JSON が protocol の正本で、Markdown は人間の監査・デバッグ用の派生物に留める。
export const writeCompanionMarkdown = (jsonFile: string, sections: readonly string[]): void => {
  try {
    writeFileSync(`${jsonFile.replace(/\.json$/, '')}.md`, `${sections.join('\n\n')}\n`)
  } catch {
    // 派生物の書き込み失敗で本処理を止めない
  }
}

const TOKEN_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

export const randomToken = (length: number): string => {
  let token = ''
  for (let position = 0; position < length; position += 1) {
    token += TOKEN_CHARS[Math.floor(Math.random() * TOKEN_CHARS.length)]
  }
  return token
}

const pad = (value: number): string => String(value).padStart(2, '0')

export const runTimestamp = (): string => {
  const now = new Date()
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

export const sectionBanner = (sections: readonly string[]): string =>
  sections.map((value, key) => `===== section[${key}] =====\n${value}`).join('\n')

// bash 実装は metrics 有効時に $(...) が末尾改行を剥がしてから printf '%s\n' で
// 1 本だけ付け直す。互換のため同じ正規化を通す
export const stripTrailingNewlines = (value: string): string => value.replace(/\n+$/, '')

// bash の body="$(cat)" (command substitution) と同じ末尾改行の除去。
// toString を経由すると不正 UTF-8 バイトが U+FFFD に化けるため Buffer のまま切る
export const stripTrailingNewlineBytes = (body: Buffer): Buffer => {
  let end = body.length
  while (end > 0 && body[end - 1] === 0x0a) {
    end -= 1
  }
  return body.subarray(0, end)
}

export interface EmittedOutput {
  stdout: string
  measured: string
}

export const emitForMetrics = (raw: string, metricsEnabled: boolean): EmittedOutput => {
  if (!metricsEnabled) {
    return { measured: `${raw}\n`, stdout: `${raw}\n` }
  }
  const stripped = stripTrailingNewlines(raw)
  return { measured: `${stripped}\n`, stdout: `${stripped}\n` }
}

export const selectedStats = (measured: string): BodyStats => bodyStats(Buffer.from(measured))

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  describe('protocol helpers', () => {
    it('counts bytes, code points, and newlines like wc', () => {
      const stats = bodyStats(Buffer.from('あい\nu\n'))
      expect(stats.bytes).toBe(9)
      expect(stats.chars).toBe(5)
      expect(stats.lines).toBe(2)
    })

    it('does not count invalid UTF-8 bytes as characters, matching GNU wc -m', () => {
      const stats = bodyStats(Buffer.from([0xff, 0x0a]))
      expect(stats.bytes).toBe(2)
      expect(stats.chars).toBe(1)
      expect(stats.lines).toBe(1)
    })

    it('estimates tokens with the (chars + 3) / 4 floor formula', () => {
      expect(estimatedTokens(0)).toBe(0)
      expect(estimatedTokens(1)).toBe(1)
      expect(estimatedTokens(8)).toBe(2)
    })

    it('renders pretty JSON in the jq 2-space format', () => {
      expect(prettyJson({ items: [1], name: 'x' })).toBe(
        '{\n  "items": [\n    1\n  ],\n  "name": "x"\n}\n'
      )
    })

    it('builds section banners in the read-script format', () => {
      expect(sectionBanner(['one', 'two'])).toBe(
        '===== section[0] =====\none\n===== section[1] =====\ntwo'
      )
    })

    it('generates tokens of the requested length from the mktemp alphabet', () => {
      const token = randomToken(5)
      expect(token).toMatch(/^[A-Za-z0-9]{5}$/)
    })
  })
}
