import { spawnSync } from 'node:child_process'
import { renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { runBuildResponse } from './build-response.ts'
import type { Env } from './build-request.ts'
import { envFlagEnabled } from './env-flag.ts'
import { isRecord, parseJsonObjects, readFileOrEmpty } from './jq-compat.ts'
import { randomToken, writeCompanionMarkdown } from './protocol.ts'

// bash 版 observe-json.sh の report / prompt 系 helper と同一契約。
// wrapper（backend 起動ラッパ）だけが使う関数群で、Step 4b から繰り越して移植した。

export type ReportMode = 'structured' | 'report_md' | 'stdout_text'

export const reportModeForBackend = (backend: string): ReportMode => {
  if (backend === 'claude' || backend === 'codex') {
    return 'structured'
  }
  if (backend === 'opencode') {
    return 'stdout_text'
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

const frontMatterDelimiter = /^---[\t\v\f\r ]*$/

const trimProtocolWhitespace = (value: string): string =>
  value.replace(/^[\t\v\f\r ]+/, '').replace(/[\t\v\f\r ]+$/, '')

const withoutLineEnding = (line: string): string => {
  if (line.endsWith('\r')) {
    return line.slice(0, -1)
  }
  return line
}

const statusOfFrontMatter = (lines: readonly string[]): string => {
  for (const line of lines) {
    const match = /^status:[\t\v\f\r ]*(?<value>.*)$/.exec(line)
    if (match !== null && typeof match.groups !== 'undefined') {
      return trimProtocolWhitespace(match.groups.value)
    }
  }
  return ''
}

const normalizedReportLines = (content: string): string[] => {
  const lines = content.split('\n').map(withoutLineEnding)
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

const reportBodyOf = (lines: readonly string[], closingIndex: number): string =>
  lines
    .slice(closingIndex + 1)
    .map((line) => `${line}\n`)
    .join('')

const reportPartsOfContent = (content: string): ReportMdParts | null => {
  if (content === '') {
    return null
  }
  const lines = normalizedReportLines(content)
  if (lines.length === 0 || !frontMatterDelimiter.test(lines[0])) {
    return null
  }
  const closingOffset = lines.slice(1).findIndex((line) => frontMatterDelimiter.test(line))
  if (closingOffset === -1) {
    return null
  }
  const closingIndex = closingOffset + 1
  return {
    status: statusOfFrontMatter(lines.slice(1, closingIndex)),
    body: reportBodyOf(lines, closingIndex),
  }
}

const reportMdPartsOf = (reportFile: string): ReportMdParts | null =>
  reportPartsOfContent(readFileOrEmpty(reportFile))

// report.md 方式: front-matter「---\nstatus: <値>\n---」付き Markdown から status と
// 本文を取り出して protocol response を組み立てる。front-matter 欠落・status 語彙外・
// 本文空は失敗として false
export const buildResponseFromReportMd = (
  reportFile: string,
  target: Omit<AssembleTarget, 'status'>,
  env: Env
): boolean => {
  const parts = reportMdPartsOf(reportFile)
  if (parts === null || !validProtocolStatus(parts.status) || isWhitespaceOnly(parts.body)) {
    return false
  }
  const base = path.basename(target.responseFile, '.json')
  const bodyFile = path.join(target.runDir, `${base}_reportbody_${randomToken(5)}.md`)
  writeFileSync(bodyFile, parts.body)
  return assembleResponse({ ...target, status: parts.status }, parts.body, env)
}

export const isMarkdownSectionHeading = (line: string, name: string): boolean => {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
  return new RegExp(`^#+\\s*${escapedName}\\s*$`).test(line)
}

interface FenceMarker {
  marker: '`' | '~'
  length: number
  rest: string
}

const fenceMarkerTypeOf = (marker: string): '`' | '~' => {
  if (marker.startsWith('`')) {
    return '`'
  }
  return '~'
}

const fenceMarkerOf = (line: string): FenceMarker | null => {
  const match = /^[ \t]{0,3}(?<marker>`{3,}|~{3,})(?<rest>.*)$/.exec(line)
  if (match === null || typeof match.groups === 'undefined') {
    return null
  }
  return {
    marker: fenceMarkerTypeOf(match.groups.marker),
    length: match.groups.marker.length,
    rest: match.groups.rest,
  }
}

const closesFence = (line: string, fence: FenceMarker): boolean => {
  const marker = fenceMarkerOf(line)
  if (marker === null || marker.marker !== fence.marker || marker.length < fence.length) {
    return false
  }
  return /^[ \t]*$/.test(marker.rest)
}

interface SummaryLineResult {
  fence: FenceMarker | null
  hasSummary: boolean
}

const summaryLineResult = (line: string, fence: FenceMarker | null): SummaryLineResult => {
  if (fence !== null) {
    if (closesFence(line, fence)) {
      return { fence: null, hasSummary: false }
    }
    return { fence, hasSummary: false }
  }
  const marker = fenceMarkerOf(line)
  if (marker !== null) {
    return { fence: marker, hasSummary: false }
  }
  return { fence: null, hasSummary: isMarkdownSectionHeading(line, 'Summary') }
}

export const hasSummaryHeading = (body: string): boolean => {
  let fence: FenceMarker | null = null
  for (const line of body.split('\n')) {
    const { fence: nextFence, hasSummary } = summaryLineResult(line, fence)
    fence = nextFence
    if (hasSummary) {
      return true
    }
  }
  return false
}

const normalizeStdoutSummary = (body: string): string => {
  if (hasSummaryHeading(body)) {
    return body
  }
  return `# Summary\n\n${body}`
}

export const buildResponseFromStdoutText = (
  text: string,
  target: Omit<AssembleTarget, 'status'>,
  env: Env
): boolean => {
  const parts = reportPartsOfContent(text)
  if (parts === null || !validProtocolStatus(parts.status) || isWhitespaceOnly(parts.body)) {
    return false
  }
  return assembleResponse(
    { ...target, status: parts.status },
    normalizeStdoutSummary(parts.body),
    env
  )
}

export const STDOUT_TEXT_FRONT_MATTER_ERROR = 'The final response was missing valid front-matter.'

export const buildFailedResponseFromStdoutText = (
  target: Omit<AssembleTarget, 'status'>,
  env: Env
): boolean =>
  assembleResponse(
    { ...target, status: 'failed' },
    [
      '# Summary',
      'Child CLI failed or did not write a response.',
      '',
      '# Error',
      STDOUT_TEXT_FRONT_MATTER_ERROR,
      '',
    ].join('\n'),
    env
  )

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
  if (!envFlagEnabled(env, 'DELEGATE_CODEX_HOME_PRUNE')) {
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
  const { createTestScratchDir } = await import('./test-scratch.ts')

  const makeReportTestDir = (): string => createTestScratchDir('wrapper-report-test')

  type ReportInputMode = 'report_md' | 'stdout_text'

  const buildReportForMode = (input: {
    dir: string
    mode: ReportInputMode
    name: string
    content: string
  }): { ok: boolean; responseFile: string } => {
    const { dir, mode, name, content } = input
    const responseFile = path.join(dir, `delegate_chore_${mode}_${name}_res.json`)
    const target = {
      responderSessionId: `${mode}:test:${name}`,
      responseFile,
      runDir: dir,
    }
    if (mode === 'report_md') {
      const reportFile = writeTempFile(dir, `${mode}_${name}.md`, content)
      return { ok: buildResponseFromReportMd(reportFile, target, {}), responseFile }
    }
    return { ok: buildResponseFromStdoutText(content, target, {}), responseFile }
  }

  describe('reportModeForBackend', () => {
    it('uses the backend-specific report mode', () => {
      expect(reportModeForBackend('claude')).toBe('structured')
      expect(reportModeForBackend('codex')).toBe('structured')
      expect(reportModeForBackend('cursor')).toBe('report_md')
      expect(reportModeForBackend('devin')).toBe('report_md')
      expect(reportModeForBackend('grok')).toBe('report_md')
      expect(reportModeForBackend('opencode')).toBe('stdout_text')
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

  describe('front-matter parser', () => {
    const statusCases = [
      { name: 'normal', value: 'completed', accepted: true },
      { name: 'trimmed', value: '\t completed \t', accepted: true },
      { name: 'internal-space', value: 'com pleted', accepted: false },
      { name: 'internal-tab', value: 'com\tpleted', accepted: false },
      { name: 'uppercase', value: 'COMPLETED', accepted: false },
      { name: 'unknown', value: 'bogus', accepted: false },
      { name: 'empty', value: '', accepted: false },
    ] as const

    it.each(statusCases)('validates status values for both inputs: $name', (testCase) => {
      const dir = makeReportTestDir()
      for (const mode of ['report_md', 'stdout_text'] as const) {
        const content = `---\nstatus:${testCase.value}\n---\n# Summary\nstatus test\n`
        const result = buildReportForMode({ dir, mode, name: testCase.name, content })
        expect(result.ok).toBe(testCase.accepted)
      }
    })

    const frontMatterCases = [
      {
        name: 'lf',
        content: '---\nstatus: completed\n---\n# Summary\nlf\n',
        accepted: true,
        status: 'completed',
        keepsBodyDelimiter: false,
      },
      {
        name: 'crlf',
        content: '---\r\nstatus: completed\r\n---\r\n# Summary\r\ncrlf\r\n',
        accepted: true,
        status: 'completed',
        keepsBodyDelimiter: false,
      },
      {
        name: 'extra-key',
        content: '---\nstatus: partial\nmeta: ignored\n---\n# Summary\nextra\n',
        accepted: true,
        status: 'partial',
        keepsBodyDelimiter: false,
      },
      {
        name: 'late-closing',
        content: '---\nmeta: ignored\nstatus: needs_input\nnotes: ignored\n---\n# Summary\nlate\n',
        accepted: true,
        status: 'needs_input',
        keepsBodyDelimiter: false,
      },
      {
        name: 'missing-opening',
        content: 'status: completed\n---\n# Summary\nno\n',
        accepted: false,
      },
      {
        name: 'missing-closing',
        content: '---\nstatus: completed\n# Summary\nno\n',
        accepted: false,
      },
      {
        name: 'body-delimiter',
        content: '---\nstatus: completed\n---\n# Findings\nbefore\n---\nafter\n',
        accepted: true,
        status: 'completed',
        keepsBodyDelimiter: true,
      },
    ] as const

    it.each(frontMatterCases)(
      'parses front-matter boundaries for both inputs: $name',
      (testCase) => {
        const dir = makeReportTestDir()
        for (const mode of ['report_md', 'stdout_text'] as const) {
          const result = buildReportForMode({
            dir,
            mode,
            name: testCase.name,
            content: testCase.content,
          })
          expect(result.ok).toBe(testCase.accepted)
          if (testCase.accepted) {
            const parsed: unknown = JSON.parse(readFileOrEmpty(result.responseFile))
            expect(parsed).toMatchObject({ status: testCase.status })
            if (testCase.keepsBodyDelimiter) {
              expect(JSON.stringify(parsed)).toContain('---')
            }
          }
        }
      }
    )

    it('does not normalize a report_md body', () => {
      const dir = makeReportTestDir()
      const result = buildReportForMode({
        dir,
        mode: 'report_md',
        name: 'report-body',
        content: '---\nstatus: completed\n---\n# Findings\nreport body\n',
      })
      expect(result.ok).toBe(true)
      const parsed: unknown = JSON.parse(readFileOrEmpty(result.responseFile))
      expect(parsed).toMatchObject({ sections: ['# Findings\nreport body'] })
    })
  })

  describe('stdout Summary normalization', () => {
    const summaryCases = [
      { name: 'h1', body: '# Summary\nexplicit\n# Findings\nok\n', headings: 1 },
      { name: 'h2', body: '## Summary\nexplicit\n# Findings\nok\n', headings: 1 },
      {
        name: 'backtick-fence',
        body: '```\n# Summary\n```\n# Findings\nok\n',
        headings: 1,
      },
      {
        name: 'tilde-fence',
        body: '~~~\n## Summary\n~~~\n# Findings\nok\n',
        headings: 1,
      },
      {
        name: 'mismatched-fence',
        body: '```\n# Summary\n~~~\n# Summary\n```\n# Findings\nok\n',
        headings: 1,
      },
      { name: 'absent', body: '# Findings\nok\n', headings: 1 },
      {
        name: 'multiple',
        body: '# Summary\nfirst\n## Summary\nsecond\n# Findings\nok\n',
        headings: 2,
      },
    ] as const

    it.each(summaryCases)('matches Summary headings outside fences: $name', (testCase) => {
      const dir = makeReportTestDir()
      const result = buildReportForMode({
        dir,
        mode: 'stdout_text',
        name: testCase.name,
        content: `---\nstatus: completed\n---\n${testCase.body}`,
      })
      expect(result.ok).toBe(true)
      const parsed: unknown = JSON.parse(readFileOrEmpty(result.responseFile))
      if (!isRecord(parsed) || !Array.isArray(parsed.sections)) {
        throw new Error('response sections missing')
      }
      const sections = parsed.sections.filter(
        (section): section is string => typeof section === 'string'
      )
      const summarySections = sections.filter((section) =>
        isMarkdownSectionHeading(section.split('\n')[0], 'Summary')
      )
      expect(summarySections).toHaveLength(testCase.headings)
    })

    it('writes a fixed front-matter error for failed stdout collection', () => {
      const dir = makeReportTestDir()
      const responseFile = path.join(dir, 'stdout_failure_res.json')
      expect(
        buildFailedResponseFromStdoutText(
          { responderSessionId: 'opencode:model:failure', responseFile, runDir: dir },
          {}
        )
      ).toBe(true)
      const parsed: unknown = JSON.parse(readFileOrEmpty(responseFile))
      expect(JSON.stringify(parsed)).toContain(STDOUT_TEXT_FRONT_MATTER_ERROR)
      expect(parsed).toMatchObject({ status: 'failed' })
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
