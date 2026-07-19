import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'
import { md2idx } from 'md2idx'
import type { CliResult } from './cli-result.ts'
import {
  appendMetrics,
  bodyStats,
  estimatedTokens,
  metricsTimestamp,
  prettyJson,
  randomToken,
  runTimestamp,
  writeCompanionMarkdown,
} from './protocol.ts'

// bash 版 build-request.sh と同一契約 (protocol v1)。
// Usage: build-request <task_type> <model> <task_type_chain_json> <requester_session_id>
// stdin: リクエスト本文 Markdown
// stdout: {request_file, response_file, run_dir, observe_file} の pretty JSON
// exit: 2=引数エラー / 1=md2idx 失敗・空 index/sections

export type Env = Readonly<Partial<Record<string, string>>>

const failure = (exitCode: number, stderr: string): CliResult => ({
  exitCode,
  stderr,
  stdout: '',
})

const positiveIntOrZero = (value: string | null | undefined): number => {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    return 0
  }
  return Number(value)
}

const observePhase = (observeFile: string): string => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(observeFile, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && 'state' in parsed) {
      const { state } = parsed
      if (typeof state === 'object' && state !== null && 'phase' in state) {
        const { phase } = state
        if (typeof phase === 'string') {
          return phase
        }
      }
    }
  } catch {
    // observe が読めない run dir は保持者不明として通常の削除対象に含める
  }
  return ''
}

const removeRunDirIfExpired = (candidate: string, cutoffMs: number): void => {
  try {
    const stat = statSync(candidate)
    const expired = stat.isDirectory() && Date.now() - stat.mtimeMs >= cutoffMs
    if (expired && observePhase(`${candidate}_observe.json`) !== 'running') {
      rmSync(candidate, { force: true, recursive: true })
    }
  } catch {
    // 消せない candidate はスキップ (bash 版の find/rm エラー握りつぶしと同じ)
  }
}

// find -mtime +N 相当: 経過日数の整数部が N を超えた run dir を削除する
const cleanupOldRunDirs = (workDir: string, env: Env): void => {
  const retentionDays = positiveIntOrZero(env.DELEGATE_RUN_RETENTION_DAYS)
  if (retentionDays <= 0) {
    return
  }
  const cutoffMs = (retentionDays + 1) * 24 * 60 * 60 * 1000
  let entries: string[] = []
  try {
    entries = readdirSync(workDir)
  } catch {
    return
  }
  for (const name of entries.filter((entry) => entry.startsWith('delegate_'))) {
    removeRunDirIfExpired(path.join(workDir, name), cutoffMs)
  }
}

interface RunPaths {
  requestFile: string
  responseFile: string
  runDir: string
  observeFile: string
}

const isCollision = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'

const tryAllocateRunPaths = (
  workDir: string,
  taskType: string,
  timestamp: string
): RunPaths | CliResult => {
  const token = randomToken(5)
  const requestFile = path.join(workDir, `delegate_${taskType}_${timestamp}_${token}_req.json`)
  try {
    closeSync(openSync(requestFile, 'wx'))
  } catch (error) {
    if (isCollision(error)) {
      // 既存 token と衝突したら引き直す (呼び出し側でリトライ)
      return failure(0, '')
    }
    // ENOENT (task_type にパス区切り等) などの永続エラーはリトライせず即失敗する
    return failure(1, `ERROR: request_file を作成できません: ${requestFile}\n`)
  }
  const base = requestFile.replace(/_req\.json$/, '')
  return {
    requestFile,
    responseFile: `${base}_res.json`,
    runDir: base,
    observeFile: `${base}_observe.json`,
  }
}

// EEXIST の連続は乱数 token の衝突なので実際には数回で収束する。上限は保険
const MAX_ALLOCATE_ATTEMPTS = 100

const allocateRunPaths = (workDir: string, taskType: string): RunPaths | CliResult => {
  const timestamp = runTimestamp()
  for (let attempt = 0; attempt < MAX_ALLOCATE_ATTEMPTS; attempt += 1) {
    const paths = tryAllocateRunPaths(workDir, taskType, timestamp)
    if ('requestFile' in paths || paths.exitCode !== 0) {
      return paths
    }
  }
  return failure(1, `ERROR: request_file の名前衝突が解消できません: ${workDir}\n`)
}

const parseChainArg = (raw: string): unknown[] | null => {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed
    }
  } catch {
    // fallthrough: 非配列と同じ扱い
  }
  return null
}

