import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { backendFor } from './backend.ts'
import { runBuildRequest, type Env } from './build-request.ts'
import { runCheckDelegateChain } from './check-delegate-chain.ts'
import type { CliResult } from './cli-result.ts'
import { getPath, hasFileContent, isRecord, readFileOrEmpty, stringOf } from './jq-compat.ts'
import { validateModelEffort } from './observe-effort.ts'
import { validateFollowup } from './observe-followup.ts'
import { initObserve, updateLineage, updateRunContext } from './observe-store.ts'
import { elapsedMs, monotonicMs } from './observe-timing.ts'
import {
  appendMetrics,
  bodyStats,
  estimatedTokens,
  metricsTimestamp,
  prettyJson,
  stripTrailingNewlineBytes,
  type BodyStats,
} from './protocol.ts'
import { runResolveModel } from './resolve-model.ts'

// bash 版 prepare.sh と同一契約:
// Usage: prepare <task_type> <type_env_name> <default_model> <parent_task_type_chain_json> <requester_session_id> [session_mode]
//   リクエスト本文 Markdown は stdin から渡す。
// exit: 2=引数エラー / 4=委譲サイクル / 5=follow-up 検証失敗 / 6=effort 指定不正 / 1=md2idx 失敗・空 index/sections
// bash 版が呼んでいた check-md2idx.sh (exit 3) は md2idx のバンドル内包で前提条件ごと消滅した。

const USAGE =
  'Usage: prepare <task_type> <type_env_name> <default_model> <parent_task_type_chain_json> <requester_session_id> [session_mode]  (request body markdown on stdin)\n'

const failure = (exitCode: number, stderr: string): CliResult => ({ exitCode, stderr, stdout: '' })

type SessionMode = '' | 'resumable' | 'followup'

interface PrepareArgs {
  taskType: string
  typeEnv: string
  defaultModel: string
  parentChain: string
  requesterSessionId: string
  sessionMode: SessionMode
  previousObserveFile: string
}

interface ParsedSessionMode {
  sessionMode: SessionMode
  previousObserveFile: string
}

const parseSessionMode = (raw: string): ParsedSessionMode | CliResult => {
  if (raw === '') {
    return { sessionMode: '', previousObserveFile: '' }
  }
  if (raw === 'resumable') {
    return { sessionMode: 'resumable', previousObserveFile: '' }
  }
  if (raw.startsWith('followup=')) {
    const previousObserveFile = raw.slice('followup='.length)
    if (previousObserveFile === '') {
      return failure(2, 'ERROR: followup session_mode requires a previous observe_file path.\n')
    }
    return { sessionMode: 'followup', previousObserveFile }
  }
  return failure(
    2,
    `ERROR: session_mode must be empty, resumable, or followup=<previous_observe_file>: ${raw}\n`
  )
}

const chainOrTopLevel = (raw: string): string => {
  if (raw === '') {
    return '[]'
  }
  return raw
}

const parsePrepareArgs = (argv: readonly string[]): PrepareArgs | CliResult => {
  if (argv.length < 5) {
    return failure(2, USAGE)
  }
  const [taskType, typeEnv, defaultModel, parentChainArg, requesterSessionId] = argv
  const mode = parseSessionMode(argv[5] ?? '')
  if ('exitCode' in mode) {
    return mode
  }
  if (mode.sessionMode !== '' && taskType !== 'implement' && taskType !== 'chore') {
    return failure(
      2,
      `ERROR: session_mode is only supported for implement/chore tasks: ${taskType}\n`
    )
  }
  return {
    taskType,
    typeEnv,
    defaultModel,
    parentChain: chainOrTopLevel(parentChainArg),
    requesterSessionId,
    sessionMode: mode.sessionMode,
    previousObserveFile: mode.previousObserveFile,
  }
}

interface PreviousResumeMetadata {
  backend: string
  model: string
  resumeId: string
  resumeSource: string
  backendSessionHome: string
  lineageId: string
}

