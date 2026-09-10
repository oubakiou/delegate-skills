import { readFileSync } from 'node:fs'
import type { CliResult } from './cli-result.ts'
import { isRecord } from './jq-compat.ts'

// jq への依存を配布物から外すための最小 JSON リーダ。
// SKILL.md の run 出力 / observe JSON 読み取り専用で、`jq -r <object dotpath>` の
// object-key 部分集合だけを実装する。配列 index（`.a[0]`）や quoted key（`."x.y"`）は
// 対応せず usage error（exit 2）で fail-closed にする（誤値の静かな返却を防ぐため）。
// Usage: read-json <dotpath> [json_file]   (json_file 省略時は stdin)
// stdout: 値 1 個 + 改行（null / 欠落は "null"、object / array は compact JSON）
// 親 Bash timeout の background 退避で stdout/stderr が合流した入力から、厳密 parse 失敗時だけ
// 行頭 `{` / `}` 単独行で object を切り出す（文字単位の最初〜最後だと別断片を跨ぎ得るため）。
// 外側は既知の harness 行だけ許可する。任意の prefix/suffix を捨てると破損 JSON を成功扱いする。

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

type NavResult = { ok: true; value: unknown } | { ok: false }

// jq -r のトラバーサル意味論に寄せる:
// - object を key で降下。key 欠落 / 途中が null は "null"（jq: null|.x=null）で exit 0
// - 途中が非 object 非 null（number/string/boolean/array）を key で index しようとしたら
//   jq は "Cannot index ... with ..." でエラーになるので、ここも fail-closed（ok:false）
// これにより壊れた observe/run JSON を「field 欠落」と誤認する fail-open を防ぐ
const navigate = (root: unknown, keys: readonly string[]): NavResult => {
  let current: unknown = root
  for (const key of keys) {
    if (current === null || typeof current === 'undefined') {
      return { ok: true, value: null }
    }
    if (!isRecord(current)) {
      return { ok: false }
    }
    const record: Record<string, unknown> = current
    current = record[key]
  }
  return { ok: true, value: current ?? null }
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

const isKnownHarnessLine = (line: string): boolean =>
  line.trim() === '' ||
  line.startsWith('observe_file: ') ||
  (line.startsWith('[exited with ') && line.endsWith(']'))

// 行頭アンカー: ネストしたインデント付き `}` を閉じ括弧と誤認しないよう leading space は残す
const extractPrettyPrintedObject = (raw: string): string | null => {
  const lines = raw.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trimEnd() === '{')
  const end = lines.findLastIndex((line) => line.trimEnd() === '}')
  if (start === -1 || end === -1 || end < start) {
    return null
  }
  const surrounding = [...lines.slice(0, start), ...lines.slice(end + 1)]
  if (!surrounding.every(isKnownHarnessLine)) {
    return null
  }
  return lines.slice(start, end + 1).join('\n')
}

const parsedOrError = (raw: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    const extracted = extractPrettyPrintedObject(raw)
    if (extracted === null) {
      return { ok: false }
    }
    try {
      return { ok: true, value: JSON.parse(extracted) }
    } catch {
      return { ok: false }
    }
  }
}

