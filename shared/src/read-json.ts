import { readFileSync } from 'node:fs'
import type { CliResult } from './cli-result.ts'
import { getPath } from './jq-compat.ts'

// jq への依存を配布物から外すための最小 JSON リーダ。
// SKILL.md の run 出力 / observe JSON 読み取り専用で、`jq -r <object dotpath>` の
// object-key 部分集合だけを実装する。配列 index（`.a[0]`）や quoted key（`."x.y"`）は
// 対応せず usage error（exit 2）で fail-closed にする（誤値の静かな返却を防ぐため）。
// Usage: read-json <dotpath> [json_file]   (json_file 省略時は stdin)
// stdout: 値 1 個 + 改行（null / 欠落は "null"、object / array は compact JSON）

// object key の連結のみ許容: `.` / `.a` / `.a.b.c`（英数 _ - のみ）。bracket / quote は不許可
const DOT_PATH = /^\.(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)?$/

const parseDotPath = (raw: string): string[] => {
  if (raw === '.') {
    return []
  }
  return raw
    .slice(1)
    .split('.')
    .filter((segment) => segment !== '')
}

// jq -r のスカラ整形: string はそのまま、null / 欠落は "null"、object / array は compact JSON
const formatValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  if (value === null || typeof value === 'undefined') {
    return 'null'
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return JSON.stringify(value)
}

const navigate = (root: unknown, keys: readonly string[]): unknown => {
  if (keys.length === 0) {
    return root
  }
  // DOT_PATH で英数 key のみに保証済み。getPath は record のみ辿るため、
  // jq の欠落= null 挙動へ寄せて undefined を null 化する
  return getPath(root, keys) ?? null
}

const readRawJson = (stdin: Buffer, jsonFile: string | undefined): string | null => {
  try {
    if (typeof jsonFile === 'string') {
      return readFileSync(jsonFile, 'utf8')
    }
    return stdin.toString('utf8')
  } catch {
    return null
  }
}

const usageError = (): CliResult => ({
  exitCode: 2,
  stderr: 'Usage: read-json <dotpath> [json_file]  (json on stdin if file omitted)\n',
  stdout: '',
})

const extractValue = (raw: string, keys: readonly string[]): CliResult => {
  try {
    return { exitCode: 0, stderr: '', stdout: `${formatValue(navigate(JSON.parse(raw), keys))}\n` }
  } catch {
    return { exitCode: 4, stderr: 'ERROR: input is not valid JSON\n', stdout: '' }
  }
}

export const runReadJson = (argv: readonly string[], stdin: Buffer): CliResult => {
  if (argv.length < 1 || !DOT_PATH.test(argv[0])) {
    return usageError()
  }
  const [dotPath, jsonFile] = argv
  const keys = parseDotPath(dotPath)
  const raw = readRawJson(stdin, jsonFile)
  if (raw === null) {
    return {
      exitCode: 3,
      stderr: `ERROR: cannot read json: ${jsonFile ?? '(stdin)'}\n`,
      stdout: '',
    }
  }
  return extractValue(raw, keys)
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  const { mkdirSync, writeFileSync } = await import('node:fs')

  const json = Buffer.from(
    JSON.stringify({
      status: 'completed',
      content_truncated: false,
      response_file: null,
      state: { phase: 'running', started_at: null },
      backend_session: { persistence: 'resumable' },
    })
  )

  describe('runReadJson', () => {
    it('reads scalar and nested fields with jq -r semantics from stdin', () => {
      expect(runReadJson(['.status'], json).stdout).toBe('completed\n')
      expect(runReadJson(['.content_truncated'], json).stdout).toBe('false\n')
      expect(runReadJson(['.state.phase'], json).stdout).toBe('running\n')
      expect(runReadJson(['.backend_session.persistence'], json).stdout).toBe('resumable\n')
    })

    it('prints "null" for null values and missing keys', () => {
      expect(runReadJson(['.response_file'], json).stdout).toBe('null\n')
      expect(runReadJson(['.state.started_at'], json).stdout).toBe('null\n')
      expect(runReadJson(['.nope'], json).stdout).toBe('null\n')
    })

    it('reads from a file when a path is given', () => {
      mkdirSync('.temp', { recursive: true })
      const file = `.temp/read-json-test-${Math.random().toString(36).slice(2)}.json`
      writeFileSync(file, JSON.stringify({ model: 'haiku' }))
      expect(runReadJson(['.model', file], Buffer.alloc(0)).stdout).toBe('haiku\n')
    })

    it('fails closed on a bad dotpath or invalid JSON', () => {
      expect(runReadJson([], json).exitCode).toBe(2)
      expect(runReadJson(['status'], json).exitCode).toBe(2)
      expect(runReadJson(['.status'], Buffer.from('not json')).exitCode).toBe(4)
    })

    it('rejects unsupported bracket / quoted dotpaths with exit 2 (no silent null)', () => {
      // 配列 index や quoted key は非対応。誤値を静かに返さず usage error にする
      expect(runReadJson(['.sections[1]'], json).exitCode).toBe(2)
      expect(runReadJson(['."x.y"'], json).exitCode).toBe(2)
      expect(runReadJson(['.a[0].b'], json).exitCode).toBe(2)
    })
  })
}
