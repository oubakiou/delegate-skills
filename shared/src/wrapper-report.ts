import { spawnSync } from 'node:child_process'
import { renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { runBuildResponse } from './build-response.ts'
import type { Env } from './build-request.ts'
import { isRecord, parseJsonObjects, readFileOrEmpty } from './jq-compat.ts'
import { randomToken, writeCompanionMarkdown } from './protocol.ts'

// bash 版 observe-json.sh の report / prompt 系 helper と同一契約。
// wrapper（backend 起動ラッパ）だけが使う関数群で、Step 4b から繰り越して移植した。

export const reportModeForBackend = (backend: string): 'structured' | 'report_md' => {
  if (backend === 'claude' || backend === 'codex') {
    return 'structured'
  }
  return 'report_md'
}

// 構造化最終応答 {status, report_markdown} の JSON schema（Claude --json-schema には
// 文字列で、Codex --output-schema にはファイルで渡す）
export const REPORT_SCHEMA_JSON =
  '{"type":"object","properties":{"status":{"type":"string","enum":["completed","partial","failed","needs_input"]},"report_markdown":{"type":"string","minLength":1}},"required":["status","report_markdown"],"additionalProperties":false}'

export const positiveIntOrZero = (value: string): number => {
  if (!/^[0-9]+$/.test(value) || value === '') {
    return 0
  }
  return Number(value)
}

// request 本文の初期 prompt 埋め込み gate。閾値は OS の ARG_MAX ではなくモデル context
// 上限に対する保守的なバイト近似（既定 256KB ≒ 64k tokens）。超過時は従来の
// read-request.sh 指示へ fallback する
export const requestInlineMax = (env: Env): number => {
  const raw = env.DELEGATE_REQUEST_INLINE_MAX ?? '262144'
  if (raw === '' || /[^0-9]/.test(raw)) {
    return 262_144
  }
  return Number(raw)
}

// prompt を argv で渡す経路（stdin / prompt-file が未実測の CLI）用の縮小 gate。
// Linux は総 ARG_MAX とは別に単一引数を MAX_ARG_STRLEN（≈128KiB）で制限するため、
// 既定の inline gate（256KB）のままでは E2BIG で CLI 起動前に失敗する
export const REQUEST_ARGV_INLINE_MAX = 98_304

export const validProtocolStatus = (status: string): boolean =>
  status === 'completed' || status === 'partial' || status === 'failed' || status === 'needs_input'

const fileSizeOrZero = (file: string): number => {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

// 検証済み request JSON（正本）から初期 prompt へ埋め込む本文を作る。companion .md は
// best-effort 派生物で正本ではないため実行入力に使わない（protocol-v1）
const parsedJsonOrNull = (file: string): unknown => {
  try {
    return JSON.parse(readFileOrEmpty(file))
  } catch {
    return null
  }
}

const chainOrEmptyList = (chain: unknown): unknown => {
  if (chain === null || typeof chain === 'undefined' || chain === false) {
    return []
  }
  return chain
}

export const requestInlineBody = (requestFile: string): string | null => {
  const parsed = parsedJsonOrNull(requestFile)
  if (!isRecord(parsed) || !Array.isArray(parsed.sections) || parsed.sections.length === 0) {
    return null
  }
  if (!parsed.sections.every((section) => typeof section === 'string')) {
    return null
  }
  const chain = chainOrEmptyList(parsed.task_type_chain)
  return `task_type_chain: ${JSON.stringify(chain)}\n\n${parsed.sections.join('\n\n')}`
}

export interface RequestPromptStep {
  step: string
  inline: boolean
}

const inlineGateOf = (env: Env, maxOverride: string): number => {
  const gateMax = requestInlineMax(env)
  if (maxOverride === '' || /[^0-9]/.test(maxOverride)) {
    return gateMax
  }
  const override = Number(maxOverride)
  if (override < gateMax) {
    return override
  }
  return gateMax
}

// 初期 prompt の手順 1（request の取得方法）を組み立てる。埋め込み成立時は
// 本文込みの手順、gate 超過・抽出不能時は read-request 指示へ fallback する
export const requestPromptStep = (
  requestFile: string,
  context: { scriptsDir: string; env: Env; maxOverride?: string }
): RequestPromptStep => {
  const gateMax = inlineGateOf(context.env, context.maxOverride ?? '')
  const requestBytes = fileSizeOrZero(requestFile)
  if (requestBytes > 0 && requestBytes <= gateMax) {
    const body = requestInlineBody(requestFile)
    if (body !== null) {
      return {
        inline: true,
        step: `1. リクエスト本文は以下に全文埋め込み済み（${requestFile} と同内容。読み直しは不要）。<request> 内の task_type_chain に自種別を含む種別への再委譲は禁止。
<request>
${body}
</request>`,
      }
    }
  }
  return {
    inline: false,
    step: `1. リクエストを読む: \`bash ${context.scriptsDir}/read-request.sh "${requestFile}" all\` で全 section を 1 回で丸読みする（読み飛ばせる情報は無いので、段階読みで往復を増やさない）。task_type_chain（${requestFile} の .task_type_chain）に自種別を含む種別への再委譲は禁止。`,
  }
}

// Claude stream-json capture の最終 result event から構造化出力を取り出す。
// --json-schema 実行では parse 済み structured_output が入り、無ければ result 文字列の
// JSON parse を試す。取り出せなければ null（呼び出し側が fail-closed に倒す）
const parsedResultString = (result: unknown): unknown => {
  if (typeof result !== 'string') {
    return null
  }
  try {
    return JSON.parse(result)
  } catch {
    return null
  }
}

export const structuredFromClaudeCapture = (
  captureFile: string
): Record<string, unknown> | null => {
  const results = parseJsonObjects(readFileOrEmpty(captureFile)).filter(
    (event) => event.type === 'result'
  )
  if (results.length === 0) {
    return null
  }
  const last = results[results.length - 1]
  let candidate: unknown = last.structured_output
  if (candidate === null || typeof candidate === 'undefined' || candidate === false) {
    candidate = parsedResultString(last.result)
  }
  if (isRecord(candidate)) {
    return candidate
  }
  return null
}

// Codex --output-last-message ファイル（--output-schema 実行では schema 準拠 JSON が
// そのまま書かれる）から構造化出力を取り出す
export const structuredFromLastMessage = (lastMsgFile: string): Record<string, unknown> | null => {
  const content = readFileOrEmpty(lastMsgFile)
  if (content === '') {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(content)
    if (isRecord(parsed)) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

export interface AssembleTarget {
  status: string
  responderSessionId: string
  responseFile: string
  runDir: string
}

const isWhitespaceOnly = (content: string): boolean =>
  content.replaceAll(/[\t\n\v\f\r ]/g, '') === ''

const removeAssembleLeftovers = (tmpResponse: string): void => {
  rmSync(tmpResponse, { force: true })
  rmSync(`${tmpResponse.replace(/\.json$/, '')}.md`, { force: true })
}

// report 本文から response を組み立てる共通処理。build-response は response を書いて
// から index/sections を検証するため、失敗時に部分生成物が正 response パスに残ると
// wrapper の response 欠落判定（fail-closed）をすり抜ける。一時パスへ組み立てて
// 成功時のみ rename する
export const assembleResponse = (
  target: AssembleTarget,
  reportContent: string,
  env: Env
): boolean => {
  // 空白のみの本文は md2idx が空 sections を返す前に弾く
  if (isWhitespaceOnly(reportContent)) {
    return false
  }
  const base = path.basename(target.responseFile, '.json')
  const tmpResponse = path.join(target.runDir, `${base}_assemble_${randomToken(5)}.json`)
  const built = runBuildResponse(
    [target.status, target.responderSessionId, tmpResponse],
    env,
    Buffer.from(reportContent)
  )
  if (built.exitCode !== 0) {
    removeAssembleLeftovers(tmpResponse)
    return false
  }
  renameSync(tmpResponse, target.responseFile)
  return true
}

// 構造化出力 {status, report_markdown} から protocol response を組み立てる。
// status の語彙外・report_markdown 欠落/空は parse 失敗として false（fail-closed。
// 非永続セッションでは worker 終了後の方式切替が原理的に不可能なため、リトライは
// 親判断に委ねる）
const stringOrEmptyValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  return ''
}

const writeStructuredReportFile = (
  target: Omit<AssembleTarget, 'status'>,
  report: string
): boolean => {
  const base = path.basename(target.responseFile, '.json')
  const reportFile = path.join(target.runDir, `${base}_structured_${randomToken(5)}.md`)
  writeFileSync(reportFile, `${report}\n`)
  if (fileSizeOrZero(reportFile) === 0) {
    rmSync(reportFile, { force: true })
    return false
  }
  return true
}

export const buildResponseFromStructured = (
  structured: Record<string, unknown>,
  target: Omit<AssembleTarget, 'status'>,
  env: Env
): boolean => {
  const status = stringOrEmptyValue(structured.status)
  if (!validProtocolStatus(status)) {
    return false
  }
  const report = structured.report_markdown
  if (typeof report !== 'string' || !writeStructuredReportFile(target, report)) {
    return false
  }
  return assembleResponse({ ...target, status }, `${report}\n`, env)
}

interface ReportMdParts {
  status: string
  body: string
}

const reportMdStatusOf = (lines: readonly string[]): string => {
  for (const line of lines.slice(1)) {
    if (/^---[\t\v\f\r ]*$/.test(line)) {
      return ''
    }
    const match = /^status:[\t\v\f\r ]*(?<value>.*)$/.exec(line)
    if (match !== null && typeof match.groups !== 'undefined') {
      return match.groups.value.replaceAll(/[\t\n\v\f\r ]/g, '')
    }
  }
  return ''
}

const reportMdBodyOf = (lines: readonly string[]): string => {
  let dashCount = 0
  const body: string[] = []
  for (const line of lines) {
    if (dashCount >= 2) {
      body.push(`${line}\n`)
    } else if (/^---[\t\v\f\r ]*$/.test(line)) {
      dashCount += 1
    }
  }
  return body.join('')
}

const reportMdPartsOf = (reportFile: string): ReportMdParts | null => {
  const content = readFileOrEmpty(reportFile)
  if (content === '') {
    return null
  }
  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }
  if (lines[0] !== '---') {
    return null
  }
  return { status: reportMdStatusOf(lines), body: reportMdBodyOf(lines) }
}

// report.md 方式: front-matter「---\nstatus: <値>\n---」付き Markdown から status と
// 本文を取り出して protocol response を組み立てる。front-matter 欠落・status 語彙外・
// 本文空は失敗として false
export const buildResponseFromReportMd = (
  reportFile: string,
  target: Omit<AssembleTarget, 'status'>,
  env: Env
): boolean => {
  const parts = reportMdPartsOf(reportFile)
  if (parts === null || !validProtocolStatus(parts.status) || parts.body === '') {
    return false
  }
  const base = path.basename(target.responseFile, '.json')
  const bodyFile = path.join(target.runDir, `${base}_reportbody_${randomToken(5)}.md`)
  writeFileSync(bodyFile, parts.body)
  return assembleResponse({ ...target, status: parts.status }, parts.body, env)
}

// response JSON の sections から companion .md を派生させる（失敗は握りつぶす）
export const writeCompanionFromResponse = (responseFile: string): void => {
  try {
    const parsed: unknown = JSON.parse(readFileOrEmpty(responseFile))
    if (isRecord(parsed) && Array.isArray(parsed.sections)) {
      writeCompanionMarkdown(responseFile, parsed.sections.map(String))
    }
  } catch {
    // 派生物の生成失敗で wrapper を止めない
  }
}

interface PsEntry {
  pid: number
  ppid: number
  line: string
}

const psEntries = (): PsEntry[] => {
  const listed = spawnSync('ps', ['-e', '-o', 'pid=,ppid=,etimes=,args='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const entries: PsEntry[] = []
  for (const line of (listed.stdout ?? '').split('\n')) {
    const fields = line.trim().split(/\s+/)
    const pid = Number(fields[0])
    const ppid = Number(fields[1])
    if (Number.isInteger(pid) && Number.isInteger(ppid)) {
      entries.push({ pid, ppid, line })
    }
  }
  return entries
}

const isDescendantOf = (entry: PsEntry, root: number, parents: Map<number, number>): boolean => {
  let current: number | undefined = entry.pid
  for (let depth = 0; depth < 64 && typeof current === 'number'; depth += 1) {
    if (current === root) {
      return true
    }
    current = parents.get(current)
  }
  return false
}

// stall_timeout イベントに記録する、root pid 配下のプロセスツリー（ps 行の配列）
export const processTreeJson = (rootPid: number): string[] => {
  const entries = psEntries()
  const parents = new Map<number, number>()
  for (const entry of entries) {
    parents.set(entry.pid, entry.ppid)
  }
  return entries
    .filter((entry) => isDescendantOf(entry, rootPid, parents))
    .toSorted((left, right) => left.pid - right.pid)
    .map((entry) => entry.line)
}

// codex-home のキャッシュ類は 1 dispatch あたり数十 MB 残留し、dispatch を多数回す
// 用途（ベンチ・CI）でディスクを圧迫する。正常終了時のみ prune し、失敗時は調査の
// ため残す。観測と follow-up に使う sessions JSONL と config は常に残す
export const codexHomePrune = (codexHome: string, env: Env): void => {
  const setting = env.DELEGATE_CODEX_HOME_PRUNE ?? '1'
  if (setting === '0' || setting === 'false' || setting === 'no') {
    return
  }
  for (const entry of ['.tmp', 'tmp', 'cache', 'models_cache.json', 'plugins', 'shell_snapshots']) {
    try {
      rmSync(path.join(codexHome, entry), { force: true, recursive: true })
    } catch {
      // bash 版の || true と同じく prune 失敗は無視する
    }
  }
}

const writeTempFile = (dir: string, name: string, content: string): string => {
  const file = path.join(dir, name)
  writeFileSync(file, content)
  return file
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  const { mkdirSync } = await import('node:fs')

  const makeReportTestDir = (): string => {
    mkdirSync('.temp', { recursive: true })
    const dir = `.temp/wrapper-report-test-${Math.random().toString(36).slice(2)}`
    mkdirSync(dir)
    return dir
  }

  describe('reportModeForBackend', () => {
    it('uses structured for claude/codex and report_md otherwise', () => {
      expect(reportModeForBackend('claude')).toBe('structured')
      expect(reportModeForBackend('codex')).toBe('structured')
      expect(reportModeForBackend('cursor')).toBe('report_md')
      expect(reportModeForBackend('devin')).toBe('report_md')
      expect(reportModeForBackend('grok')).toBe('report_md')
    })
  })

  describe('requestPromptStep', () => {
    const requestJson = JSON.stringify({
      task_type_chain: ['chore'],
      sections: ['# Objective\n本文'],
    })

    it('embeds the request body inside the gate and reports inline true', () => {
      const dir = makeReportTestDir()
      const requestFile = writeTempFile(dir, 'req.json', requestJson)
      const result = requestPromptStep(requestFile, { scriptsDir: '/s', env: {} })
      expect(result.inline).toBe(true)
      expect(result.step).toContain('task_type_chain: ["chore"]')
      expect(result.step).toContain('<request>')
    })

    it('falls back to the read-request instruction over the gate or on bad requests', () => {
      const dir = makeReportTestDir()
      const requestFile = writeTempFile(dir, 'req.json', requestJson)
      const over = requestPromptStep(requestFile, {
        scriptsDir: '/s',
        env: { DELEGATE_REQUEST_INLINE_MAX: '1' },
      })
      expect(over.inline).toBe(false)
      expect(over.step).toContain('read-request.sh')
      const argvGate = requestPromptStep(requestFile, {
        scriptsDir: '/s',
        env: { DELEGATE_REQUEST_INLINE_MAX: '999999' },
        maxOverride: '1',
      })
      expect(argvGate.inline).toBe(false)
      const corrupt = requestPromptStep(writeTempFile(dir, 'bad.json', 'not json'), {
        scriptsDir: '/s',
        env: {},
      })
      expect(corrupt.inline).toBe(false)
    })
  })

  describe('structuredFromClaudeCapture', () => {
    it('takes the parsed structured_output from the last result event', () => {
      const dir = makeReportTestDir()
      const capture = writeTempFile(
        dir,
        'stdout.capture',
        `${JSON.stringify({ type: 'system' })}\n${JSON.stringify({
          type: 'result',
          structured_output: { status: 'completed', report_markdown: '# Summary\nok' },
        })}\n`
      )
      expect(structuredFromClaudeCapture(capture)).toMatchObject({ status: 'completed' })
    })

    it('falls back to parsing the result string and fails closed otherwise', () => {
      const dir = makeReportTestDir()
      const fromString = writeTempFile(
        dir,
        'a.capture',
        `${JSON.stringify({ type: 'result', result: '{"status":"partial","report_markdown":"x"}' })}\n`
      )
      expect(structuredFromClaudeCapture(fromString)).toMatchObject({ status: 'partial' })
      const invalid = writeTempFile(dir, 'b.capture', `${JSON.stringify({ type: 'result' })}\n`)
      expect(structuredFromClaudeCapture(invalid)).toBeNull()
      expect(structuredFromClaudeCapture(path.join(dir, 'missing'))).toBeNull()
    })
  })

  describe('buildResponseFromStructured', () => {
    it('assembles a protocol response and fails closed on invalid status or report', () => {
      const dir = makeReportTestDir()
      const responseFile = path.join(dir, 'delegate_chore_x_res.json')
      const ok = buildResponseFromStructured(
        { status: 'completed', report_markdown: '# Summary\nok' },
        { responderSessionId: 'claude:haiku:x', responseFile, runDir: dir },
        {}
      )
      expect(ok).toBe(true)
      const parsed: unknown = JSON.parse(readFileOrEmpty(responseFile))
      expect(parsed).toMatchObject({ status: 'completed', type: 'response' })
      expect(
        buildResponseFromStructured(
          { status: 'bogus', report_markdown: 'x' },
          { responderSessionId: 's', responseFile: path.join(dir, 'r2.json'), runDir: dir },
          {}
        )
      ).toBe(false)
      expect(
        buildResponseFromStructured(
          { status: 'completed' },
          { responderSessionId: 's', responseFile: path.join(dir, 'r3.json'), runDir: dir },
          {}
        )
      ).toBe(false)
    })
  })

  describe('buildResponseFromReportMd', () => {
    it('parses the front-matter status and body into a response', () => {
      const dir = makeReportTestDir()
      const reportFile = writeTempFile(
        dir,
        'report.md',
        '---\nstatus: completed\n---\n# Summary\nreport md ok\n'
      )
      const responseFile = path.join(dir, 'delegate_chore_y_res.json')
      const ok = buildResponseFromReportMd(
        reportFile,
        { responderSessionId: 'cursor:m:y', responseFile, runDir: dir },
        {}
      )
      expect(ok).toBe(true)
      expect(JSON.parse(readFileOrEmpty(responseFile))).toMatchObject({ status: 'completed' })
    })

    it('fails closed on missing front matter, bad status, or an empty body', () => {
      const dir = makeReportTestDir()
      const target = {
        responderSessionId: 's',
        responseFile: path.join(dir, 'r.json'),
        runDir: dir,
      }
      expect(
        buildResponseFromReportMd(writeTempFile(dir, 'a.md', '# no front matter\n'), target, {})
      ).toBe(false)
      expect(
        buildResponseFromReportMd(
          writeTempFile(dir, 'b.md', '---\nstatus: bogus\n---\nbody\n'),
          target,
          {}
        )
      ).toBe(false)
      expect(
        buildResponseFromReportMd(
          writeTempFile(dir, 'c.md', '---\nstatus: completed\n---\n'),
          target,
          {}
        )
      ).toBe(false)
    })
  })

  describe('positiveIntOrZero / requestInlineMax', () => {
    it('mirrors the bash numeric fallbacks', () => {
      expect(positiveIntOrZero('300000')).toBe(300_000)
      expect(positiveIntOrZero('')).toBe(0)
      expect(positiveIntOrZero('12x')).toBe(0)
      expect(requestInlineMax({})).toBe(262_144)
      expect(requestInlineMax({ DELEGATE_REQUEST_INLINE_MAX: 'bad' })).toBe(262_144)
      expect(requestInlineMax({ DELEGATE_REQUEST_INLINE_MAX: '1024' })).toBe(1024)
    })
  })

  describe('processTreeJson', () => {
    it('includes the current process subtree', () => {
      const tree = processTreeJson(process.pid)
      expect(tree.some((line) => line.includes(String(process.pid)))).toBe(true)
    })
  })
}
