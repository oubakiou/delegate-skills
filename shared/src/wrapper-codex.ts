import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Env } from './build-request.ts'
import type { CliResult } from './cli-result.ts'
import {
  mcpExtractCodexUser,
  mcpHasServers,
  mcpRenderCodexToml,
  mcpTomlServerNames,
} from './delegate-mcp.ts'
import { effortFromCodexSessions } from './observe-effort.ts'
import { hasFileContent, isDirectory, parseJsonObjects, readFileOrEmpty } from './jq-compat.ts'
import { updateMcpConfig } from './observe-store.ts'
import { usageFromCapture, usageFromCodexSessions } from './observe-usage.ts'
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
  responderSessionIdOf,
  workerPrompt,
  wrapperResult,
  writePromptFile,
  STRUCTURED_REPORT_HEAD_LINES,
  type WrapperContext,
} from './wrapper-common.ts'
import {
  codexHomePrune,
  reportModeForBackend,
  requestPromptStep,
  structuredFromLastMessage,
  REPORT_SCHEMA_JSON,
  REQUEST_ARGV_INLINE_MAX,
} from './wrapper-report.ts'
import {
  commandAvailable,
  spawnWorker,
  waitWithHeartbeat,
  type WaitResult,
} from './wrapper-wait.ts'

// bash 版 delegate-codex.sh と同一契約の gpt-* モデル向け Codex 子プロセス起動ラッパ。
// stdout: response_file のパスのみ（本文は親 context に入れない）

const lastMessageFileOf = (context: WrapperContext): string =>
  path.join(context.workDir, 'codex-last-message.txt')

const realCodexHomeOf = (env: Env): string => {
  const home = env.CODEX_HOME ?? ''
  if (home !== '') {
    return home
  }
  return path.join(env.HOME ?? '', '.codex')
}

const setupCodexHome = (context: WrapperContext): string | CliResult => {
  const { sessionMode, resumeArg, sessionHome } = context.args
  if (sessionMode === 'followup') {
    if (sessionHome === '' || resumeArg === '') {
      return finishWithoutChild(context, 5, 'ERROR: follow-up requires session_home and resume_id.')
    }
    if (!isDirectory(sessionHome)) {
      return finishWithoutChild(
        context,
        5,
        `ERROR: Codex session_home does not exist: ${sessionHome}`
      )
    }
    return sessionHome
  }
  if (sessionMode !== '' && sessionMode !== 'resumable') {
    return finishWithoutChild(
      context,
      2,
      `ERROR: session_mode must be empty, resumable, or followup: ${sessionMode}`
    )
  }
  return path.join(context.workDir, 'codex-home')
}

const copyCodexAuth = (context: WrapperContext, codexHome: string): void => {
  mkdirSync(codexHome, { recursive: true })
  const authFile = path.join(realCodexHomeOf(context.env), 'auth.json')
  quietly(() => {
    if (hasFileContent(authFile)) {
      copyFileSync(authFile, path.join(codexHome, 'auth.json'))
    }
  })
}

const recordFollowupMcp = (context: WrapperContext, codexHome: string): void => {
  const configToml = path.join(codexHome, 'config.toml')
  if (hasFileContent(configToml)) {
    quietly(() => {
      updateMcpConfig(context.args.observeFile, context.workDir, {
        source: 'injected',
        servers: mcpTomlServerNames(configToml),
      })
    })
    return
  }
  quietly(() => {
    updateMcpConfig(context.args.observeFile, context.workDir, { source: 'none', servers: [] })
  })
}

const injectCodexMcp = (context: WrapperContext, codexHome: string): void => {
  const canonical = mcpExtractCodexUser(realCodexHomeOf(context.env))
  if (mcpHasServers(canonical)) {
    writeFileSync(path.join(codexHome, 'config.toml'), mcpRenderCodexToml(canonical))
    quietly(() => {
      updateMcpConfig(context.args.observeFile, context.workDir, {
        source: 'injected',
        servers: Object.keys(canonical),
      })
    })
    return
  }
  quietly(() => {
    updateMcpConfig(context.args.observeFile, context.workDir, { source: 'none', servers: [] })
  })
}