const writeSourceMarkdown = (workDir: string, runDir: string, stdin: Buffer): string => {
  const srcMd = path.join(workDir, `${path.basename(runDir)}_reqsrc_${randomToken(5)}.md`)
  const fd = openSync(srcMd, 'wx')
  writeSync(fd, stdin)
  closeSync(fd)
  return srcMd
}

interface BuildRequestContext {
  taskType: string
  model: string
  taskTypeChain: unknown[]
  requesterSessionId: string
  env: Env
  stdin: Buffer
  workDir: string
  paths: RunPaths
}

const appendBuildRequestMetrics = (context: BuildRequestContext, sectionCount: number): void => {
  const body = bodyStats(context.stdin)
  appendMetrics(context.env.DELEGATE_METRICS_FILE, {
    kind: 'build_request',
    ts: metricsTimestamp(),
    task_type: context.taskType,
    model: context.model,
    requester_session_id: context.requesterSessionId,
    request_file: context.paths.requestFile,
    response_file: context.paths.responseFile,
    body: {
      bytes: body.bytes,
      chars: body.chars,
      lines: body.lines,
      estimated_tokens: estimatedTokens(body.chars),
    },
    request: {
      bytes: statSync(context.paths.requestFile).size,
      sections: sectionCount,
    },
  })
}

const emitRequest = (context: BuildRequestContext): CliResult => {
  const { paths } = context
  const srcMd = writeSourceMarkdown(context.workDir, paths.runDir, context.stdin)
  const { index, sections } = md2idx(context.stdin.toString('utf8'))
  writeFileSync(
    paths.requestFile,
    prettyJson({
      protocol_version: 1,
      type: 'request',
      task_type: context.taskType,
      model: context.model,
      task_type_chain: context.taskTypeChain,
      requester_session_id: context.requesterSessionId,
      index,
      sections,
    })
  )
  if (index.length === 0 || sections.length === 0) {
    // 失敗時は入力 Markdown をデバッグ用に残す
    return failure(
      1,
      `ERROR: md2idx が空の index/sections を返しました（入力 Markdown を確認してください）: ${srcMd}\n`
    )
  }
  writeCompanionMarkdown(paths.requestFile, sections)
  unlinkSync(srcMd)
  appendBuildRequestMetrics(context, sections.length)
  return {
    exitCode: 0,
    stderr: '',
    stdout: prettyJson({
      request_file: paths.requestFile,
      response_file: paths.responseFile,
      run_dir: paths.runDir,
      observe_file: paths.observeFile,
    }),
  }
}

// bash の ${VAR:-fallback} と同じく空文字も未設定として扱う
const nonEmptyEnv = (value: string | undefined): string | null => {
  if (typeof value === 'string' && value !== '') {
    return value
  }
  return null
}

const prepareWorkDir = (env: Env): string => {
  const workDir = path.resolve(
    nonEmptyEnv(env.DELEGATE_WORK_DIR) ?? nonEmptyEnv(env.TMPDIR) ?? '/tmp'
  )
  mkdirSync(workDir, { recursive: true })
  cleanupOldRunDirs(workDir, env)
  return workDir
}

const prepareRunPaths = (
  env: Env,
  taskType: string
): { workDir: string; paths: RunPaths } | CliResult => {
  const workDir = prepareWorkDir(env)
  const paths = allocateRunPaths(workDir, taskType)
  if (!('requestFile' in paths)) {
    return paths
  }
  mkdirSync(paths.runDir, { recursive: true })
  return { workDir, paths }
}

export const runBuildRequest = (argv: readonly string[], env: Env, stdin: Buffer): CliResult => {
  if (argv.length < 4) {
    return failure(
      2,
      'Usage: build-request <task_type> <model> <task_type_chain_json> <requester_session_id>  (request body markdown on stdin)\n'
    )
  }
  const [taskType, model, taskTypeChainRaw, requesterSessionId] = argv
  const taskTypeChain = parseChainArg(taskTypeChainRaw)
  if (taskTypeChain === null) {
    return failure(2, `ERROR: task_type_chain が JSON 配列ではありません: ${taskTypeChainRaw}\n`)
  }
  const prepared = prepareRunPaths(env, taskType)
  if ('exitCode' in prepared) {
    return prepared
  }
  return emitRequest({
    taskType,
    model,
    taskTypeChain,
    requesterSessionId,
    env,
    stdin,
    workDir: prepared.workDir,
    paths: prepared.paths,
  })
}

