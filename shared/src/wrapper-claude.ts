import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Env } from './build-request.ts'
import type { CliResult } from './cli-result.ts'
import { mcpExtractClaudeUser, mcpHasServers, mcpRenderClaudeMcpConfig } from './delegate-mcp.ts'
import { hasFileContent, isRecord, readFileOrEmpty } from './jq-compat.ts'
import { updateMcpConfig } from './observe-store.ts'
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
  responderSessionIdOf,
  workerPrompt,
  wrapperResult,
  writePromptFile,
  STRUCTURED_REPORT_HEAD_LINES,
  type WrapperContext,
} from './wrapper-common.ts'
import {
  positiveIntOrZero,
  reportModeForBackend,
  requestPromptStep,
  structuredFromClaudeCapture,
  REPORT_SCHEMA_JSON,
} from './wrapper-report.ts'
import {
  commandAvailable,
  spawnWorker,
  waitWithHeartbeat,
  type WaitResult,
} from './wrapper-wait.ts'

// bash 版 delegate-claude.sh と同一契約の Claude 系モデル向け claude -p 起動ラッパ。
// stdout: response_file のパスのみ（本文は親 context に入れない）

const writeFileQuietly = (operation: () => void): void => {
  quietly(operation)
}

const readdirQuietly = (dir: string): string[] => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

const isDirectoryQuietly = (target: string): boolean => {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

// find <home>/projects -name "<session>.jsonl" 相当の再帰探索
const claudeSessionFileExists = (claudeHome: string, sessionId: string): boolean => {
  const target = `${sessionId}.jsonl`
  const stack = [path.join(claudeHome, 'projects')]
  while (stack.length > 0) {
    const dir = stack.pop() ?? ''
    for (const entry of readdirQuietly(dir)) {
      const full = path.join(dir, entry)
      if (isDirectoryQuietly(full)) {
        stack.push(full)
      } else if (entry === target) {
        return true
      }
    }
  }
  return false
}

interface ClaudeSession {
  sessionHome: string
  sessionId: string
}

const setupResumableSession = (context: WrapperContext): ClaudeSession => {
  const sessionHome = path.join(context.workDir, 'claude-config')
  mkdirSync(sessionHome, { recursive: true })
  const realConfig = context.env.CLAUDE_CONFIG_DIR ?? path.join(context.env.HOME ?? '', '.claude')
  writeFileQuietly(() => {
    if (hasFileContent(path.join(realConfig, '.credentials.json'))) {
      copyFileSync(
        path.join(realConfig, '.credentials.json'),
        path.join(sessionHome, '.credentials.json')
      )
    }
  })
  return { sessionHome, sessionId: randomUUID() }
}

const setupFollowupSession = (context: WrapperContext): ClaudeSession | CliResult => {
  const { resumeArg, sessionHome } = context.args
  if (sessionHome === '' || resumeArg === '') {
    return finishWithoutChild(context, 5, 'ERROR: follow-up requires session_home and resume_id.')
  }
  if (!claudeSessionFileExists(sessionHome, resumeArg)) {
    return finishWithoutChild(
      context,
      5,
      `ERROR: Claude resume session file is missing for resume_id: ${resumeArg}`
    )
  }
  return { sessionHome, sessionId: resumeArg }
}

const setupClaudeSession = (context: WrapperContext): ClaudeSession | CliResult => {
  const { sessionMode } = context.args
  if (sessionMode === '') {
    return { sessionHome: '', sessionId: '' }
  }
  if (sessionMode === 'resumable') {
    return setupResumableSession(context)
  }
  if (sessionMode === 'followup') {
    return setupFollowupSession(context)
  }
  return finishWithoutChild(
    context,
    2,
    `ERROR: session_mode must be empty, resumable, or followup: ${sessionMode}`
  )
}

const minimalAllowedTools = (context: WrapperContext, requestInline: boolean): string => {
  if (requestInline) {
    return 'Read'
  }
  return `Bash(bash ${context.scriptsDir}/read-request.sh:*),Read`
}

const parentClaudeConfigFile = (env: Env): string => {
  const configDir = env.CLAUDE_CONFIG_DIR ?? ''
  if (configDir !== '') {
    return path.join(configDir, '.claude.json')
  }
  return path.join(env.HOME ?? '', '.claude.json')
}

const mcpServersFromConfigFile = (mcpConfigFile: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(readFileOrEmpty(mcpConfigFile))
    if (isRecord(parsed) && isRecord(parsed.mcpServers)) {
      return Object.keys(parsed.mcpServers)
    }
    return []
  } catch {
    return []
  }
}

