import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { backendFromModel } from './backend.ts'
import type { Env } from './build-request.ts'
import type { CliResult } from './cli-result.ts'
import { getPath, hasFileContent, readFileOrEmpty, stringOf } from './jq-compat.ts'
import { splitModelEffort, validateModelEffort, type EffectiveEffort } from './observe-effort.ts'
import { writeFailedResponse } from './observe-followup.ts'
import {
  heartbeat,
  importStreams,
  initObserve,
  recordEffort,
  recordTiming,
  recordUsage,
  resumeUnavailable,
  updateBackendSession,
  updateRunContext,
} from './observe-store.ts'
import {
  buildResponseFromReportMd,
  buildResponseFromStructured,
  writeCompanionFromResponse,
} from './wrapper-report.ts'
import type { WaitResult } from './wrapper-wait.ts'

// backend wrapper 4 本（claude / codex / cursor / devin）の左右対称な共通部。
// 引数解析 / finish_without_child / 応答補完 / usage・effort 記録 / session 記録を
// 型付き設定オブジェクト経由で共有し、backend 固有部のみ各 wrapper 実装に残す。

export const quietly = (operation: () => void): void => {
  try {
    operation()
  } catch {
    // bash 版の || true と同じく観測系の失敗で wrapper 本体を止めない
  }
}

export interface WrapperArgs {
  originalModel: string
  taskType: string
  requestFile: string
  responseFile: string
  runDir: string
  observeFile: string
  sessionMode: string
  resumeArg: string
  sessionHome: string
}

const argOrDefault = (value: string | undefined, fallback: string): string => {
  if (typeof value === 'string' && value !== '') {
    return value
  }
  return fallback
}

export const parseWrapperArgs = (
  argv: readonly string[],
  usageName: string
): WrapperArgs | CliResult => {
  if (argv.length < 4) {
    return {
      exitCode: 2,
      stderr: `Usage: ${usageName} <model> <task_type> <request_file> <response_file> [run_dir] [observe_file] [session_mode] [resume_arg] [session_home]\n`,
      stdout: '',
    }
  }
  const [originalModel, taskType, requestFile, responseFile] = argv
  const runBase = responseFile.replace(/_res\.json$/, '')
  return {
    originalModel,
    taskType,
    requestFile,
    responseFile,
    runDir: argOrDefault(argv[4], runBase),
    observeFile: argOrDefault(argv[5], `${runBase}_observe.json`),
    sessionMode: argv[6] ?? '',
    resumeArg: argv[7] ?? '',
    sessionHome: argv[8] ?? '',
  }
}

export interface WrapperContext {
  args: WrapperArgs
  backend: string
  env: Env
  scriptsDir: string
  workDir: string
  stdoutCapture: string
  stderrCapture: string
  repoRoot: string
  baseModel: string
  effort: string
}

const gitRepoRoot = (): string => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trimEnd()
  } catch {
    return process.cwd()
  }
}

export const makeWrapperContext = (
  args: WrapperArgs,
  io: { env: Env; scriptsDir: string }
): WrapperContext => {
  const workDir = args.runDir
  mkdirSync(path.join(workDir, 'tmp'), { recursive: true })
  const split = splitModelEffort(args.originalModel)
  const context: WrapperContext = {
    args,
    backend: backendFromModel(args.originalModel),
    env: io.env,
    scriptsDir: io.scriptsDir,
    workDir,
    stdoutCapture: path.join(workDir, 'worker-stdout.capture'),
    stderrCapture: path.join(workDir, 'worker-stderr.capture'),
    repoRoot: gitRepoRoot(),
    baseModel: split.base_model,
    effort: split.effort ?? '',
  }
  writeFileSync(context.stdoutCapture, '')
  writeFileSync(context.stderrCapture, '')
  if (!hasFileContent(args.observeFile)) {
    initObserve({
      observeFile: args.observeFile,
      runDir: workDir,
      taskType: args.taskType,
      model: args.originalModel,
      backend: context.backend,
      requestFile: args.requestFile,
      responseFile: args.responseFile,
      requesterSessionId: '',
    })
  }
  return context
}

