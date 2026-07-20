import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'
import { md2idx } from 'md2idx'
import type { CliResult } from './cli-result.ts'
import type { Env } from './build-request.ts'
import {
  appendMetrics,
  bodyStats,
  estimatedTokens,
  metricsTimestamp,
  prettyJson,
  randomToken,
  writeCompanionMarkdown,
} from './protocol.ts'

// bash 版 build-response.sh と同一契約 (protocol v1)。
// Usage: build-response <status> <responder_session_id> <response_file>
// stdin: レポート本文 Markdown。response_file は main が事前確保したパス。
// stdout: response_file のパス（本文は親 context に入れない）
// exit: 2=引数 / status 不正 / 1=md2idx 失敗・空 index/sections

const VALID_STATUSES = new Set(['completed', 'partial', 'failed', 'needs_input'])

const failure = (exitCode: number, stderr: string): CliResult => ({
  exitCode,
  stderr,
  stdout: '',
})

interface BuildResponseContext {
  status: string
  responderSessionId: string
  responseFile: string
  env: Env
  stdin: Buffer
}

const writeSourceMarkdown = (context: BuildResponseContext): string => {
  const workDir = path.dirname(context.responseFile)
  mkdirSync(workDir, { recursive: true })
  const base = path.basename(context.responseFile, '.json')
  const srcMd = path.join(workDir, `${base}_repsrc_${randomToken(5)}.md`)
  const fd = openSync(srcMd, 'wx', 0o600)
  writeSync(fd, context.stdin)
  closeSync(fd)
  return srcMd
}

const appendBuildResponseMetrics = (context: BuildResponseContext, sectionCount: number): void => {
  const body = bodyStats(context.stdin)
  appendMetrics(context.env.DELEGATE_METRICS_FILE, {
    kind: 'build_response',
    ts: metricsTimestamp(),
    status: context.status,
    responder_session_id: context.responderSessionId,
    response_file: context.responseFile,
    body: {
      bytes: body.bytes,
      chars: body.chars,
      lines: body.lines,
      estimated_tokens: estimatedTokens(body.chars),
    },
    response: {
      bytes: statSync(context.responseFile).size,
      sections: sectionCount,
    },
  })
}

const emitResponse = (context: BuildResponseContext): CliResult => {
  const srcMd = writeSourceMarkdown(context)
  const { index, sections } = md2idx(context.stdin.toString('utf8'))
  writeFileSync(
    context.responseFile,
    prettyJson({
      protocol_version: 1,
      type: 'response',
      status: context.status,
      responder_session_id: context.responderSessionId,
      index,
      sections,
    }),
    { mode: 0o600 }
  )
  if (index.length === 0 || sections.length === 0) {
    // 失敗時は report Markdown をデバッグ用に残す
    return failure(
      1,
      `ERROR: md2idx が空の index/sections を返しました（report Markdown を確認してください）: ${srcMd}\n`
    )
  }
  writeCompanionMarkdown(context.responseFile, sections)
  unlinkSync(srcMd)
  appendBuildResponseMetrics(context, sections.length)
  return { exitCode: 0, stderr: '', stdout: `${context.responseFile}\n` }
}

export const runBuildResponse = (argv: readonly string[], env: Env, stdin: Buffer): CliResult => {
  if (argv.length < 3) {
    return failure(
      2,
      'Usage: build-response <status> <responder_session_id> <response_file>  (report markdown on stdin)\n'
    )
  }
  const [status, responderSessionId, responseFile] = argv
  if (!VALID_STATUSES.has(status)) {
    return failure(
      2,
      `ERROR: status は completed|partial|failed|needs_input のいずれか: ${status}\n`
    )
  }
  return emitResponse({ status, responderSessionId, responseFile, env, stdin })
}

// in-source test 専用 helper (bundle からは treeshake で除去される)
const makeTestResponsePath = (): string => {
  mkdirSync('.temp', { recursive: true })
  return `.temp/build-response-test-${randomToken(8)}_res.json`
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  const responsePath = makeTestResponsePath
  describe('runBuildResponse', () => {
    it('fails closed with exit 2 on missing args or an unknown status', () => {
      expect(runBuildResponse(['completed'], {}, Buffer.alloc(0)).exitCode).toBe(2)
      expect(runBuildResponse(['bogus', 'sid', 'x.json'], {}, Buffer.alloc(0)).exitCode).toBe(2)
    })

    it('writes the response envelope and prints the response path', () => {
      const file = responsePath()
      const result = runBuildResponse(
        ['completed', 'worker-1', file],
        {},
        Buffer.from('# Summary\n\nできた\n')
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe(`${file}\n`)
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
        protocol_version: 1,
        type: 'response',
        status: 'completed',
        responder_session_id: 'worker-1',
        sections: ['# Summary\n\nできた'],
      })
    })

    it('fails closed with exit 1 on an empty report, keeping the source markdown', () => {
      const result = runBuildResponse(['failed', 'w', responsePath()], {}, Buffer.alloc(0))
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('repsrc')
    })
  })
}