const sessionArgsForResumable = (context: WrapperContext, session: ClaudeSession): string[] => {
  const args: string[] = []
  const canonical = mcpExtractClaudeUser(parentClaudeConfigFile(context.env))
  if (mcpHasServers(canonical)) {
    const mcpConfigFile = path.join(session.sessionHome, 'mcp-config.json')
    writeFileSync(mcpConfigFile, mcpRenderClaudeMcpConfig(canonical))
    args.push('--mcp-config', mcpConfigFile)
    quietly(() => {
      updateMcpConfig(context.args.observeFile, context.workDir, {
        source: 'injected',
        servers: Object.keys(canonical),
      })
    })
  } else {
    quietly(() => {
      updateMcpConfig(context.args.observeFile, context.workDir, { source: 'none', servers: [] })
    })
  }
  args.push('--session-id', session.sessionId)
  return args
}

const sessionArgsForFollowup = (context: WrapperContext, session: ClaudeSession): string[] => {
  const args: string[] = []
  const mcpConfigFile = path.join(session.sessionHome, 'mcp-config.json')
  if (hasFileContent(mcpConfigFile)) {
    args.push('--mcp-config', mcpConfigFile)
    quietly(() => {
      updateMcpConfig(context.args.observeFile, context.workDir, {
        source: 'injected',
        servers: mcpServersFromConfigFile(mcpConfigFile),
      })
    })
  } else {
    quietly(() => {
      updateMcpConfig(context.args.observeFile, context.workDir, { source: 'none', servers: [] })
    })
  }
  args.push('--resume', session.sessionId)
  return args
}

const sessionModeArgs = (context: WrapperContext, session: ClaudeSession): string[] => {
  const { sessionMode } = context.args
  if (sessionMode === 'resumable') {
    return sessionArgsForResumable(context, session)
  }
  if (sessionMode === 'followup') {
    return sessionArgsForFollowup(context, session)
  }
  quietly(() => {
    updateMcpConfig(context.args.observeFile, context.workDir, { source: 'shared', servers: [] })
  })
  return ['--no-session-persistence']
}

// read-only 種別はリポジトリ書き込みツールを技術的に除外する（Codex パスでは不可能な防御層）。
// explore は WebSearch / WebFetch / MCP 探索を開放するため allowlist ではなく denylist を使う
// （MCP ツール名は実行環境の MCP 設定次第で、allowlist では事前に列挙できないため）
const toolConfigArgs = (context: WrapperContext, minimalTools: string): string[] => {
  if (context.args.taskType === 'explore') {
    return [
      '--allowedTools',
      minimalTools,
      '--disallowedTools',
      'Edit,MultiEdit,Write,NotebookEdit',
    ]
  }
  if (context.args.taskType === 'review') {
    return ['--allowedTools', 'Read,Bash']
  }
  return ['--allowedTools', `${minimalTools},Edit,Write`]
}

// 子が自作のハングするサブプロセスを待ち続けると外側 watchdog の kill まで復帰機会が無い。
// Bash tool の timeout 上限を注入しておくと、ハングしたコマンドが harness からツールエラーで
// 返り、子が自力で是正（timeout 付き再実行等）できる。0 指定で注入を無効化する
const childEnvOf = (
  context: WrapperContext,
  session: ClaudeSession
): Record<string, string | undefined> => {
  const childEnv: Record<string, string | undefined> = {
    ...context.env,
    TMPDIR: path.join(context.workDir, 'tmp'),
  }
  const timeoutMs = positiveIntOrZero(context.env.DELEGATE_CHILD_BASH_TIMEOUT_MS ?? '300000')
  if (timeoutMs > 0) {
    childEnv.BASH_DEFAULT_TIMEOUT_MS = String(timeoutMs)
    childEnv.BASH_MAX_TIMEOUT_MS = String(timeoutMs)
  }
  if (session.sessionHome !== '') {
    childEnv.CLAUDE_CONFIG_DIR = session.sessionHome
  }
  return childEnv
}

const claudeCliArgs = (
  context: WrapperContext,
  parts: { sessionArgs: string[]; toolArgs: string[] }
): string[] => {
  const args = ['-p', '--model', context.baseModel, '--json-schema', REPORT_SCHEMA_JSON]
  if (context.effort !== '') {
    args.push('--effort', context.effort)
  }
  args.push('--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions')
  args.push(...parts.sessionArgs)
  args.push(...parts.toolArgs)
  return args
}