const setupCodexMcp = (context: WrapperContext, codexHome: string): void => {
  if (context.args.sessionMode === 'followup') {
    recordFollowupMcp(context, codexHome)
    return
  }
  injectCodexMcp(context, codexHome)
}

const codexPromptTailLines = [
  ...STRUCTURED_REPORT_HEAD_LINES,
  '   report をファイルに書いたり md2idx / jq でレスポンスを生成したりしない（レスポンス生成は wrapper が行う）。リポジトリ root に report.md を作らない。',
] as const

const sandboxOf = (env: Env): string => env.CODEX_DELEGATE_SANDBOX ?? 'danger-full-access'

const effortConfigArgs = (context: WrapperContext): string[] => {
  if (context.effort === '') {
    return []
  }
  return ['-c', `model_reasoning_effort=${context.effort}`]
}

// `codex exec resume` での stdin prompt（positional `-`）は未実測のため、follow-up は
// argv 渡しを維持する（通常 run は stdin）
const followupCodexArgs = (
  context: WrapperContext,
  files: { lastMsg: string; schemaFile: string },
  prompt: string
): string[] => [
  'exec',
  'resume',
  context.args.resumeArg,
  '-m',
  context.baseModel,
  ...effortConfigArgs(context),
  '--skip-git-repo-check',
  '-c',
  `sandbox_mode=${sandboxOf(context.env)}`,
  '--json',
  '--output-last-message',
  files.lastMsg,
  '--output-schema',
  files.schemaFile,
  prompt,
]

const normalCodexArgs = (
  context: WrapperContext,
  files: { lastMsg: string; schemaFile: string }
): string[] => {
  const args = [
    'exec',
    '-m',
    context.baseModel,
    ...effortConfigArgs(context),
    '--skip-git-repo-check',
    '--sandbox',
    sandboxOf(context.env),
    '--json',
    '--output-last-message',
    files.lastMsg,
    '--output-schema',
    files.schemaFile,
    '-C',
    context.repoRoot,
  ]
  if (context.args.sessionMode === '') {
    args.push('--ephemeral')
  }
  // prompt は argv ではなく positional `-` + stdin で渡す（ARG_MAX 非依存。ps からも見えない）
  args.push('-')
  return args
}

const extractCodexThreadId = (stdoutCapture: string): string => {
  const threads = parseJsonObjects(readFileOrEmpty(stdoutCapture)).filter(
    (event) => event.type === 'thread.started' && typeof event.thread_id === 'string'
  )
  if (threads.length === 0) {
    return ''
  }
  return String(threads[threads.length - 1].thread_id)
}

const recordCodexSessionOutcome = (
  context: WrapperContext,
  codexHome: string,
  outcome: { childStatus: number; responseAllowsResume: boolean }
): void => {
  if (context.args.sessionMode === 'resumable') {
    recordResumableOutcome(context, {
      childStatus: outcome.childStatus,
      responseAllowsResume: outcome.responseAllowsResume,
      resumeId: extractCodexThreadId(context.stdoutCapture),
      resumeSource: 'codex_json',
      homeDir: codexHome,
      failReason: 'Codex run did not complete successfully',
      missingIdReason: 'Codex thread.started event was not found',
    })
    return
  }
  if (context.args.sessionMode === 'followup') {
    recordFollowupOutcome(context, {
      childStatus: outcome.childStatus,
      responseAllowsResume: outcome.responseAllowsResume,
      resumeId: context.args.resumeArg,
      resumeSource: 'codex_json',
      homeDir: codexHome,
      failReason: 'Codex follow-up did not complete successfully',
    })
  }
}