export const recordRunContext = (context: WrapperContext): void => {
  const mode = context.args.sessionMode
  if (mode === 'resumable' || mode === 'followup') {
    quietly(() => {
      updateRunContext(context.args.observeFile, context.workDir, {
        repoRoot: context.repoRoot,
        worktreeRoot: context.repoRoot,
      })
    })
  }
}

// 子を起動できない失敗の共通終端。stderr capture へ理由を残し、failed response を
// 生成して response パスだけを stdout へ返す（bash 版 finish_without_child と同一）
export const finishWithoutChild = (
  context: WrapperContext,
  exitCode: number,
  message: string
): CliResult => {
  writeFileSync(context.stderrCapture, `${message}\n`)
  quietly(() => {
    writeFailedResponse(
      {
        observeFile: context.args.observeFile,
        runDir: context.workDir,
        backend: context.backend,
        responseFile: context.args.responseFile,
        exitCode,
      },
      context.env
    )
  })
  heartbeat(context.args.observeFile, context.workDir, {
    backend: context.backend,
    childPid: process.pid,
    stdoutCapture: context.stdoutCapture,
    stderrCapture: context.stderrCapture,
  })
  importStreams(context.args.observeFile, context.workDir, {
    stdoutCapture: context.stdoutCapture,
    stderrCapture: context.stderrCapture,
    env: context.env,
  })
  recordRunContext(context)
  return { exitCode, stdout: `${context.args.responseFile}\n`, stderr: '' }
}

// prepare を経ない直接起動でも不正な effort 指定を黙って通さない（二重検証）
export const effortFailure = (context: WrapperContext): CliResult | null => {
  const validation = validateModelEffort(context.backend, context.args.originalModel)
  if (validation.ok) {
    return null
  }
  return finishWithoutChild(context, 6, validation.message)
}

export const responderSessionIdOf = (context: WrapperContext, cliModel: string): string =>
  `${context.backend}:${cliModel}:${path.basename(context.args.responseFile, '.json')}`

// 初期 prompt の共通骨格。step 3 以降だけ backend の報告方式で分岐する
export const workerPrompt = (
  context: WrapperContext,
  requestStep: string,
  parts: { constraints: string; tailLines: readonly string[] }
): string =>
  [
    `あなたは delegate-skills の隔離ワーカー（task_type=${context.args.taskType}）です。protocol v1 に従ってください。`,
    '',
    requestStep,
    `2. リクエストの指示に従って作業する。AGENTS.md / CLAUDE.md の規約に従うこと。${parts.constraints}`,
    '   長時間走り得るコマンドは `timeout` 付きで実行し、headless 実行するスクリプトには必ず終了処理（quit 等）を入れ、検証コマンドをバックグラウンド化して放置しない。',
    ...parts.tailLines,
  ].join('\n')

export const STRUCTURED_REPORT_HEAD_LINES = [
  '3. 作業完了後、最終応答として構造化出力 {status, report_markdown} だけを返す。status は completed | partial | failed | needs_input のいずれか。report_markdown は見出し',
  '   Summary / Changed files / Commands / Verification / Findings / Blockers / Error の Markdown。',
  '   report は簡潔に書く: Summary は 5 行以内。Findings は重要なものに絞る。コマンドの生ログは貼らず、Verification は実行コマンドと結果（exit code / pass・fail）のみ。該当が無い見出しは省く。',
] as const

export const reportMdTailLines = (reportFile: string): string[] => [
  `3. 作業報告を front-matter 付き Markdown で "${reportFile}" に 1 回の書込で作る。ファイルの 1 行目から`,
  '   ---',
  '   status: <completed | partial | failed | needs_input のいずれか>',
  '   ---',
  '   の front-matter を置き、その下に見出し Summary / Changed files / Commands / Verification / Findings / Blockers / Error の本文を書く。',
  '   report は簡潔に書く: Summary は 5 行以内。Findings は重要なものに絞る。コマンドの生ログは貼らず、Verification は実行コマンドと結果（exit code / pass・fail）のみ。該当が無い見出しは省く。',
  '   md2idx / jq / build-response.sh によるレスポンス生成はしない（レスポンス生成は wrapper が行う）。',
  '4. 最終応答は status の一語のみ。',
]