const sessionIdIfPresent = (session: ClaudeSession, idPresent: boolean): string => {
  if (idPresent) {
    return session.sessionId
  }
  return ''
}

const recordClaudeSessionOutcome = (
  context: WrapperContext,
  session: ClaudeSession,
  outcome: { childStatus: number; responseAllowsResume: boolean }
): void => {
  if (context.args.sessionMode === 'resumable') {
    const idPresent = claudeSessionFileExists(session.sessionHome, session.sessionId)
    recordResumableOutcome(context, {
      childStatus: outcome.childStatus,
      responseAllowsResume: outcome.responseAllowsResume,
      resumeId: sessionIdIfPresent(session, idPresent),
      resumeSource: 'session_id_arg',
      homeDir: session.sessionHome,
      failReason: 'Claude run did not complete successfully',
      missingIdReason: 'Claude session file was not created',
    })
    return
  }
  if (context.args.sessionMode === 'followup') {
    recordFollowupOutcome(context, {
      childStatus: outcome.childStatus,
      responseAllowsResume: outcome.responseAllowsResume,
      resumeId: session.sessionId,
      resumeSource: 'session_id_arg',
      homeDir: session.sessionHome,
      failReason: 'Claude follow-up did not complete successfully',
    })
  }
}

const finalizeClaudeRun = (
  context: WrapperContext,
  session: ClaudeSession,
  wait: WaitResult
): CliResult => {
  completeResponse(
    context,
    {
      responderSessionId: responderSessionIdOf(context, context.baseModel),
      reportMode: reportModeForBackend(context.backend),
      collectStructured: () => structuredFromClaudeCapture(context.stdoutCapture),
    },
    wait
  )
  const outcome = finalizeResponse(context, wait.childStatus)
  recordUsageAndEffort(context, {
    usageSource: 'claude_stream_json',
    measuredUsage: () =>
      usageFromCapture(context.stdoutCapture, {
        model: context.args.originalModel,
        backend: context.backend,
        source: 'claude_stream_json',
      }),
    effortRequested: context.effort,
  })
  recordClaudeSessionOutcome(context, session, {
    childStatus: wait.childStatus,
    responseAllowsResume: outcome.responseAllowsResume,
  })
  return wrapperResult(context, outcome)
}

const runClaudeChild = async (
  context: WrapperContext,
  session: ClaudeSession
): Promise<CliResult> => {
  const requestStep = requestPromptStep(context.args.requestFile, {
    scriptsDir: context.scriptsDir,
    env: context.env,
  })
  const prompt = workerPrompt(context, requestStep.step, {
    constraints: promptConstraints(context.args.taskType, context.args.responseFile),
    tailLines: [
      ...STRUCTURED_REPORT_HEAD_LINES,
      '   report をファイルに書いたり build-response.sh を実行したりしない（レスポンス生成は wrapper が行う）。',
    ],
  })
  const promptFile = writePromptFile(context, prompt)
  const cliArgs = claudeCliArgs(context, {
    sessionArgs: sessionModeArgs(context, session),
    toolArgs: toolConfigArgs(context, minimalAllowedTools(context, requestStep.inline)),
  })
  const worker = spawnWorker({
    command: 'claude',
    args: cliArgs,
    cwd: context.repoRoot,
    env: childEnvOf(context, session),
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
  return finalizeClaudeRun(context, session, wait)
}

const wrapperClaudeWithContext = async (context: WrapperContext): Promise<CliResult> => {
  const effortError = effortFailure(context)
  if (effortError !== null) {
    return effortError
  }
  const session = setupClaudeSession(context)
  if ('exitCode' in session) {
    return session
  }
  if (!commandAvailable('claude', context.env)) {
    return finishWithoutChild(context, 3, 'ERROR: claude CLI が見つかりません。')
  }
  return runClaudeChild(context, session)
}

export const runWrapperClaude = async (
  argv: readonly string[],
  env: Env,
  io: { scriptsDir: string }
): Promise<CliResult> => {
  const args = parseWrapperArgs(argv, 'delegate-claude.sh')
  if ('exitCode' in args) {
    return args
  }
  const context = makeWrapperContext(args, { env, scriptsDir: io.scriptsDir })
  return wrapperClaudeWithContext(context)
}
