import { spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Env } from './build-request.ts'
import type { CliResult } from './cli-result.ts'
import { mcpExtractCursorGlobal, mcpHasServers, mcpRenderCursorMcpJson } from './delegate-mcp.ts'
import { effortFromCursorConfig } from './observe-effort.ts'
import { hasFileContent } from './jq-compat.ts'
import { resumeUnavailable, updateMcpConfig } from './observe-store.ts'
import { usageFromCapture } from './observe-usage.ts'
import { promptConstraints } from './prompt-constraints.ts'
import {
  completeResponse,
  effortFailure,
  finalizeResponse,
  finishWithoutChild,
  makeWrapperContext,
  parseWrapperArgs,
  quietly,
  recordFollowupOutcome,
  recordResumableOutcome,
  recordUsageAndEffort,
  reportMdTailLines,
  responderSessionIdOf,
  workerPrompt,
  wrapperResult,
  writePromptFile,
  type WrapperContext,
} from './wrapper-common.ts'
import { reportModeForBackend, requestPromptStep } from './wrapper-report.ts'
import {
  commandAvailable,
  spawnWorker,
  waitWithHeartbeat,
  type WaitResult,
} from './wrapper-wait.ts'

// bash 版 delegate-cursor.sh と同一契約の composer-* / cursor-* モデル向け
// Cursor agent CLI 子プロセス起動ラッパ。
// stdout: response_file のパスのみ（本文は親 context に入れない）

const stripCursorPrefix = (baseModel: string): string => {
  if (baseModel.startsWith('cursor-')) {
    return baseModel.slice('cursor-'.length)
  }
  return baseModel
}

// 検証済みの effort を bracket parameter override へ変換する。パラメータ名はモデル別
// （PoC 実測。docs/archive/delegate-effort-suffix.archive.md §2）
const cursorCliModelOf = (context: WrapperContext, model: string): string | CliResult => {
  if (context.effort === '') {
    return model
  }
  if (model === 'glm-5.2') {
    return `glm-5.2[reasoning=${context.effort}]`
  }
  if (model === 'grok-4.5') {
    return `grok-4.5[effort=${context.effort}]`
  }
  return finishWithoutChild(
    context,
    6,
    `ERROR: no bracket override mapping for cursor model '${context.args.originalModel}'`
  )
}

// Cursor agent CLI は起動時に <config dir>/cli-config.json を tmp ファイル + rename で
// 書き換えるため、共有 config のままだと並列 dispatch 同士で rename が競合し
// 片方が ENOENT で即死し得る。CURSOR_CONFIG_DIR を run_dir 配下へ隔離し、
// authInfo を含む既存 cli-config.json をコピーしてログインを維持する
// （codex backend の CODEX_HOME 隔離と対称）。config dir の解決順
// （CURSOR_CONFIG_DIR → XDG_CONFIG_HOME/cursor → ~/.cursor）は CLI 本体と揃える。
// CURSOR_CONFIG_DIR 未対応の古い CLI では無視され、従来の共有 config 動作になる
const realCursorConfigDirOf = (env: Env): string => {
  const configured = env.CURSOR_CONFIG_DIR ?? ''
  if (configured !== '') {
    return configured
  }
  const xdg = env.XDG_CONFIG_HOME ?? ''
  if (xdg !== '') {
    return path.join(xdg, 'cursor')
  }
  return path.join(env.HOME ?? '', '.cursor')
}

const isolateCursorConfig = (context: WrapperContext): string => {
  const isolated = path.join(context.workDir, 'cursor-config')
  mkdirSync(isolated, { recursive: true })
  const realConfig = path.join(realCursorConfigDirOf(context.env), 'cli-config.json')
  quietly(() => {
    if (hasFileContent(realConfig)) {
      copyFileSync(realConfig, path.join(isolated, 'cli-config.json'))
    }
  })
  return isolated
}

interface CursorMcp {
  source: 'injected' | 'none'
  servers: string[]
}

const setupCursorMcp = (context: WrapperContext, isolatedConfigDir: string): CursorMcp => {
  const canonical = mcpExtractCursorGlobal(
    path.join(realCursorConfigDirOf(context.env), 'mcp.json')
  )
  if (mcpHasServers(canonical)) {
    writeFileSync(path.join(isolatedConfigDir, 'mcp.json'), mcpRenderCursorMcpJson(canonical))
    return { source: 'injected', servers: Object.keys(canonical) }
  }
  return { source: 'none', servers: [] }
}