const extractValue = (raw: string, dotPath: string, keys: readonly string[]): CliResult => {
  const parsed = parsedOrError(raw)
  if (!parsed.ok) {
    return { exitCode: 4, stderr: 'ERROR: input is not valid JSON\n', stdout: '' }
  }
  const result = navigate(parsed.value, keys)
  if (!result.ok) {
    // jq: "Cannot index <type> with ..." 相当。fail-open を避けるため非 0 で落とす
    return {
      exitCode: 5,
      stderr: `ERROR: cannot traverse ${dotPath} (non-object on the path)\n`,
      stdout: '',
    }
  }
  return { exitCode: 0, stderr: '', stdout: `${formatValue(result.value)}\n` }
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
  return extractValue(raw, dotPath, keys)
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  const { writeFileSync } = await import('node:fs')
  const { createTestScratchFile } = await import('./test-scratch.ts')

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
      const file = createTestScratchFile(
        'read-json-test',
        `${Math.random().toString(36).slice(2)}.json`
      )
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

    it('treats null / missing intermediates as null but non-object intermediates as an error', () => {
      // jq: null|.x=null（exit0）だが number|.x はエラー（exit≠0）。fail-open を防ぐ
      const scalar = Buffer.from(JSON.stringify({ state: 1, ready: 'yes' }))
      const nested = runReadJson(['.state.phase'], scalar)
      expect(nested.exitCode).toBe(5)
      expect(nested.stdout).toBe('')
      // null 途中経路は jq と同じく null / exit 0
      const withNull = Buffer.from(JSON.stringify({ state: null }))
      const viaNull = runReadJson(['.state.phase'], withNull)
      expect(viaNull.exitCode).toBe(0)
      expect(viaNull.stdout).toBe('null\n')
    })
  })

  describe('runReadJson wrapping tolerance', () => {
    it('extracts a pretty-printed object wrapped by harness noise', () => {
      const mixed = Buffer.from(
        'observe_file: /x/y_observe.json\n{\n  "status": "completed"\n}\n\n[exited with code 0]\n'
      )
      const result = runReadJson(['.status'], mixed)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('completed\n')
    })

    it('extracts a pretty-printed object followed by a non-zero harness exit marker', () => {
      const mixed = Buffer.from(
        'observe_file: /x/y_observe.json\n{\n  "status": "completed"\n}\n[exited with code 143]\n'
      )
      expect(runReadJson(['.status'], mixed)).toMatchObject({
        exitCode: 0,
        stdout: 'completed\n',
      })
    })

    it('reads status fields from a background-merged run output', () => {
      const merged = Buffer.from(
        [
          'observe_file: /workspaces/delegate-skills/.temp/delegate/work/delegate_explore_observe.json',
          '{',
          '  "exit_code": 0,',
          '  "status": "completed",',
          '  "content": "status: completed",',
          '  "content_truncated": false,',
          '  "response_file": "/workspaces/delegate-skills/.temp/delegate/work/delegate_explore_res.json",',
          '  "observe_file": "/workspaces/delegate-skills/.temp/delegate/work/delegate_explore_observe.json",',
          '  "run_dir": "/workspaces/delegate-skills/.temp/delegate/work/delegate_explore"',
          '}',
          '',
          '[exited with code 0]',
          '',
        ].join('\n')
      )
      expect(runReadJson(['.status'], merged)).toMatchObject({
        exitCode: 0,
        stdout: 'completed\n',
      })
      expect(runReadJson(['.content_truncated'], merged)).toMatchObject({
        exitCode: 0,
        stdout: 'false\n',
      })
      expect(runReadJson(['.response_file'], merged)).toMatchObject({
        exitCode: 0,
        stdout: '/workspaces/delegate-skills/.temp/delegate/work/delegate_explore_res.json\n',
      })
    })

    it('still reads pure JSON without surrounding noise', () => {
      const result = runReadJson(['.status'], json)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('completed\n')
    })

    it('fails closed when no brace-only lines exist', () => {
      expect(runReadJson(['.status'], Buffer.from('not json')).exitCode).toBe(4)
    })

    it('fails closed when the extracted region is still invalid JSON', () => {
      const broken = Buffer.from('observe_file: /x\n{\n  "a": ,\n}\n[exited with code 0]\n')
      expect(runReadJson(['.a'], broken).exitCode).toBe(4)
    })

    it('fails closed when surrounding lines are not known harness lines', () => {
      const truncatedArray = Buffer.from('[\n{\n"status":"completed"\n}\n')
      const secondObjectCut = Buffer.from('{\n"status":"completed"\n}\n{"status":')
      const trailingGarbage = Buffer.from('{\n"state":{"phase":"ended"}\n}\n,broken')
      expect(runReadJson(['.status'], truncatedArray).exitCode).toBe(4)
      expect(runReadJson(['.status'], secondObjectCut).exitCode).toBe(4)
      expect(runReadJson(['.state.phase'], trailingGarbage).exitCode).toBe(4)
    })

    it('keeps a valid JSON array as a traverse error instead of extracting the inner object', () => {
      const array = Buffer.from('[\n{\n"status":"completed"\n}\n]\n')
      const result = runReadJson(['.status'], array)
      expect(result.exitCode).toBe(5)
      expect(result.stdout).toBe('')
    })

    it('reads nested fields from a pretty-printed observe JSON file', () => {
      const file = createTestScratchFile(
        'read-json-test',
        `${Math.random().toString(36).slice(2)}.json`
      )
      writeFileSync(
        file,
        `${JSON.stringify(
          {
            state: { phase: 'ended' },
            run: { response_file: '/tmp/x_res.json' },
          },
          null,
          2
        )}\n`
      )
      expect(runReadJson(['.state.phase', file], Buffer.alloc(0)).stdout).toBe('ended\n')
      expect(runReadJson(['.run.response_file', file], Buffer.alloc(0)).stdout).toBe(
        '/tmp/x_res.json\n'
      )
    })

    it('applies harness wrapping to the file argument path as well', () => {
      const file = createTestScratchFile(
        'read-json-test',
        `${Math.random().toString(36).slice(2)}.output`
      )
      writeFileSync(
        file,
        'observe_file: /x/y_observe.json\n{\n  "status": "completed",\n  "content_truncated": false,\n  "response_file": "/tmp/x_res.json"\n}\n\n[exited with code 0]\n'
      )
      expect(runReadJson(['.status', file], Buffer.alloc(0))).toMatchObject({
        exitCode: 0,
        stdout: 'completed\n',
      })
      const garbage = createTestScratchFile(
        'read-json-test',
        `${Math.random().toString(36).slice(2)}.output`
      )
      writeFileSync(garbage, '{\n"state":{"phase":"ended"}\n}\n,broken')
      expect(runReadJson(['.state.phase', garbage], Buffer.alloc(0)).exitCode).toBe(4)
    })
  })
}