export const writePromptFile = (context: WrapperContext, prompt: string): string => {
  const promptFile = path.join(context.workDir, 'worker-prompt.txt')
  writeFileSync(promptFile, prompt)
  return promptFile
}

export interface CompletionConfig {
  responderSessionId: string
  reportMode: 'structured' | 'report_md'
  // structured モード: capture / last-message から構造化出力を取り出す
  collectStructured?: () => Record<string, unknown> | null
  // report_md モード: worker が書く report.md のパス
  reportFile?: string
  devinExport?: string
}

export interface CompletionOutcome {
  reportReadyMs: number | null
  structuredParse: boolean | null
}

const completeStructured = (
  context: WrapperContext,
  config: CompletionConfig,
  wait: WaitResult
): CompletionOutcome => {
  const outcome: CompletionOutcome = { reportReadyMs: wait.reportReadyMs, structuredParse: false }
  const collect = config.collectStructured
  let structured: Record<string, unknown> | null = null
  if (typeof collect !== 'undefined') {
    structured = collect()
  }
  if (
    structured !== null &&
    buildResponseFromStructured(
      structured,
      {
        responderSessionId: config.responderSessionId,
        responseFile: context.args.responseFile,
        runDir: context.workDir,
      },
      context.env
    )
  ) {
    outcome.structuredParse = true
    outcome.reportReadyMs ??= wait.totalMs
  }
  return outcome
}

const completeReportMd = (
  context: WrapperContext,
  config: CompletionConfig,
  wait: WaitResult
): CompletionOutcome => {
  quietly(() => {
    buildResponseFromReportMd(
      config.reportFile ?? '',
      {
        responderSessionId: config.responderSessionId,
        responseFile: context.args.responseFile,
        runDir: context.workDir,
      },
      context.env
    )
  })
  const outcome: CompletionOutcome = { reportReadyMs: wait.reportReadyMs, structuredParse: null }
  if (hasFileContent(context.args.responseFile)) {
    outcome.reportReadyMs ??= wait.totalMs
  }
  return outcome
}

const completeMissingResponse = (
  context: WrapperContext,
  config: CompletionConfig,
  wait: WaitResult
): CompletionOutcome => {
  if (config.reportMode === 'structured') {
    return completeStructured(context, config, wait)
  }
  return completeReportMd(context, config, wait)
}

// 構造化最終応答 / report.md の回収 → wrapper 側で response を組み立てる。
// parse 失敗は failed response へ倒す（fail-closed。後段の response 欠落分岐が処理する）
export const completeResponse = (
  context: WrapperContext,
  config: CompletionConfig,
  wait: WaitResult
): CompletionOutcome => {
  let outcome: CompletionOutcome = { reportReadyMs: wait.reportReadyMs, structuredParse: null }
  if (!hasFileContent(context.args.responseFile)) {
    outcome = completeMissingResponse(context, config, wait)
  }
  quietly(() => {
    recordTiming({
      observeFile: context.args.observeFile,
      runDir: context.workDir,
      backend: context.backend,
      stdoutCapture: context.stdoutCapture,
      totalMs: wait.totalMs,
      firstUsefulMs: wait.firstUsefulMs,
      reportReadyMs: outcome.reportReadyMs,
      devinExport: config.devinExport ?? '',
      structuredOutputParse: outcome.structuredParse,
    })
  })
  return outcome
}

export interface ResponseOutcome {
  responseStatus: number
  responseAllowsResume: boolean
  stderrTail: string
}

const failedResponseOutcome = (context: WrapperContext, childStatus: number): ResponseOutcome => {
  let responseStatus = childStatus
  if (responseStatus === 0) {
    responseStatus = 1
  }
  let stderrTail = ''
  const written = ((): boolean => {
    try {
      return writeFailedResponse(
        {
          observeFile: context.args.observeFile,
          runDir: context.workDir,
          backend: context.backend,
          responseFile: context.args.responseFile,
          exitCode: responseStatus,
        },
        context.env
      )
    } catch {
      return false
    }
  })()
  if (!written) {
    stderrTail = readFileOrEmpty(context.stderrCapture)
  }
  return { responseStatus, responseAllowsResume: false, stderrTail }
}