const finalizeCodexRun = (
  context: WrapperContext,
  codexHome: string,
  wait: WaitResult
): CliResult => {
  completeResponse(
    context,
    {
      responderSessionId: responderSessionIdOf(context, context.baseModel),
      reportMode: reportModeForBackend(context.backend),
      collectStructured: () => structuredFromLastMessage(lastMessageFileOf(context)),
    },
    wait
  )
  const outcome = finalizeResponse(context, wait.childStatus)
  recordUsageAndEffort(context, {
    usageSource: 'codex_json',
    measuredUsage: () =>
      usageFromCapture(context.stdoutCapture, {
        model: context.args.originalModel,
        backend: context.backend,
        source: 'codex_json',
      }) ??
      usageFromCodexSessions(codexHome, {
        model: context.args.originalModel,
        backend: context.backend,
      }),
    effortRequested: context.effort,
    effortEffective: () => effortFromCodexSessions(codexHome),
  })
  recordCodexSessionOutcome(context, codexHome, {
    childStatus: wait.childStatus,
    responseAllowsResume: outcome.responseAllowsResume,
  })
  if (outcome.responseStatus === 0 && outcome.responseAllowsResume) {
    codexHomePrune(codexHome, context.env)
  }
  return wrapperResult(context, outcome)
}

const maxOverrideOf = (followup: boolean): string => {
  if (followup) {
    return String(REQUEST_ARGV_INLINE_MAX)
  }
  return ''
}

interface CodexLaunch {
  cliArgs: string[]
  stdinFile: string | null
}

const codexLaunchOf = (context: WrapperContext): CodexLaunch => {
  const files = {
    lastMsg: lastMessageFileOf(context),
    schemaFile: path.join(context.workDir, 'report-schema.json'),
  }
  writeFileSync(files.schemaFile, REPORT_SCHEMA_JSON)
  const followup = context.args.sessionMode === 'followup'
  const requestStep = requestPromptStep(context.args.requestFile, {
    scriptsDir: context.scriptsDir,
    env: context.env,
    maxOverride: maxOverrideOf(followup),
  })
  const prompt = workerPrompt(context, requestStep.step, {
    constraints: promptConstraints(context.args.taskType, context.args.responseFile),
    tailLines: codexPromptTailLines,
  })
  const promptFile = writePromptFile(context, prompt)
  if (followup) {
    return { cliArgs: followupCodexArgs(context, files, prompt), stdinFile: null }
  }
  return { cliArgs: normalCodexArgs(context, files), stdinFile: promptFile }
}

const runCodexChild = async (context: WrapperContext, codexHome: string): Promise<CliResult> => {
  copyCodexAuth(context, codexHome)
  setupCodexMcp(context, codexHome)
  const launch = codexLaunchOf(context)
  const worker = spawnWorker({
    command: 'codex',
    args: launch.cliArgs,
    cwd: context.repoRoot,
    env: {
      ...context.env,
      CODEX_HOME: codexHome,
      TMPDIR: path.join(context.workDir, 'tmp'),
    },
    stdinFile: launch.stdinFile,
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
  return finalizeCodexRun(context, codexHome, wait)
}

const wrapperCodexWithContext = async (context: WrapperContext): Promise<CliResult> => {
  const effortError = effortFailure(context)
  if (effortError !== null) {
    return effortError
  }
  const codexHome = setupCodexHome(context)
  if (typeof codexHome !== 'string') {
    return codexHome
  }
  if (!commandAvailable('codex', context.env)) {
    return finishWithoutChild(context, 3, 'ERROR: codex CLI が見つかりません。')
  }
  return runCodexChild(context, codexHome)
}

export const runWrapperCodex = async (
  argv: readonly string[],
  env: Env,
  io: { scriptsDir: string }
): Promise<CliResult> => {
  const args = parseWrapperArgs(argv, 'delegate-codex.sh')
  if ('exitCode' in args) {
    return args
  }
  const context = makeWrapperContext(args, { env, scriptsDir: io.scriptsDir })
  return wrapperCodexWithContext(context)
}