// bash 版の jq -e -c 抽出と同じ受理範囲: null は全フィールド欠落として通し、
// scalar / array は index 不能で失敗する
const previousResumeMetadataOf = (observeFile: string): PreviousResumeMetadata | null => {
  let parsed: unknown = null
  try {
    parsed = JSON.parse(readFileOrEmpty(observeFile))
  } catch {
    return null
  }
  if (parsed !== null && !isRecord(parsed)) {
    return null
  }
  return {
    backend: stringOf(getPath(parsed, ['backend_session', 'backend'])),
    model: stringOf(getPath(parsed, ['backend_session', 'model'])),
    resumeId: stringOf(getPath(parsed, ['backend_session', 'resume_id'])),
    resumeSource: stringOf(getPath(parsed, ['backend_session', 'resume_source'])),
    backendSessionHome: stringOf(getPath(parsed, ['backend_session', 'home_dir'])),
    lineageId: stringOf(getPath(parsed, ['lineage', 'lineage_id'])),
  }
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

export interface PrepareMetricsInput {
  kind: 'prepare' | 'prepare_imagegen'
  durationMs?: number | null
  taskType: string
  typeEnv: string
  defaultModel: string
  model: string
  modelSource: string
  requesterSessionId: string
  taskTypeChain: unknown
  requestFile: string
  responseFile: string
  runDir: string
  observeFile: string
  body: BodyStats
}

// bash 版 append_metrics と同一のレコード形状。prepare_imagegen は duration_ms を持たない
export const appendPrepareMetrics = (env: Env, input: PrepareMetricsInput): void => {
  const record: Record<string, unknown> = {
    kind: input.kind,
    ts: metricsTimestamp(),
  }
  if (input.kind === 'prepare') {
    record.duration_ms = input.durationMs ?? null
  }
  Object.assign(record, {
    task_type: input.taskType,
    type_env: input.typeEnv,
    default_model: input.defaultModel,
    model: input.model,
    model_source: input.modelSource,
    requester_session_id: input.requesterSessionId,
    task_type_chain: input.taskTypeChain,
    request_file: input.requestFile,
    response_file: input.responseFile,
    run_dir: input.runDir,
    observe_file: input.observeFile,
    body: {
      bytes: input.body.bytes,
      chars: input.body.chars,
      lines: input.body.lines,
      estimated_tokens: estimatedTokens(input.body.chars),
    },
  })
  appendMetrics(env.DELEGATE_METRICS_FILE, record)
}

export interface RunPathsJson {
  request_file: string
  response_file: string
  run_dir: string
  observe_file: string
}

export const parseRunPaths = (stdout: string): RunPathsJson => {
  const parsed: unknown = JSON.parse(stdout)
  if (!isRecord(parsed)) {
    throw new Error('build-request stdout is not a JSON object')
  }
  return {
    request_file: stringOf(parsed.request_file),
    response_file: stringOf(parsed.response_file),
    run_dir: stringOf(parsed.run_dir),
    observe_file: stringOf(parsed.observe_file),
  }
}

interface FollowupContext {
  previousObserveFile: string
  previous: PreviousResumeMetadata
}

interface ModelPhase {
  model: string
  modelSource: string
  followup: FollowupContext | null
}

const modelSourceOf = (env: Env, typeEnv: string): string => {
  if ((env[typeEnv] ?? '') !== '') {
    return 'env'
  }
  return 'default'
}

const resolveRequestedModel = (args: PrepareArgs, env: Env): ModelPhase | CliResult => {
  const modelSource = modelSourceOf(env, args.typeEnv)
  const resolved = runResolveModel([args.typeEnv, args.defaultModel], env)
  if (resolved.exitCode !== 0) {
    return resolved
  }
  return { model: resolved.stdout.trimEnd(), modelSource, followup: null }
}

const missingFollowupFailure = (previousObserveFile: string): CliResult => {
  const cwd = process.cwd()
  const validation = validateFollowup({
    previousObserveFile,
    expectedBackend: '',
    expectedModel: '',
    expectedRepoRoot: cwd,
    expectedWorktreeRoot: cwd,
  })
  if (!validation.ok) {
    return failure(5, `${validation.message}\n`)
  }
  return failure(5, 'follow-up unavailable: previous observe JSON is missing\n')
}

const loadFollowupContext = (previousObserveFile: string): FollowupContext | CliResult => {
  if (!hasFileContent(previousObserveFile)) {
    return missingFollowupFailure(previousObserveFile)
  }
  const previous = previousResumeMetadataOf(previousObserveFile)
  if (previous === null) {
    return failure(5, 'follow-up unavailable: previous observe JSON is invalid\n')
  }
  return { previousObserveFile, previous }
}

const resolveModelPhase = (args: PrepareArgs, env: Env): ModelPhase | CliResult => {
  if (args.sessionMode !== 'followup') {
    return resolveRequestedModel(args, env)
  }
  const loaded = loadFollowupContext(args.previousObserveFile)
  if ('exitCode' in loaded) {
    return loaded
  }
  return { model: loaded.previous.model, modelSource: 'followup', followup: loaded }
}

const validateEffortPhase = (
  backend: string,
  model: string,
  modelSource: string
): CliResult | null => {
  // follow-up は前回指定子（suffix 込み）を無条件継承するため検証しない（初回時点で検証済み）
  if (modelSource === 'followup') {
    return null
  }
  const effort = validateModelEffort(backend, model)
  if (!effort.ok) {
    return failure(6, `${effort.message}\n`)
  }
  return null
}

const validateFollowupPhase = (
  phase: ModelPhase,
  backend: string,
  repoRoot: string
): CliResult | null => {
  const { followup } = phase
  if (followup === null) {
    return null
  }
  const validation = validateFollowup({
    previousObserveFile: followup.previousObserveFile,
    expectedBackend: backend,
    expectedModel: phase.model,
    expectedRepoRoot: repoRoot,
    expectedWorktreeRoot: repoRoot,
  })
  if (!validation.ok) {
    return failure(5, `${validation.message}\n`)
  }
  if (followup.previous.lineageId === '') {
    return failure(5, 'follow-up unavailable: lineage.lineage_id is missing\n')
  }
  return null
}

interface ResolvedPrepare {
  phase: ModelPhase
  backend: string
  repoRoot: string
}

const validateResolvedPhase = (
  args: PrepareArgs,
  phase: ModelPhase
): ResolvedPrepare | CliResult => {
  const backend = backendFor(args.taskType, phase.model)
  const effortFailure = validateEffortPhase(backend, phase.model, phase.modelSource)
  if (effortFailure !== null) {
    return effortFailure
  }
  const repoRoot = gitRepoRoot()
  const followupFailure = validateFollowupPhase(phase, backend, repoRoot)
  if (followupFailure !== null) {
    return followupFailure
  }
  return { phase, backend, repoRoot }
}

const resolvePreparePhases = (args: PrepareArgs, env: Env): ResolvedPrepare | CliResult => {
  const phase = resolveModelPhase(args, env)
  if ('exitCode' in phase) {
    return phase
  }
  return validateResolvedPhase(args, phase)
}

interface BuiltRequest {
  chainJson: string
  paths: RunPathsJson
}

interface RequestSource {
  model: string
  body: Buffer
}

const buildRequestPhase = (
  args: PrepareArgs,
  env: Env,
  source: RequestSource
): BuiltRequest | CliResult => {
  const chainResult = runCheckDelegateChain([args.taskType, args.parentChain])
  if (chainResult.exitCode !== 0) {
    return chainResult
  }
  const chainJson = chainResult.stdout.trimEnd()
  const buildResult = runBuildRequest(
    [args.taskType, source.model, chainJson, args.requesterSessionId],
    env,
    source.body
  )
  if (buildResult.exitCode !== 0) {
    return buildResult
  }
  return { chainJson, paths: parseRunPaths(buildResult.stdout) }
}

interface SessionRecord {
  lineageId: string
  resumeId: string
  resumeSource: string
  backendSessionHome: string
}

const EMPTY_SESSION: SessionRecord = {
  lineageId: '',
  resumeId: '',
  resumeSource: '',
  backendSessionHome: '',
}

const recordFollowupSession = (
  followup: FollowupContext,
  paths: RunPathsJson,
  repoRoot: string
): SessionRecord => {
  updateLineage(paths.observe_file, paths.run_dir, {
    lineageId: followup.previous.lineageId,
    followupOf: followup.previousObserveFile,
  })
  updateRunContext(paths.observe_file, paths.run_dir, { repoRoot, worktreeRoot: repoRoot })
  return {
    lineageId: followup.previous.lineageId,
    resumeId: followup.previous.resumeId,
    resumeSource: followup.previous.resumeSource,
    backendSessionHome: followup.previous.backendSessionHome,
  }
}

const recordSession = (
  args: PrepareArgs,
  resolved: ResolvedPrepare,
  paths: RunPathsJson
): SessionRecord => {
  if (args.sessionMode === 'resumable') {
    const lineageId = path.basename(paths.run_dir)
    updateLineage(paths.observe_file, paths.run_dir, { lineageId })
    updateRunContext(paths.observe_file, paths.run_dir, {
      repoRoot: resolved.repoRoot,
      worktreeRoot: resolved.repoRoot,
    })
    return { ...EMPTY_SESSION, lineageId }
  }
  if (resolved.phase.followup !== null) {
    return recordFollowupSession(resolved.phase.followup, paths, resolved.repoRoot)
  }
  return EMPTY_SESSION
}

const prepareOutput = (input: FinalizeInput, session: SessionRecord): CliResult => {
  const { args, resolved, built } = input
  const out: Record<string, unknown> = {
    model: resolved.phase.model,
    model_source: resolved.phase.modelSource,
    task_type_chain: JSON.parse(built.chainJson),
    request_file: built.paths.request_file,
    response_file: built.paths.response_file,
    run_dir: built.paths.run_dir,
    observe_file: built.paths.observe_file,
  }
  if (args.sessionMode === 'resumable') {
    Object.assign(out, { session_mode: args.sessionMode, lineage_id: session.lineageId })
  }
  if (args.sessionMode === 'followup') {
    Object.assign(out, {
      session_mode: args.sessionMode,
      lineage_id: session.lineageId,
      resume_id: session.resumeId,
      resume_source: session.resumeSource,
      backend_session_home: session.backendSessionHome,
    })
  }
  return { exitCode: 0, stderr: '', stdout: prettyJson(out) }
}

interface FinalizeInput {
  args: PrepareArgs
  resolved: ResolvedPrepare
  built: BuiltRequest
  body: Buffer
  startMs: number | null
}

const finalizePrepare = (env: Env, input: FinalizeInput): CliResult => {
  const { args, resolved, built } = input
  initObserve({
    observeFile: built.paths.observe_file,
    runDir: built.paths.run_dir,
    taskType: args.taskType,
    model: resolved.phase.model,
    backend: resolved.backend,
    requestFile: built.paths.request_file,
    responseFile: built.paths.response_file,
    requesterSessionId: args.requesterSessionId,
    modelSource: resolved.phase.modelSource,
  })
  const session = recordSession(args, resolved, built.paths)
  appendPrepareMetrics(env, {
    kind: 'prepare',
    durationMs: elapsedMs(input.startMs),
    taskType: args.taskType,
    typeEnv: args.typeEnv,
    defaultModel: args.defaultModel,
    model: resolved.phase.model,
    modelSource: resolved.phase.modelSource,
    requesterSessionId: args.requesterSessionId,
    taskTypeChain: JSON.parse(built.chainJson),
    requestFile: built.paths.request_file,
    responseFile: built.paths.response_file,
    runDir: built.paths.run_dir,
    observeFile: built.paths.observe_file,
    body: bodyStats(input.body),
  })
  return prepareOutput(input, session)
}

const preparedRun = (args: PrepareArgs, env: Env, readStdin: () => Buffer): CliResult => {
  const startMs = monotonicMs()
  const body = stripTrailingNewlineBytes(readStdin())
  const resolved = resolvePreparePhases(args, env)
  if ('exitCode' in resolved) {
    return resolved
  }
  const built = buildRequestPhase(args, env, { model: resolved.phase.model, body })
  if ('exitCode' in built) {
    return built
  }
  return finalizePrepare(env, { args, resolved, built, body, startMs })
}

// stdin は bash 版の body="$(cat)" と同じく引数検証を通過した後にだけ読む
// (引数エラーで入力待ちに入らないための遅延渡し)
export const runPrepare = (
  argv: readonly string[],
  env: Env,
  readStdin: () => Buffer
): CliResult => {
  const args = parsePrepareArgs(argv)
  if ('exitCode' in args) {
    return args
  }
  return preparedRun(args, env, readStdin)
}

// in-source test 専用 helper (bundle からは treeshake で除去される)
const makePrepareTestWorkDir = (): string => {
  mkdirSync('.temp', { recursive: true })
  const dir = `.temp/prepare-test-${Math.random().toString(36).slice(2)}`
  mkdirSync(dir)
  return dir
}

const testRequestBody = (): Buffer => Buffer.from('# Task\n\nprepare test body\n')

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  const body = testRequestBody

  describe('runPrepare', () => {
    it('fails closed with exit 2 on missing args and invalid session_mode', () => {
      expect(runPrepare([], {}, body).exitCode).toBe(2)
      expect(runPrepare(['chore', 'E', 'haiku', '[]'], {}, body).exitCode).toBe(2)
      const badMode = runPrepare(['chore', 'E', 'haiku', '[]', 'sid', 'bogus'], {}, body)
      expect(badMode.exitCode).toBe(2)
      expect(badMode.stderr).toContain('session_mode must be empty')
      const emptyFollowup = runPrepare(['chore', 'E', 'haiku', '[]', 'sid', 'followup='], {}, body)
      expect(emptyFollowup.exitCode).toBe(2)
      const badType = runPrepare(['review', 'E', 'haiku', '[]', 'sid', 'resumable'], {}, body)
      expect(badType.exitCode).toBe(2)
      expect(badType.stderr).toContain('only supported for implement/chore')
    })

    it('emits the prepare JSON and initializes observe on the happy path', () => {
      const workDir = makePrepareTestWorkDir()
      const result = runPrepare(
        ['chore', 'DELEGATE_PREPARE_TEST_MODEL', 'haiku', '[]', 'sid-1'],
        { DELEGATE_WORK_DIR: workDir },
        body
      )
      expect(result.exitCode).toBe(0)
      const parsed: unknown = JSON.parse(result.stdout)
      expect(parsed).toMatchObject({
        model: 'haiku',
        model_source: 'default',
        task_type_chain: ['chore'],
      })
      const paths = parseRunPaths(result.stdout)
      const observe: unknown = JSON.parse(readFileSync(paths.observe_file, 'utf8'))
      expect(observe).toMatchObject({
        run: { task_type: 'chore', model: 'haiku', backend: 'claude', model_source: 'default' },
        state: { phase: 'prepared' },
      })
      expect(result.stdout).not.toContain('session_mode')
    })

    it('resolves the model from the type env and records model_source env', () => {
      const workDir = makePrepareTestWorkDir()
      const result = runPrepare(
        ['chore', 'DELEGATE_PREPARE_TEST_MODEL', 'haiku', '[]', 'sid-1'],
        { DELEGATE_WORK_DIR: workDir, DELEGATE_PREPARE_TEST_MODEL: 'gpt-5.5' },
        body
      )
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ model: 'gpt-5.5', model_source: 'env' })
    })

    it('passes the delegation cycle through as exit 4', () => {
      const workDir = makePrepareTestWorkDir()
      const result = runPrepare(
        ['chore', 'DELEGATE_PREPARE_TEST_MODEL', 'haiku', '["chore"]', 'sid-1'],
        { DELEGATE_WORK_DIR: workDir },
        body
      )
      expect(result.exitCode).toBe(4)
      expect(result.stdout).toBe('')
    })

    it('fails closed with exit 6 on an invalid effort suffix', () => {
      const workDir = makePrepareTestWorkDir()
      const result = runPrepare(
        ['chore', 'DELEGATE_PREPARE_TEST_MODEL', 'haiku', '[]', 'sid-1'],
        { DELEGATE_WORK_DIR: workDir, DELEGATE_PREPARE_TEST_MODEL: 'haiku@bogus' },
        body
      )
      expect(result.exitCode).toBe(6)
      expect(result.stderr).toContain('invalid effort')
    })

    it('fails closed with exit 5 when the follow-up observe file is missing', () => {
      const workDir = makePrepareTestWorkDir()
      const result = runPrepare(
        [
          'chore',
          'DELEGATE_PREPARE_TEST_MODEL',
          'haiku',
          '[]',
          'sid-1',
          `followup=${workDir}/none.json`,
        ],
        { DELEGATE_WORK_DIR: workDir },
        body
      )
      expect(result.exitCode).toBe(5)
      expect(result.stderr).toContain('follow-up unavailable')
    })

    it('records the resumable lineage and run_context', () => {
      const workDir = makePrepareTestWorkDir()
      const result = runPrepare(
        ['chore', 'DELEGATE_PREPARE_TEST_MODEL', 'haiku', '[]', 'sid-1', 'resumable'],
        { DELEGATE_WORK_DIR: workDir },
        body
      )
      expect(result.exitCode).toBe(0)
      const parsed: unknown = JSON.parse(result.stdout)
      expect(parsed).toMatchObject({
        session_mode: 'resumable',
        lineage_id: expect.stringMatching(/^delegate_chore_/),
      })
      const paths = parseRunPaths(result.stdout)
      const observe: unknown = JSON.parse(readFileSync(paths.observe_file, 'utf8'))
      expect(observe).toMatchObject({
        lineage: { lineage_id: path.basename(paths.run_dir), followup_of: null },
        run_context: { git_head: expect.any(String) },
      })
    })

    it('appends the prepare metrics record with the bash-compatible shape', () => {
      const workDir = makePrepareTestWorkDir()
      const metricsFile = `${workDir}/metrics.jsonl`
      const result = runPrepare(
        ['chore', 'DELEGATE_PREPARE_TEST_MODEL', 'haiku', '[]', 'sid-1'],
        { DELEGATE_WORK_DIR: workDir, DELEGATE_METRICS_FILE: metricsFile },
        body
      )
      expect(result.exitCode).toBe(0)
      const records = readFileSync(metricsFile, 'utf8')
        .trimEnd()
        .split('\n')
        .map((line): unknown => JSON.parse(line))
      const prepareRecord = records.find((record) => isRecord(record) && record.kind === 'prepare')
      expect(prepareRecord).toMatchObject({
        kind: 'prepare',
        task_type: 'chore',
        type_env: 'DELEGATE_PREPARE_TEST_MODEL',
        default_model: 'haiku',
        model: 'haiku',
        model_source: 'default',
        requester_session_id: 'sid-1',
        task_type_chain: ['chore'],
        body: {
          bytes: 25,
          chars: 25,
          lines: 2,
          estimated_tokens: 7,
        },
      })
    })
  })
}