// response 欠落は failed response へ倒し、生成済みなら companion md を派生させる。
// resume 可否は「worker 自身が failed 以外の response を書けた」ことを条件にする
export const finalizeResponse = (context: WrapperContext, childStatus: number): ResponseOutcome => {
  if (!hasFileContent(context.args.responseFile)) {
    return failedResponseOutcome(context, childStatus)
  }
  writeCompanionFromResponse(context.args.responseFile)
  const status = ((): string => {
    try {
      return stringOf(getPath(JSON.parse(readFileOrEmpty(context.args.responseFile)), ['status']))
    } catch {
      return ''
    }
  })()
  return {
    responseStatus: childStatus,
    responseAllowsResume: status !== '' && status !== 'failed',
    stderrTail: '',
  }
}

export interface UsageRecordingConfig {
  usageSource: string
  measuredUsage: () => Record<string, unknown> | null
  effortRequested: string
  effortEffective?: () => EffectiveEffort | null
}

const measuredUsageQuietly = (config: UsageRecordingConfig): Record<string, unknown> | null => {
  try {
    return config.measuredUsage()
  } catch {
    return null
  }
}

const effectiveEffortQuietly = (config: UsageRecordingConfig): Record<string, unknown> | null => {
  const extract = config.effortEffective
  if (typeof extract === 'undefined') {
    return null
  }
  try {
    const effective = extract()
    if (effective === null) {
      return null
    }
    return { ...effective }
  } catch {
    return null
  }
}

export const recordUsageAndEffort = (
  context: WrapperContext,
  config: UsageRecordingConfig
): void => {
  quietly(() => {
    recordUsage({
      observeFile: context.args.observeFile,
      runDir: context.workDir,
      backend: context.backend,
      model: context.args.originalModel,
      requestFile: context.args.requestFile,
      responseFile: context.args.responseFile,
      source: config.usageSource,
      measured: measuredUsageQuietly(config),
    })
  })
  quietly(() => {
    recordEffort(context.args.observeFile, context.workDir, {
      requested: config.effortRequested,
      effective: effectiveEffortQuietly(config),
    })
  })
}

export interface SessionOutcomeInput {
  childStatus: number
  responseAllowsResume: boolean
  resumeId: string
  resumeSource: string
  homeDir: string
  failReason: string
  missingIdReason: string
}

// resumable 初回 run の backend_session 記録（bash 版の 3 分岐と同一）
export const recordResumableOutcome = (
  context: WrapperContext,
  input: SessionOutcomeInput
): void => {
  const ok = input.childStatus === 0 && input.responseAllowsResume
  if (ok && input.resumeId !== '') {
    quietly(() => {
      updateBackendSession(context.args.observeFile, context.workDir, {
        backend: context.backend,
        model: context.args.originalModel,
        resumeId: input.resumeId,
        resumeSource: input.resumeSource,
        persistence: 'resumable',
        homeDir: input.homeDir,
      })
    })
    return
  }
  const reason = ((): string => {
    if (input.childStatus !== 0 || !input.responseAllowsResume) {
      return input.failReason
    }
    return input.missingIdReason
  })()
  quietly(() => {
    resumeUnavailable(context.args.observeFile, context.workDir, {
      backend: context.backend,
      model: context.args.originalModel,
      reason,
      homeDir: input.homeDir,
    })
  })
}

export interface FollowupOutcomeInput {
  childStatus: number
  responseAllowsResume: boolean
  resumeId: string
  resumeSource: string
  homeDir: string
  failReason: string
}

// follow-up run の backend_session 記録（bash 版の 2 分岐と同一）
export const recordFollowupOutcome = (
  context: WrapperContext,
  input: FollowupOutcomeInput
): void => {
  if (input.childStatus === 0 && input.responseAllowsResume) {
    quietly(() => {
      updateBackendSession(context.args.observeFile, context.workDir, {
        backend: context.backend,
        model: context.args.originalModel,
        resumeId: input.resumeId,
        resumeSource: input.resumeSource,
        persistence: 'resumable',
        homeDir: input.homeDir,
      })
    })
    return
  }
  quietly(() => {
    resumeUnavailable(context.args.observeFile, context.workDir, {
      backend: context.backend,
      model: context.args.originalModel,
      reason: input.failReason,
      homeDir: input.homeDir,
    })
  })
}

