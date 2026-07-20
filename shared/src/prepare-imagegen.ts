import { mkdirSync, readFileSync } from 'node:fs'
import { backendFor } from './backend.ts'
import { runBuildRequest, type Env } from './build-request.ts'
import { runCheckDelegateChain } from './check-delegate-chain.ts'
import type { CliResult } from './cli-result.ts'
import { isRecord } from './jq-compat.ts'
import { initObserve } from './observe-store.ts'
import { appendPrepareMetrics, parseRunPaths, type RunPathsJson } from './prepare.ts'
import { bodyStats, prettyJson, stripTrailingNewlineBytes } from './protocol.ts'
import { runResolveModel } from './resolve-model.ts'

// bash 版 prepare-imagegen.sh と同一契約:
// Usage: prepare-imagegen <parent_task_type_chain_json> <requester_session_id>
//   リクエスト本文 Markdown は stdin から渡す。
// exit: 2=引数エラー / 4=委譲サイクル / 6=effort 指定不正 / 1=md2idx 失敗・空 index/sections
// imagegen への effort 宣言経路は提供しない（capability bridge のため）。suffix は fail-closed

const TASK_TYPE = 'imagegen'
const TYPE_ENV = 'DELEGATE_IMAGEGEN_MODEL'
const DEFAULT_MODEL = 'gpt-5'

const USAGE =
  'Usage: prepare-imagegen <parent_task_type_chain_json> <requester_session_id>  (request body markdown on stdin)\n'

const failure = (exitCode: number, stderr: string): CliResult => ({ exitCode, stderr, stdout: '' })

const modelSourceOf = (env: Env): string => {
  if ((env[TYPE_ENV] ?? '') !== '') {
    return 'env'
  }
  return 'default'
}

interface ImagegenModel {
  model: string
  modelSource: string
}

const resolveImagegenModel = (env: Env): ImagegenModel | CliResult => {
  const modelSource = modelSourceOf(env)
  const resolved = runResolveModel([TYPE_ENV, DEFAULT_MODEL], env)
  if (resolved.exitCode !== 0) {
    return resolved
  }
  const model = resolved.stdout.trimEnd()
  if (model.includes('@')) {
    const suffix = model.slice(model.indexOf('@') + 1)
    return failure(
      6,
      `ERROR: effort suffix is not supported for delegate-imagegen (model '${model}'); remove '@${suffix}'\n`
    )
  }
  return { model, modelSource }
}

interface ImagegenBuilt {
  chainJson: string
  paths: RunPathsJson
}

const buildImagegenRequest = (
  parentChain: string,
  requesterSessionId: string,
  request: { model: string; body: Buffer; env: Env }
): ImagegenBuilt | CliResult => {
  const chainResult = runCheckDelegateChain([TASK_TYPE, parentChain])
  if (chainResult.exitCode !== 0) {
    return chainResult
  }
  const chainJson = chainResult.stdout.trimEnd()
  const buildResult = runBuildRequest(
    [TASK_TYPE, request.model, chainJson, requesterSessionId],
    request.env,
    request.body
  )
  if (buildResult.exitCode !== 0) {
    return buildResult
  }
  return { chainJson, paths: parseRunPaths(buildResult.stdout) }
}

interface ImagegenFinalizeInput {
  requesterSessionId: string
  resolved: ImagegenModel
  built: ImagegenBuilt
  body: Buffer
}

const finalizeImagegenPrepare = (env: Env, input: ImagegenFinalizeInput): CliResult => {
  const { resolved, built } = input
  initObserve({
    observeFile: built.paths.observe_file,
    runDir: built.paths.run_dir,
    taskType: TASK_TYPE,
    model: resolved.model,
    backend: backendFor(TASK_TYPE, resolved.model),
    requestFile: built.paths.request_file,
    responseFile: built.paths.response_file,
    requesterSessionId: input.requesterSessionId,
    modelSource: resolved.modelSource,
  })
  appendPrepareMetrics(env, {
    kind: 'prepare_imagegen',
    taskType: TASK_TYPE,
    typeEnv: TYPE_ENV,
    defaultModel: DEFAULT_MODEL,
    model: resolved.model,
    modelSource: resolved.modelSource,
    requesterSessionId: input.requesterSessionId,
    taskTypeChain: JSON.parse(built.chainJson),
    requestFile: built.paths.request_file,
    responseFile: built.paths.response_file,
    runDir: built.paths.run_dir,
    observeFile: built.paths.observe_file,
    body: bodyStats(input.body),
  })
  return {
    exitCode: 0,
    stderr: '',
    stdout: prettyJson({
      model: resolved.model,
      model_source: resolved.modelSource,
      task_type_chain: JSON.parse(built.chainJson),
      request_file: built.paths.request_file,
      response_file: built.paths.response_file,
      run_dir: built.paths.run_dir,
      observe_file: built.paths.observe_file,
    }),
  }
}