// in-source test 専用 helper (bundle からは treeshake で除去される)
const makeAgedRunDir = (workDir: string, token: string, phase: string | null): string => {
  const dir = path.join(workDir, `delegate_chore_20200101_000000_${token}`)
  mkdirSync(dir)
  if (phase !== null) {
    writeFileSync(`${dir}_observe.json`, `{"state":{"phase":"${phase}"}}`)
  }
  const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
  utimesSync(dir, past, past)
  return dir
}

const makeTestWorkDir = (): string => {
  mkdirSync('.temp', { recursive: true })
  const dir = path.join('.temp', `build-request-test-${randomToken(8)}`)
  mkdirSync(dir)
  return dir
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  const makeWorkDir = makeTestWorkDir
  describe('runBuildRequest', () => {
    it('fails closed with exit 2 on missing args or a non-array chain', () => {
      expect(runBuildRequest(['chore'], {}, Buffer.alloc(0)).exitCode).toBe(2)
      expect(runBuildRequest(['chore', 'haiku', '{}', 'sid'], {}, Buffer.alloc(0)).exitCode).toBe(2)
      expect(runBuildRequest(['chore', 'haiku', 'bad', 'sid'], {}, Buffer.alloc(0)).exitCode).toBe(
        2
      )
    })

    it('prints the derived run path JSON on success', () => {
      const workDir = makeWorkDir()
      const result = runBuildRequest(
        ['chore', 'haiku', '["explore"]', 'sid-1'],
        { DELEGATE_WORK_DIR: workDir },
        Buffer.from('# Objective\n\n本文\n')
      )
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        request_file: expect.stringMatching(/delegate_chore_\d{8}_\d{6}_[A-Za-z0-9]{5}_req\.json$/),
        response_file: expect.stringMatching(/_res\.json$/),
        observe_file: expect.stringMatching(/_observe\.json$/),
      })
    })

    it('writes the envelope and companion markdown', () => {
      const workDir = makeWorkDir()
      runBuildRequest(
        ['chore', 'haiku', '["explore"]', 'sid-1'],
        { DELEGATE_WORK_DIR: workDir },
        Buffer.from('# Objective\n\n本文\n')
      )
      const requestName = readdirSync(workDir).find((name) => name.endsWith('_req.json')) ?? ''
      const requestFile = path.join(workDir, requestName)
      expect(JSON.parse(readFileSync(requestFile, 'utf8'))).toMatchObject({
        protocol_version: 1,
        type: 'request',
        task_type: 'chore',
        model: 'haiku',
        task_type_chain: ['explore'],
        requester_session_id: 'sid-1',
      })
      expect(readFileSync(requestFile.replace(/\.json$/, '.md'), 'utf8')).toBe(
        '# Objective\n\n本文\n'
      )
    })

    it('fails closed with exit 1 on an empty body, keeping the source markdown', () => {
      const workDir = makeWorkDir()
      const result = runBuildRequest(
        ['chore', 'haiku', '[]', 'sid'],
        { DELEGATE_WORK_DIR: workDir },
        Buffer.alloc(0)
      )
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('reqsrc')
    })

    it('fails closed instead of looping when the request file cannot be created', () => {
      const workDir = makeWorkDir()
      const result = runBuildRequest(
        ['bad/type', 'haiku', '[]', 'sid'],
        { DELEGATE_WORK_DIR: workDir },
        Buffer.from('# Objective\n\nx\n')
      )
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('作成できません')
    })

    it('treats empty work-dir env vars as unset like the bash :- fallback', () => {
      const fallbackDir = makeWorkDir()
      const result = runBuildRequest(
        ['chore', 'haiku', '[]', 'sid'],
        { DELEGATE_WORK_DIR: '', TMPDIR: fallbackDir },
        Buffer.from('# Objective\n\nx\n')
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(path.resolve(fallbackDir))
    })

    it('removes expired run dirs but keeps running ones', () => {
      const workDir = makeWorkDir()
      const oldDir = makeAgedRunDir(workDir, 'aaaaa', null)
      const runningDir = makeAgedRunDir(workDir, 'bbbbb', 'running')
      const result = runBuildRequest(
        ['chore', 'haiku', '[]', 'sid'],
        { DELEGATE_WORK_DIR: workDir, DELEGATE_RUN_RETENTION_DAYS: '1' },
        Buffer.from('# Objective\n\nx\n')
      )
      expect(result.exitCode).toBe(0)
      expect(existsSync(oldDir)).toBe(false)
      expect(existsSync(runningDir)).toBe(true)
    })
  })
}