// wrapper の正常系終端: response パスだけを stdout に返す
export const wrapperResult = (context: WrapperContext, outcome: ResponseOutcome): CliResult => {
  recordRunContext(context)
  return {
    exitCode: outcome.responseStatus,
    stdout: `${context.args.responseFile}\n`,
    stderr: outcome.stderrTail,
  }
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  const { readFileSync } = await import('node:fs')

  const makeCommonTestContext = (): WrapperContext => {
    mkdirSync('.temp', { recursive: true })
    const dir = `.temp/wrapper-common-test-${Math.random().toString(36).slice(2)}`
    mkdirSync(dir)
    const args: WrapperArgs = {
      originalModel: 'haiku',
      taskType: 'chore',
      requestFile: path.join(dir, 'delegate_chore_x_req.json'),
      responseFile: path.join(dir, 'delegate_chore_x_res.json'),
      runDir: dir,
      observeFile: path.join(dir, 'delegate_chore_x_observe.json'),
      sessionMode: '',
      resumeArg: '',
      sessionHome: '',
    }
    return makeWrapperContext(args, { env: {}, scriptsDir: dir })
  }

  describe('parseWrapperArgs', () => {
    it('fails closed with exit 2 and derives run_dir / observe_file defaults', () => {
      const usage = parseWrapperArgs(['haiku'], 'delegate-claude.sh')
      expect('exitCode' in usage && usage.exitCode).toBe(2)
      const parsed = parseWrapperArgs(['haiku', 'chore', 'req.json', '/w/run_res.json'], 'x')
      expect(parsed).toMatchObject({
        runDir: '/w/run',
        observeFile: '/w/run_observe.json',
        sessionMode: '',
      })
    })
  })

  describe('finishWithoutChild', () => {
    it('writes a failed response, records streams, and returns the response path', () => {
      const context = makeCommonTestContext()
      const result = finishWithoutChild(context, 3, 'ERROR: claude CLI が見つかりません。')
      expect(result.exitCode).toBe(3)
      expect(result.stdout).toBe(`${context.args.responseFile}\n`)
      expect(JSON.parse(readFileSync(context.args.responseFile, 'utf8'))).toMatchObject({
        status: 'failed',
      })
      const observe: unknown = JSON.parse(readFileSync(context.args.observeFile, 'utf8'))
      expect(JSON.stringify(observe)).toContain('failed_response_written')
      expect(observe).toMatchObject({
        streams: { stderr: { content: 'ERROR: claude CLI が見つかりません。\n' } },
      })
    })
  })

  describe('finalizeResponse', () => {
    it('falls back to a failed response with a non-zero status when the response is missing', () => {
      const context = makeCommonTestContext()
      const outcome = finalizeResponse(context, 0)
      expect(outcome.responseStatus).toBe(1)
      expect(outcome.responseAllowsResume).toBe(false)
      expect(hasFileContent(context.args.responseFile)).toBe(true)
    })

    it('derives companion markdown and resume permission from a worker response', () => {
      const context = makeCommonTestContext()
      writeFileSync(
        context.args.responseFile,
        JSON.stringify({ status: 'completed', sections: ['# Summary\nok'] })
      )
      const outcome = finalizeResponse(context, 0)
      expect(outcome).toMatchObject({ responseStatus: 0, responseAllowsResume: true })
      expect(readFileSync(`${context.args.responseFile.replace(/\.json$/, '')}.md`, 'utf8')).toBe(
        '# Summary\nok\n'
      )
    })
  })

  describe('workerPrompt', () => {
    it('assembles the shared skeleton with backend tail lines', () => {
      const context = makeCommonTestContext()
      const prompt = workerPrompt(context, '1. リクエストを読む: ...', {
        constraints: '',
        tailLines: STRUCTURED_REPORT_HEAD_LINES,
      })
      expect(prompt).toContain('task_type=chore')
      expect(prompt).toContain('構造化出力 {status, report_markdown}')
      expect(prompt.endsWith('\n')).toBe(false)
    })
  })
}