// cursor-agent の create-chat は起動途中で racy に停止し、stdin を /dev/null に
// 固定していても無応答の孤児プロセスとして残り得る。正常応答は 2〜5 秒で返るため、
// timeout で打ち切って最大 3 回まで再試行する
const createChatOnce = (context: WrapperContext, isolatedConfigDir: string): string => {
  const attempt = spawnSync('timeout', ['-k', '5', '45', 'agent', 'create-chat'], {
    encoding: 'utf8',
    env: {
      ...context.env,
      CURSOR_CONFIG_DIR: isolatedConfigDir,
      TMPDIR: path.join(context.workDir, 'tmp'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  quietly(() => {
    appendFileSync(path.join(context.workDir, 'cursor-create-chat.stderr'), attempt.stderr ?? '')
  })
  // 失敗時の stdout は診断出力の可能性があり chat id として信用できない
  if (attempt.status !== 0) {
    return ''
  }
  const lines = (attempt.stdout ?? '').trimEnd().split('\n')
  return lines[lines.length - 1].replaceAll('\r', '')
}

const createCursorChat = (context: WrapperContext, isolatedConfigDir: string): string => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const chatId = createChatOnce(context, isolatedConfigDir)
    if (chatId !== '') {
      return chatId
    }
  }
  return ''
}

const setupCursorChat = (
  context: WrapperContext,
  isolatedConfigDir: string
): string | CliResult => {
  const { sessionMode, resumeArg } = context.args
  if (sessionMode === 'followup') {
    return resumeArg
  }
  if (sessionMode !== 'resumable') {
    return ''
  }
  const chatId = createCursorChat(context, isolatedConfigDir)
  if (chatId === '') {
    quietly(() => {
      resumeUnavailable(context.args.observeFile, context.workDir, {
        backend: context.backend,
        model: context.args.originalModel,
        reason: 'Cursor create-chat failed',
        homeDir: '',
      })
    })
    return finishWithoutChild(context, 5, 'ERROR: agent create-chat failed.')
  }
  return chatId
}

const cursorSessionModeFailure = (context: WrapperContext): CliResult | null => {
  const { sessionMode, resumeArg } = context.args
  if (sessionMode === 'followup' && resumeArg === '') {
    return finishWithoutChild(context, 5, 'ERROR: follow-up requires resume_id.')
  }
  if (sessionMode !== '' && sessionMode !== 'resumable' && sessionMode !== 'followup') {
    return finishWithoutChild(
      context,
      2,
      `ERROR: session_mode must be empty, resumable, or followup: ${sessionMode}`
    )
  }
  return null
}

// stream-json は最終 result イベントに実測 usage を含み、イベントが逐次流れるため
// stream 無変化ベースの stall 検出も機能する（text モードは応答完了まで無音）
const cursorCliArgs = (
  cursorCliModel: string,
  session: { mcpSource: string; chatId: string }
): string[] => {
  const args = ['-p', '--trust', '--force', '--model', cursorCliModel]
  args.push('--output-format', 'stream-json')
  if (session.mcpSource === 'injected') {
    args.push('--approve-mcps')
  }
  if (session.chatId !== '') {
    args.push('--resume', session.chatId)
  }
  return args
}

const recordCursorSessionOutcome = (
  context: WrapperContext,
  chatId: string,
  outcome: { childStatus: number; responseAllowsResume: boolean }
): void => {
  if (context.args.sessionMode === 'resumable') {
    recordResumableOutcome(context, {
      childStatus: outcome.childStatus,
      responseAllowsResume: outcome.responseAllowsResume,
      resumeId: chatId,
      resumeSource: 'cursor_create_chat',
      homeDir: '',
      failReason: 'Cursor run did not complete successfully',
      missingIdReason: 'Cursor run did not complete successfully',
    })
    return
  }
  if (context.args.sessionMode === 'followup') {
    recordFollowupOutcome(context, {
      childStatus: outcome.childStatus,
      responseAllowsResume: outcome.responseAllowsResume,
      resumeId: chatId,
      resumeSource: 'cursor_create_chat',
      homeDir: '',
      failReason: 'Cursor follow-up did not complete successfully',
    })
  }
}

interface CursorRun {
  cursorModel: string
  cursorCliModel: string
  isolatedConfigDir: string
  chatId: string
  reportFile: string
}

const finalizeCursorRun = (
  context: WrapperContext,
  run: CursorRun,
  wait: WaitResult
): CliResult => {
  completeResponse(
    context,
    {
      responderSessionId: responderSessionIdOf(context, run.cursorModel),
      reportMode: reportModeForBackend('cursor'),
      reportFile: run.reportFile,
    },
    wait
  )
  const outcome = finalizeResponse(context, wait.childStatus)
  recordUsageAndEffort(context, {
    usageSource: 'cursor_json',
    measuredUsage: () =>
      usageFromCapture(context.stdoutCapture, {
        model: context.args.originalModel,
        backend: context.backend,
        source: 'cursor_json',
      }),
    effortRequested: context.effort,
    effortEffective: () =>
      effortFromCursorConfig(run.cursorModel, path.join(run.isolatedConfigDir, 'cli-config.json')),
  })
  recordCursorSessionOutcome(context, run.chatId, {
    childStatus: wait.childStatus,
    responseAllowsResume: outcome.responseAllowsResume,
  })
  return wrapperResult(context, outcome)
}

const runCursorChild = async (
  context: WrapperContext,
  run: CursorRun,
  mcp: CursorMcp
): Promise<CliResult> => {
  const requestStep = requestPromptStep(context.args.requestFile, {
    scriptsDir: context.scriptsDir,
    env: context.env,
  })
  const prompt = workerPrompt(context, requestStep.step, {
    constraints: promptConstraints(context.args.taskType, run.reportFile),
    tailLines: reportMdTailLines(run.reportFile),
  })
  const promptFile = writePromptFile(context, prompt)
  quietly(() => {
    updateMcpConfig(context.args.observeFile, context.workDir, {
      source: mcp.source,
      servers: mcp.servers,
    })
  })
  const worker = spawnWorker({
    command: 'agent',
    args: cursorCliArgs(run.cursorCliModel, { mcpSource: mcp.source, chatId: run.chatId }),
    cwd: context.repoRoot,
    env: {
      ...context.env,
      CURSOR_CONFIG_DIR: run.isolatedConfigDir,
      TMPDIR: path.join(context.workDir, 'tmp'),
    },
    stdinFile: promptFile,
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
  return finalizeCursorRun(context, run, wait)
}

interface CursorModels {
  cursorModel: string
  cursorCliModel: string
}

const cursorModelsOf = (context: WrapperContext): CursorModels | CliResult => {
  const cursorModel = stripCursorPrefix(context.baseModel)
  const cursorCliModel = cursorCliModelOf(context, cursorModel)
  if (typeof cursorCliModel !== 'string') {
    return cursorCliModel
  }
  return { cursorModel, cursorCliModel }
}

const cursorPreflight = (context: WrapperContext): CursorModels | CliResult => {
  const effortError = effortFailure(context)
  if (effortError !== null) {
    return effortError
  }
  const models = cursorModelsOf(context)
  if ('exitCode' in models) {
    return models
  }
  const modeFailure = cursorSessionModeFailure(context)
  if (modeFailure !== null) {
    return modeFailure
  }
  return models
}

const launchCursor = async (context: WrapperContext, models: CursorModels): Promise<CliResult> => {
  const isolatedConfigDir = isolateCursorConfig(context)
  const mcp = setupCursorMcp(context, isolatedConfigDir)
  const chatId = setupCursorChat(context, isolatedConfigDir)
  if (typeof chatId !== 'string') {
    return chatId
  }
  return runCursorChild(
    context,
    {
      ...models,
      isolatedConfigDir,
      chatId,
      reportFile: path.join(context.args.runDir, 'report.md'),
    },
    mcp
  )
}

const wrapperCursorWithContext = async (context: WrapperContext): Promise<CliResult> => {
  const models = cursorPreflight(context)
  if ('exitCode' in models) {
    return models
  }
  if (!commandAvailable('agent', context.env)) {
    return finishWithoutChild(context, 3, 'ERROR: agent CLI が見つかりません。')
  }
  return launchCursor(context, models)
}

export const runWrapperCursor = async (
  argv: readonly string[],
  env: Env,
  io: { scriptsDir: string }
): Promise<CliResult> => {
  const args = parseWrapperArgs(argv, 'delegate-cursor.sh')
  if ('exitCode' in args) {
    return args
  }
  const context = makeWrapperContext(args, { env, scriptsDir: io.scriptsDir })
  return wrapperCursorWithContext(context)
}
