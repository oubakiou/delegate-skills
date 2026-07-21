import {
  constants,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
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
import {
  getPath,
  hasFileContent,
  isDirectory,
  isRecord,
  parseJsonObjects,
  readFileOrEmpty,
  stringOf,
} from './jq-compat.ts'
import { updateMcpConfig } from './observe-store.ts'
import { usageFromCapture, usageFromCodexSessions } from './observe-usage.ts'
import { promptConstraints } from './prompt-constraints.ts'
import { randomToken } from './protocol.ts'
import {
  completeResponse,
  effortFailure,
  envOrDefault,
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

class CodexAuthLifecycleError extends Error {
  public override name = 'CodexAuthLifecycleError'
}

const followupObserveFileOf = (sessionHome: string): string =>
  `${path.dirname(sessionHome)}_observe.json`

const DELEGATE_SESSION_RUN = /^delegate_(?:implement|chore)_\d{8}_\d{6}_[A-Za-z0-9]{5}$/

const followupSessionRecordMatches = (context: WrapperContext, sessionHome: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(readFileOrEmpty(followupObserveFileOf(sessionHome)))
    if (!isRecord(parsed)) {
      return false
    }
    const field = (keys: string[]): string => stringOf(getPath(parsed, keys))
    return (
      field(['backend_session', 'backend']) === 'codex' &&
      field(['backend_session', 'model']) === context.args.originalModel &&
      field(['backend_session', 'resume_id']) === context.args.resumeArg &&
      field(['backend_session', 'persistence']) === 'resumable' &&
      path.resolve(field(['backend_session', 'home_dir'])) === path.resolve(sessionHome)
    )
  } catch {
    return false
  }
}

const ownedRealDirectory = (directory: string): boolean => {
  if (typeof process.getuid !== 'function') {
    return false
  }
  const stat = lstatSync(directory)
  return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid()
}

const safeFollowupSessionHome = (context: WrapperContext, sessionHome: string): boolean => {
  const resolvedHome = path.resolve(sessionHome)
  const realRoot = path.resolve(realCodexHomeOf(context.env))
  try {
    return (
      path.basename(resolvedHome) === 'codex-home' &&
      DELEGATE_SESSION_RUN.test(path.basename(path.dirname(resolvedHome))) &&
      ownedRealDirectory(path.dirname(resolvedHome)) &&
      ownedRealDirectory(resolvedHome) &&
      realpathSync(resolvedHome) !== realpathSync(realRoot) &&
      followupSessionRecordMatches(context, resolvedHome)
    )
  } catch {
    return false
  }
}

const setupFollowupCodexHome = (context: WrapperContext): string | CliResult => {
  const { resumeArg, sessionHome } = context.args
  if (sessionHome === '' || resumeArg === '') {
    return finishWithoutChild(context, 5, 'ERROR: follow-up requires session_home and resume_id.')
  }
  if (!isDirectory(sessionHome) || !safeFollowupSessionHome(context, sessionHome)) {
    return finishWithoutChild(context, 5, 'ERROR: Codex session_home ownership is invalid.')
  }
  return sessionHome
}

const setupCodexHome = (context: WrapperContext): string | CliResult => {
  const { sessionMode } = context.args
  if (sessionMode === 'followup') {
    return setupFollowupCodexHome(context)
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

const matchesRealCodexHome = (resolvedHome: string, rootAuth: string): boolean => {
  try {
    return realpathSync(resolvedHome) === realpathSync(path.dirname(rootAuth))
  } catch {
    return true
  }
}

const authCopyIsSymlink = (authCopy: string): boolean => {
  try {
    return lstatSync(authCopy).isSymbolicLink()
  } catch {
    return false
  }
}

const authCopyExists = (authCopy: string): boolean => {
  try {
    lstatSync(authCopy)
    return true
  } catch {
    return false
  }
}

const safeCodexAuthCopyPath = (context: WrapperContext, codexHome: string): string | null => {
  const resolvedHome = path.resolve(codexHome)
  const authCopy = path.join(resolvedHome, 'auth.json')
  const rootAuth = path.resolve(realCodexHomeOf(context.env), 'auth.json')
  if (resolvedHome === path.parse(resolvedHome).root || authCopy === rootAuth) {
    return null
  }
  if (matchesRealCodexHome(resolvedHome, rootAuth) || authCopyIsSymlink(authCopy)) {
    return null
  }
  return authCopy
}

type CodexAuthArtifactKind = 'published' | 'staging'
type CodexAuthSignal = 'SIGINT' | 'SIGTERM'

interface CodexAuthLease {
  cleanup: () => boolean
  own: (artifact: string, kind: CodexAuthArtifactKind) => void
  release: (artifact: string) => void
}

const publishStagedAuth = (staged: string, destination: string, lease: CodexAuthLease): void => {
  try {
    linkSync(staged, destination)
    lease.own(destination, 'published')
    unlinkSync(staged)
    lease.release(staged)
  } catch {
    throw new CodexAuthLifecycleError('stage')
  }
}

const copyAuthAtomic = (source: string, destination: string, lease: CodexAuthLease): void => {
  const staged = path.join(
    path.dirname(destination),
    `.auth.json.stage-${process.pid}-${randomToken(8)}`
  )
  lease.own(staged, 'staging')
  try {
    copyFileSync(source, staged, constants.COPYFILE_EXCL)
  } catch {
    throw new CodexAuthLifecycleError('stage')
  }
  publishStagedAuth(staged, destination, lease)
}

const copyCodexAuth = (context: WrapperContext, codexHome: string, lease: CodexAuthLease): void => {
  mkdirSync(codexHome, { recursive: true })
  const authFile = path.join(realCodexHomeOf(context.env), 'auth.json')
  const authCopy = safeCodexAuthCopyPath(context, codexHome)
  if (authCopy === null || authCopyExists(authCopy)) {
    throw new CodexAuthLifecycleError('stage')
  }
  if (!hasFileContent(authFile)) {
    return
  }
  copyAuthAtomic(authFile, authCopy, lease)
}

type CodexAuthFailurePhase = 'stage' | 'operation' | 'cleanup'

interface CodexAuthRun<OperationResult> {
  context: WrapperContext
  codexHome: string
  operation: () => Promise<OperationResult>
  finalize: (result: OperationResult) => CliResult
  onFailure: (phase: CodexAuthFailurePhase) => CliResult
}

class CodexAuthLeaseController implements CodexAuthLease {
  readonly #ownedArtifacts = new Map<string, CodexAuthArtifactKind>()
  #cleaned = false
  #cleaning = false
  #cleanupSucceeded = true
  #pendingSignal: CodexAuthSignal | null = null

  public constructor() {
    process.once('SIGINT', this.#onSigint)
    process.once('SIGTERM', this.#onSigterm)
    process.once('exit', this.#onExit)
  }

  public cleanup = (): boolean => {
    if (this.#cleaned) {
      return this.#cleanupSucceeded
    }
    if (this.#cleaning) {
      return false
    }
    this.#cleaning = true
    this.#cleanupSucceeded = this.#cleanupOwnedArtifacts()
    this.#cleaned = true
    this.#cleaning = false
    this.#sendPendingSignal()
    return this.#cleanupSucceeded
  }

  public own = (artifact: string, kind: CodexAuthArtifactKind): void => {
    this.#ownedArtifacts.set(artifact, kind)
  }

  public release = (artifact: string): void => {
    this.#ownedArtifacts.delete(artifact)
  }

  readonly #cleanupOwnedArtifacts = (): boolean =>
    [...this.#ownedArtifacts].map(([artifact, kind]) => this.#remove(artifact, kind)).every(Boolean)

  readonly #remove = (artifact: string, kind: CodexAuthArtifactKind): boolean => {
    try {
      if (kind === 'published') {
        unlinkSync(artifact)
      } else {
        rmSync(artifact, { force: true })
      }
      this.#ownedArtifacts.delete(artifact)
      return true
    } catch {
      return false
    }
  }

  readonly #removeHandlers = (): void => {
    process.removeListener('SIGINT', this.#onSigint)
    process.removeListener('SIGTERM', this.#onSigterm)
    process.removeListener('exit', this.#onExit)
  }

  readonly #sendPendingSignal = (): void => {
    if (this.#pendingSignal === null) {
      return
    }
    const signal = this.#pendingSignal
    this.#pendingSignal = null
    process.kill(process.pid, signal)
  }

  readonly #terminate = (signal: CodexAuthSignal): void => {
    if (this.#cleaning) {
      this.#pendingSignal = signal
      return
    }
    this.cleanup()
    process.kill(process.pid, signal)
  }

  readonly #onSigint = (): void => {
    this.#terminate('SIGINT')
  }

  readonly #onSigterm = (): void => {
    this.#terminate('SIGTERM')
  }

  readonly #onExit = (): void => {
    this.cleanup()
    this.#removeHandlers()
  }
}

const registerCodexAuthLease = (): CodexAuthLease => new CodexAuthLeaseController()

const waitForPendingAuthSignal = async (): Promise<void> =>
  await new Promise((resolve) => {
    setImmediate(resolve)
  })

const cleanupCodexAuthLease = async (lease: CodexAuthLease): Promise<boolean> => {
  const cleaned = lease.cleanup()
  await waitForPendingAuthSignal()
  return cleaned
}

const runStagedCodexAuth = async <OperationResult>(
  run: CodexAuthRun<OperationResult>,
  lease: CodexAuthLease
): Promise<CliResult> => {
  const operation = await (async (): Promise<
    { result: OperationResult; succeeded: true } | { succeeded: false }
  > => {
    try {
      return { result: await run.operation(), succeeded: true as const }
    } catch {
      return { succeeded: false as const }
    }
  })()
  if (!operation.succeeded) {
    if (!(await cleanupCodexAuthLease(lease))) {
      return run.onFailure('cleanup')
    }
    return run.onFailure('operation')
  }
  if (!(await cleanupCodexAuthLease(lease))) {
    return run.onFailure('cleanup')
  }
  return run.finalize(operation.result)
}

export const runWithCodexAuth = async <OperationResult>(
  run: CodexAuthRun<OperationResult>
): Promise<CliResult> => {
  const lease = registerCodexAuthLease()
  try {
    copyCodexAuth(run.context, run.codexHome, lease)
  } catch {
    if (!(await cleanupCodexAuthLease(lease))) {
      return run.onFailure('cleanup')
    }
    return run.onFailure('stage')
  }
  await waitForPendingAuthSignal()
  return runStagedCodexAuth(run, lease)
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

const sandboxOf = (env: Env): string =>
  envOrDefault(env, 'CODEX_DELEGATE_SANDBOX', 'danger-full-access')

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

const finishCodexAuthFailure = (
  context: WrapperContext,
  codexHome: string,
  phase: CodexAuthFailurePhase
): CliResult => {
  const result = finishWithoutChild(context, 1, `ERROR: Codex credential ${phase} failed safely.`)
  recordCodexSessionOutcome(context, codexHome, {
    childStatus: 1,
    responseAllowsResume: false,
  })
  return result
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

const runCodexChild = async (context: WrapperContext, codexHome: string): Promise<CliResult> =>
  runWithCodexAuth({
    context,
    codexHome,
    operation: async () => {
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
      return wait
    },
    finalize: (wait) => finalizeCodexRun(context, codexHome, wait),
    onFailure: (phase) => finishCodexAuthFailure(context, codexHome, phase),
  })

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