const chainOrTopLevel = (raw: string): string => {
  if (raw === '') {
    return '[]'
  }
  return raw
}

const preparedImagegenRun = (
  parsed: { parentChain: string; requesterSessionId: string },
  env: Env,
  body: Buffer
): CliResult => {
  const resolved = resolveImagegenModel(env)
  if ('exitCode' in resolved) {
    return resolved
  }
  const built = buildImagegenRequest(parsed.parentChain, parsed.requesterSessionId, {
    model: resolved.model,
    body,
    env,
  })
  if ('exitCode' in built) {
    return built
  }
  return finalizeImagegenPrepare(env, {
    requesterSessionId: parsed.requesterSessionId,
    resolved,
    built,
    body,
  })
}

// stdin は bash 版の body="$(cat)" と同じく引数検証を通過した後にだけ読む
export const runPrepareImagegen = (
  argv: readonly string[],
  env: Env,
  readStdin: () => Buffer
): CliResult => {
  if (argv.length < 2) {
    return failure(2, USAGE)
  }
  const [parentChainArg, requesterSessionId] = argv
  return preparedImagegenRun(
    { parentChain: chainOrTopLevel(parentChainArg), requesterSessionId },
    env,
    stripTrailingNewlineBytes(readStdin())
  )
}

// in-source test 専用 helper (bundle からは treeshake で除去される)
const makeImagegenTestWorkDir = (): string => {
  mkdirSync('.temp', { recursive: true })
  const dir = `.temp/prepare-imagegen-test-${Math.random().toString(36).slice(2)}`
  mkdirSync(dir)
  return dir
}

const testRequestBody = (): Buffer => Buffer.from('# Task\n\nimagegen test body\n')

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  const body = testRequestBody

  describe('runPrepareImagegen', () => {
    it('fails closed with exit 2 on missing args', () => {
      const result = runPrepareImagegen(['[]'], {}, body)
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('Usage:')
    })

    it('resolves the codex default model and initializes observe', () => {
      const workDir = makeImagegenTestWorkDir()
      const result = runPrepareImagegen(['[]', 'sid-1'], { DELEGATE_WORK_DIR: workDir }, body)
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        model: 'gpt-5',
        model_source: 'default',
        task_type_chain: ['imagegen'],
      })
      const paths = parseRunPaths(result.stdout)
      const observe: unknown = JSON.parse(readFileSync(paths.observe_file, 'utf8'))
      expect(observe).toMatchObject({
        run: { task_type: 'imagegen', backend: 'codex', model: 'gpt-5' },
      })
    })

    it('fails closed with exit 6 on an effort suffix', () => {
      const workDir = makeImagegenTestWorkDir()
      const result = runPrepareImagegen(
        ['[]', 'sid-1'],
        { DELEGATE_WORK_DIR: workDir, DELEGATE_IMAGEGEN_MODEL: 'gpt-5@high' },
        body
      )
      expect(result.exitCode).toBe(6)
      expect(result.stderr).toContain('effort suffix is not supported for delegate-imagegen')
    })

    it('appends the prepare_imagegen metrics record without duration_ms', () => {
      const workDir = makeImagegenTestWorkDir()
      const metricsFile = `${workDir}/metrics.jsonl`
      const result = runPrepareImagegen(
        ['[]', 'sid-1'],
        { DELEGATE_WORK_DIR: workDir, DELEGATE_METRICS_FILE: metricsFile },
        body
      )
      expect(result.exitCode).toBe(0)
      const records = readFileSync(metricsFile, 'utf8')
        .trimEnd()
        .split('\n')
        .map((line): unknown => JSON.parse(line))
      const record = records.find(
        (candidate) => isRecord(candidate) && candidate.kind === 'prepare_imagegen'
      )
      expect(record).toMatchObject({ kind: 'prepare_imagegen', task_type: 'imagegen' })
      expect(isRecord(record) && 'duration_ms' in record).toBe(false)
    })
  })
}
