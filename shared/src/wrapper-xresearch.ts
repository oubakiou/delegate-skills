import { spawnSync } from 'node:child_process'
import path from 'node:path'
import type { Env } from './build-request.ts'
import type { CliResult } from './cli-result.ts'
import { recordEffort } from './observe-store.ts'
import {
  completeResponse,
  envOrDefault,
  finalizeResponse,
  quietly,
  responderSessionIdOf,
  type WrapperContext,
} from './wrapper-common.ts'
import {
  endDedicatedDispatch,
  finishDedicated,
  makeDedicatedContext,
  parseDedicatedArgs,
  startDedicatedDispatch,
  type DedicatedLifecycle,
} from './wrapper-dedicated.ts'
import { requestPromptStep, REQUEST_ARGV_INLINE_MAX } from './wrapper-report.ts'
import {
  commandAvailable,
  spawnWorker,
  waitWithHeartbeat,
  type WaitResult,
} from './wrapper-wait.ts'

// bash 版 delegate-x-research-grok.sh と同一契約の delegate-x-research 専用
// Grok CLI 子プロセス起動ラッパ。stdout: response_file のパスのみ

const availableGrokModels = (env: Env): string[] => {
  const listed = spawnSync('grok', ['models'], {
    encoding: 'utf8',
    env: { ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const models: string[] = []
  for (const line of (listed.stdout ?? '').split('\n')) {
    const match = /^\s*[-*]\s+(?<model>\S+)/.exec(line)
    if (match !== null && typeof match.groups !== 'undefined') {
      models.push(match.groups.model)
    }
  }
  return models
}

// 要求モデルが CLI に無い場合は既定 grok-build へ fallback する（bash 版と同一の WARN 付き）
const resolveGrokModel = (context: WrapperContext): string => {
  const requested = context.args.originalModel
  const models = availableGrokModels(context.env)
  if (!models.includes(requested) && models.includes('grok-build')) {
    process.stderr.write(
      `WARN: Grok CLI model '${requested}' is unavailable; falling back to 'grok-build'.\n`
    )
    return 'grok-build'
  }
  return requested
}

const xresearchPrompt = (parts: { requestStep: string; reportFile: string }): string =>
  [
    'あなたは delegate-skills の x.com 調査ワーカー（task_type=xresearch）です。protocol v1 に従ってください。',
    '',
    parts.requestStep,
    '2. リクエストの Scope に従い、利用可能な X / x.com 調査能力と web search を使って調査する。AGENTS.md / CLAUDE.md の規約に従うこと。',
    '3. 投稿URL、投稿者、投稿日時、確認時刻、検索語を Sources / Method に残す。事実、推測、未確認情報を混ぜない。',
    '4. 非公開・削除済み・ログイン不足・検索結果の偏り・時点依存がある場合は、Limitations または Blockers に書く。',
    `5. 作業報告を front-matter 付き Markdown で "${parts.reportFile}" に 1 回の書込で作る。ファイルの 1 行目から`,
    '   ---',
    '   status: <completed | partial | failed | needs_input のいずれか>',
    '   ---',
    '   の front-matter を置き、その下に見出し Summary / Findings / Sources / Method / Limitations / Blockers の本文を書く。',
    '   report は簡潔に書く: Summary は 5 行以内。Findings は重要なものに絞り、探索ログや検索結果の生貼りはしない。該当が無い見出しは省く。',
    '   md2idx / jq によるレスポンス生成はしない（レスポンス生成は wrapper が行う）。リポジトリ root に report.md を作らない。',
    '6. 最終応答は status の一語のみ。',
  ].join('\n')

const grokCliArgs = (context: WrapperContext, run: { model: string; prompt: string }): string[] => {
  const args = [
    '--no-auto-update',
    '-p',
    run.prompt,
    '-m',
    run.model,
    '--cwd',
    context.repoRoot,
    '--no-memory',
    '--permission-mode',
    envOrDefault(context.env, 'GROK_DELEGATE_PERMISSION_MODE', 'bypassPermissions'),
    '--output-format',
    'plain',
  ]
  const sandbox = context.env.GROK_DELEGATE_SANDBOX ?? ''
  if (sandbox !== '') {
    args.push('--sandbox', sandbox)
  }
  return args
}

const finalizeXresearchRun = (
  context: WrapperContext,
  run: { model: string; reportFile: string; lifecycle: DedicatedLifecycle },
  wait: WaitResult
): CliResult => {
  completeResponse(
    context,
    {
      responderSessionId: responderSessionIdOf(context, run.model),
      reportMode: 'report_md',
      reportFile: run.reportFile,
    },
    wait
  )
  const outcome = finalizeResponse(context, wait.childStatus)
  quietly(() => {
    recordEffort(context.args.observeFile, context.workDir, { requested: '' })
  })
  endDedicatedDispatch(context, {
    lifecycle: run.lifecycle,
    exitCode: outcome.responseStatus,
    effectiveModel: run.model,
  })
  return {
    exitCode: outcome.responseStatus,
    stdout: `${context.args.responseFile}\n`,
    stderr: outcome.stderrTail,
  }
}

const runXresearchChild = async (
  context: WrapperContext,
  lifecycle: DedicatedLifecycle
): Promise<CliResult> => {
  const model = resolveGrokModel(context)
  const reportFile = path.join(context.workDir, 'report.md')
  // grok CLI の stdin / --prompt-file は未実測のため prompt は argv で渡す。argv 経路は
  // 単一引数上限（MAX_ARG_STRLEN）に収まる縮小 gate を適用する
  const requestStep = requestPromptStep(context.args.requestFile, {
    scriptsDir: context.scriptsDir,
    env: context.env,
    maxOverride: String(REQUEST_ARGV_INLINE_MAX),
  })
  const prompt = xresearchPrompt({ requestStep: requestStep.step, reportFile })
  const worker = spawnWorker({
    command: 'grok',
    args: grokCliArgs(context, { model, prompt }),
    cwd: process.cwd(),
    env: { ...context.env, TMPDIR: path.join(context.workDir, 'tmp') },
    stdinFile: null,
    stdoutCapture: context.stdoutCapture,
    stderrCapture: context.stderrCapture,
  })
  const wait = await waitWithHeartbeat({
    observeFile: context.args.observeFile,
    runDir: context.workDir,
    backend: context.backend,
    worker,
    stdoutCapture: context.stdoutCapture,
    stderrCapture: context.stderrCapture,
    responseFile: context.args.responseFile,
    env: context.env,
  })
  return finalizeXresearchRun(context, { model, reportFile, lifecycle }, wait)
}

export const runWrapperXresearch = async (
  argv: readonly string[],
  env: Env,
  io: { scriptsDir: string }
): Promise<CliResult> => {
  const parsed = parseDedicatedArgs(argv, 'delegate-x-research-grok.sh')
  if ('exitCode' in parsed) {
    return parsed
  }
  const context = makeDedicatedContext(
    parsed,
    { taskType: 'xresearch', backend: 'grok' },
    { env, scriptsDir: io.scriptsDir }
  )
  const lifecycle = startDedicatedDispatch(context)
  if (!commandAvailable('grok', env)) {
    return finishDedicated(context, lifecycle, {
      exitCode: 3,
      message: 'ERROR: grok CLI が見つかりません。',
    })
  }
  return runXresearchChild(context, lifecycle)
}
