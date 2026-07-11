import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// 各テストが bash wrapper + fake CLI (node) を実プロセスとして spawn するため、
// 並列実行の負荷次第で既定 5 秒を超え得る
vi.setConfig({ testTimeout: 30_000 })

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

interface FakeCliLog {
  args: string[]
  command: string | null
  cwd: string
  env: {
    BASH_DEFAULT_TIMEOUT_MS: string | null
    BASH_MAX_TIMEOUT_MS: string | null
    CLAUDE_CONFIG_DIR: string | null
    CODEX_HOME: string | null
    CURSOR_CONFIG_DIR: string | null
    TMPDIR: string | null
  }
}

interface BackendSession {
  home_dir: string | null
  persistence: string | null
  resume_id: string | null
  resume_source: string | null
}

interface RunContext {
  git_head: string | null
  repo_root: string | null
  worktree_root: string | null
}

interface ObserveJson {
  backend_session: BackendSession | null
  run_context: RunContext | null
}

interface Fixture {
  env: NodeJS.ProcessEnv
  logFile: string
  observeFile: string
  requestFile: string
  responseFile: string
  runDir: string
  workDir: string
}

const makeWorkDir = (): string => {
  const tempRoot = path.join(repoRoot, '.temp')
  mkdirSync(tempRoot, { recursive: true })
  return mkdtempSync(path.join(tempRoot, 'delegate-wrapper-session-test-'))
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const stringOrNullValue = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value
  }
  return null
}

const readUnknownJson = (filePath: string): unknown => JSON.parse(readFileSync(filePath, 'utf8'))

const asLogRecords = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value
  }
  return [value]
}

const readLog = (filePath: string): FakeCliLog => {
  const value = readUnknownJson(filePath)
  const records = asLogRecords(value)
  const record = records[records.length - 1]
  if (!isRecord(record) || !Array.isArray(record.args) || !isRecord(record.env)) {
    throw new Error('invalid fake CLI log')
  }
  return {
    args: record.args.map(String),
    command: stringOrNullValue(record.command),
    cwd: stringOrNullValue(record.cwd) ?? '',
    env: {
      BASH_DEFAULT_TIMEOUT_MS: stringOrNullValue(record.env.BASH_DEFAULT_TIMEOUT_MS),
      BASH_MAX_TIMEOUT_MS: stringOrNullValue(record.env.BASH_MAX_TIMEOUT_MS),
      CLAUDE_CONFIG_DIR: stringOrNullValue(record.env.CLAUDE_CONFIG_DIR),
      CODEX_HOME: stringOrNullValue(record.env.CODEX_HOME),
      CURSOR_CONFIG_DIR: stringOrNullValue(record.env.CURSOR_CONFIG_DIR),
      TMPDIR: stringOrNullValue(record.env.TMPDIR),
    },
  }
}

const readLogs = (filePath: string): FakeCliLog[] => {
  const value = readUnknownJson(filePath)
  const records = asLogRecords(value)
  return records.map((record) => {
    if (!isRecord(record) || !Array.isArray(record.args) || !isRecord(record.env)) {
      throw new Error('invalid fake CLI log')
    }
    return {
      args: record.args.map(String),
      command: stringOrNullValue(record.command),
      cwd: stringOrNullValue(record.cwd) ?? '',
      env: {
        BASH_DEFAULT_TIMEOUT_MS: stringOrNullValue(record.env.BASH_DEFAULT_TIMEOUT_MS),
        BASH_MAX_TIMEOUT_MS: stringOrNullValue(record.env.BASH_MAX_TIMEOUT_MS),
        CLAUDE_CONFIG_DIR: stringOrNullValue(record.env.CLAUDE_CONFIG_DIR),
        CODEX_HOME: stringOrNullValue(record.env.CODEX_HOME),
        CURSOR_CONFIG_DIR: stringOrNullValue(record.env.CURSOR_CONFIG_DIR),
        TMPDIR: stringOrNullValue(record.env.TMPDIR),
      },
    }
  })
}

const parseBackendSession = (value: unknown): BackendSession | null => {
  if (!isRecord(value)) {
    return null
  }
  return {
    home_dir: stringOrNullValue(value.home_dir),
    persistence: stringOrNullValue(value.persistence),
    resume_id: stringOrNullValue(value.resume_id),
    resume_source: stringOrNullValue(value.resume_source),
  }
}

const parseRunContext = (value: unknown): RunContext | null => {
  if (!isRecord(value)) {
    return null
  }
  return {
    git_head: stringOrNullValue(value.git_head),
    repo_root: stringOrNullValue(value.repo_root),
    worktree_root: stringOrNullValue(value.worktree_root),
  }
}

const readObserve = (filePath: string): ObserveJson => {
  const value = readUnknownJson(filePath)
  if (!isRecord(value)) {
    throw new Error('invalid observe JSON')
  }
  return {
    backend_session: parseBackendSession(value.backend_session),
    run_context: parseRunContext(value.run_context),
  }
}

const readResponseStatus = (filePath: string): string => {
  const value = readUnknownJson(filePath)
  if (!isRecord(value) || typeof value.status !== 'string') {
    throw new Error('invalid response JSON')
  }
  return value.status
}

const requireBackendSession = (observe: ObserveJson): BackendSession => {
  if (!observe.backend_session) {
    throw new Error('missing backend_session')
  }
  return observe.backend_session
}

const requireRunContext = (observe: ObserveJson): RunContext => {
  if (!observe.run_context) {
    throw new Error('missing run_context')
  }
  return observe.run_context
}

const claudeFakeScript = (): string => `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
const prompt = args[args.indexOf('-p') + 1] || ''
const loggedEnv = () => ({
  BASH_DEFAULT_TIMEOUT_MS: process.env.BASH_DEFAULT_TIMEOUT_MS,
  BASH_MAX_TIMEOUT_MS: process.env.BASH_MAX_TIMEOUT_MS,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  TMPDIR: process.env.TMPDIR,
})
if (process.env.FAKE_CLAUDE_EXIT_WITHOUT_RESPONSE === '1') {
  fs.writeFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({args, cwd: process.cwd(), env: loggedEnv()}))
  process.exit(9)
}
const responseMatches = [...prompt.matchAll(/"([^"]+_res\\.json)"/g)].map((match) => match[1])
const responseFile = responseMatches[responseMatches.length - 1]
const status = process.env.FAKE_CLAUDE_FAILED_RESPONSE === '1' ? 'failed' : 'completed'
if (responseFile) {
  fs.writeFileSync(responseFile, JSON.stringify({protocol_version: 1, type: 'response', status, responder_session_id: 'fake', sections: ['# Summary\\nok']}))
}
const sessionIdIndex = args.indexOf('--session-id')
if (sessionIdIndex !== -1 && process.env.CLAUDE_CONFIG_DIR && process.env.FAKE_CLAUDE_NO_SESSION !== '1') {
  const sessionDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fake-project')
  fs.mkdirSync(sessionDir, {recursive: true})
  fs.writeFileSync(path.join(sessionDir, args[sessionIdIndex + 1] + '.jsonl'), '{}\\n')
}
fs.writeFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({args, cwd: process.cwd(), env: loggedEnv()}))
console.log(JSON.stringify({type: 'result', usage: {input_tokens: 1, output_tokens: 1}}))
`

const codexFakeScript = (): string => `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
const prompt = args[args.length - 1] || ''
if (process.env.FAKE_CODEX_EXIT_WITHOUT_RESPONSE === '1') {
  fs.writeFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({args, cwd: process.cwd(), env: {CODEX_HOME: process.env.CODEX_HOME, TMPDIR: process.env.TMPDIR}}))
  process.exit(9)
}
const responseMatches = [...prompt.matchAll(/"([^"]+_res\\.json)"/g)].map((match) => match[1])
const responseFile = responseMatches[responseMatches.length - 1]
const status = process.env.FAKE_CODEX_FAILED_RESPONSE === '1' ? 'failed' : 'completed'
if (responseFile) {
  fs.writeFileSync(responseFile, JSON.stringify({protocol_version: 1, type: 'response', status, responder_session_id: 'fake', sections: ['# Summary\\nok']}))
}
fs.writeFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({args, cwd: process.cwd(), env: {CODEX_HOME: process.env.CODEX_HOME, TMPDIR: process.env.TMPDIR}}))
if (process.env.FAKE_CODEX_NO_THREAD !== '1') {
  console.log(JSON.stringify({type: 'thread.started', thread_id: 'thread-1'}))
}
console.log(JSON.stringify({type: 'turn.completed', usage: {input_tokens: 1, output_tokens: 1}}))
`

const devinFakeScript = (): string => `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
const prompt = args[args.indexOf('-p') + 1] || ''
if (process.env.FAKE_DEVIN_EXIT_WITHOUT_RESPONSE === '1') {
  fs.writeFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({args, command: 'devin', cwd: process.cwd(), env: {TMPDIR: process.env.TMPDIR}}))
  process.exit(9)
}
const responseMatches = [...prompt.matchAll(/"([^"]+_res\\.json)"/g)].map((match) => match[1])
const responseFile = responseMatches[responseMatches.length - 1]
const status = process.env.FAKE_DEVIN_FAILED_RESPONSE === '1' ? 'failed' : 'completed'
if (responseFile) {
  fs.writeFileSync(responseFile, JSON.stringify({protocol_version: 1, type: 'response', status, responder_session_id: 'fake', sections: ['# Summary\\nok']}))
}
const exportIndex = args.indexOf('--export')
if (exportIndex !== -1 && process.env.FAKE_DEVIN_NO_SESSION !== '1') {
  fs.writeFileSync(args[exportIndex + 1], JSON.stringify({session_id: 'devin-session-1', final_metrics: {prompt_tokens: 1, completion_tokens: 1}}))
}
fs.writeFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({args, command: 'devin', cwd: process.cwd(), env: {TMPDIR: process.env.TMPDIR}}))
`

const cursorFakeScript = (): string => `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
const entry = {args, command: 'agent', cwd: process.cwd(), env: {CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR, TMPDIR: process.env.TMPDIR}}
let logs = []
try {
  logs = JSON.parse(fs.readFileSync(process.env.FAKE_CLI_LOG, 'utf8'))
  if (!Array.isArray(logs)) logs = [logs]
} catch {}
logs.push(entry)
fs.writeFileSync(process.env.FAKE_CLI_LOG, JSON.stringify(logs))
if (args[0] === 'create-chat') {
  if (process.env.FAKE_CURSOR_CREATE_CHAT_FAIL === '1') {
    console.log('diagnostic-noise-not-a-chat-id')
    process.exit(7)
  }
  const createChatCalls = logs.filter((log) => log.args[0] === 'create-chat').length
  if (process.env.FAKE_CURSOR_CREATE_CHAT_FAIL_ONCE === '1' && createChatCalls === 1) {
    console.log('diagnostic-noise-not-a-chat-id')
    process.exit(7)
  }
  if (process.env.FAKE_CURSOR_NO_CHAT !== '1') {
    console.log('cursor-chat-1')
  }
  process.exit(0)
}
if (process.env.FAKE_CURSOR_EXIT_WITHOUT_RESPONSE === '1') {
  process.exit(9)
}
const prompt = args[args.length - 1] || ''
const responseMatches = [...prompt.matchAll(/"([^"]+_res\\.json)"/g)].map((match) => match[1])
const responseFile = responseMatches[responseMatches.length - 1]
const status = process.env.FAKE_CURSOR_FAILED_RESPONSE === '1' ? 'failed' : 'completed'
if (responseFile) {
  fs.writeFileSync(responseFile, JSON.stringify({protocol_version: 1, type: 'response', status, responder_session_id: 'fake', sections: ['# Summary\\nok']}))
}
console.log(JSON.stringify({type: 'result', subtype: 'success', usage: {inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0}}))
`

type Backend = 'claude' | 'codex' | 'devin' | 'cursor'

const fakeScript = (name: Backend): string => {
  if (name === 'claude') {
    return claudeFakeScript()
  }
  if (name === 'codex') {
    return codexFakeScript()
  }
  if (name === 'devin') {
    return devinFakeScript()
  }
  return cursorFakeScript()
}

const cliName = (backend: Backend): string => {
  if (backend === 'cursor') {
    return 'agent'
  }
  return backend
}

const writeFakeCli = (binDir: string, backend: Backend): void => {
  const scriptPath = path.join(binDir, cliName(backend))
  writeFileSync(scriptPath, fakeScript(backend))
  chmodSync(scriptPath, 0o755)
}

const makeFixturePaths = (
  backend: Backend
): Omit<Fixture, 'env'> & {
  binDir: string
  homeDir: string
} => {
  const workDir = makeWorkDir()
  const runDir = path.join(workDir, 'run')
  return {
    binDir: path.join(workDir, 'bin'),
    homeDir: path.join(workDir, 'home'),
    logFile: path.join(workDir, `${backend}.log.json`),
    observeFile: path.join(runDir, 'delegate_observe.json'),
    requestFile: path.join(runDir, 'delegate_req.json'),
    responseFile: path.join(runDir, 'delegate_res.json'),
    runDir,
    workDir,
  }
}

const writeFixtureFiles = (
  paths: Omit<Fixture, 'env'> & { binDir: string; homeDir: string },
  backend: Backend
): void => {
  mkdirSync(paths.binDir, { recursive: true })
  mkdirSync(paths.runDir, { recursive: true })
  mkdirSync(path.join(paths.homeDir, '.claude'), { recursive: true })
  mkdirSync(path.join(paths.homeDir, '.codex'), { recursive: true })
  mkdirSync(path.join(paths.homeDir, '.cursor'), { recursive: true })
  writeFileSync(path.join(paths.homeDir, '.claude', '.credentials.json'), '{}')
  writeFileSync(path.join(paths.homeDir, '.codex', 'auth.json'), '{}')
  writeFileSync(path.join(paths.homeDir, '.cursor', 'cli-config.json'), '{}')
  writeFileSync(paths.requestFile, JSON.stringify({ sections: ['request'] }))
  writeFakeCli(paths.binDir, backend)
}

const fixtureEnv = (
  paths: Omit<Fixture, 'env'> & { binDir: string; homeDir: string }
): NodeJS.ProcessEnv => ({
  ...process.env,
  CURSOR_CONFIG_DIR: '',
  DELEGATE_OBSERVE_HEARTBEAT_INTERVAL: '1',
  FAKE_CLI_LOG: paths.logFile,
  HOME: paths.homeDir,
  PATH: `${paths.binDir}:${process.env.PATH ?? ''}`,
  XDG_CONFIG_HOME: '',
})

const makeFixture = (backend: Backend): Fixture => {
  const paths = makeFixturePaths(backend)
  writeFixtureFiles(paths, backend)
  return { ...paths, env: fixtureEnv(paths) }
}

const runWrapper = (
  scriptName:
    | 'delegate-claude.sh'
    | 'delegate-codex.sh'
    | 'delegate-devin.sh'
    | 'delegate-cursor.sh',
  args: string[],
  env: NodeJS.ProcessEnv
): { status: number } => {
  try {
    execFileSync('bash', [path.join(repoRoot, 'shared', scriptName), ...args], {
      cwd: repoRoot,
      env,
      stdio: 'pipe',
    })
    return { status: 0 }
  } catch (error) {
    if (isRecord(error) && typeof error.status === 'number') {
      return { status: error.status }
    }
    throw error
  }
}

const claudeArgs = (fixture: Fixture, modeArgs: string[] = []): string[] => [
  'sonnet',
  'implement',
  fixture.requestFile,
  fixture.responseFile,
  fixture.runDir,
  fixture.observeFile,
  ...modeArgs,
]

const codexArgs = (fixture: Fixture, modeArgs: string[] = []): string[] => [
  'gpt-5.5',
  'implement',
  fixture.requestFile,
  fixture.responseFile,
  fixture.runDir,
  fixture.observeFile,
  ...modeArgs,
]

const devinArgs = (fixture: Fixture, modeArgs: string[] = []): string[] => [
  'devin-glm-5.2',
  'implement',
  fixture.requestFile,
  fixture.responseFile,
  fixture.runDir,
  fixture.observeFile,
  ...modeArgs,
]

const cursorArgs = (fixture: Fixture, modeArgs: string[] = []): string[] => [
  'cursor-glm-5.2-high',
  'implement',
  fixture.requestFile,
  fixture.responseFile,
  fixture.runDir,
  fixture.observeFile,
  ...modeArgs,
]

const runClaude = (
  fixture: Fixture,
  modeArgs: string[] = [],
  env: NodeJS.ProcessEnv = fixture.env
): { status: number } => runWrapper('delegate-claude.sh', claudeArgs(fixture, modeArgs), env)

const runCodex = (
  fixture: Fixture,
  modeArgs: string[] = [],
  env: NodeJS.ProcessEnv = fixture.env
): { status: number } => runWrapper('delegate-codex.sh', codexArgs(fixture, modeArgs), env)

const runDevin = (
  fixture: Fixture,
  modeArgs: string[] = [],
  env: NodeJS.ProcessEnv = fixture.env
): { status: number } => runWrapper('delegate-devin.sh', devinArgs(fixture, modeArgs), env)

const runCursor = (
  fixture: Fixture,
  modeArgs: string[] = [],
  env: NodeJS.ProcessEnv = fixture.env
): { status: number } => runWrapper('delegate-cursor.sh', cursorArgs(fixture, modeArgs), env)

const taskTypeArgs = (fixture: Fixture, model: string, taskType: string): string[] => [
  model,
  taskType,
  fixture.requestFile,
  fixture.responseFile,
  fixture.runDir,
  fixture.observeFile,
]

const runClaudeTaskType = (
  fixture: Fixture,
  taskType: string,
  env: NodeJS.ProcessEnv = fixture.env
): { status: number } =>
  runWrapper('delegate-claude.sh', taskTypeArgs(fixture, 'sonnet', taskType), env)

const runCursorTaskType = (
  fixture: Fixture,
  taskType: string,
  env: NodeJS.ProcessEnv = fixture.env
): { status: number } =>
  runWrapper('delegate-cursor.sh', taskTypeArgs(fixture, 'cursor-glm-5.2-high', taskType), env)

// claude は `-p <prompt>`、cursor は `-p` が単独フラグでプロンプトが最終引数
const promptFromLog = (log: FakeCliLog): string => {
  const flagIndex = log.args.indexOf('-p')
  if (flagIndex !== -1) {
    const candidate = log.args[flagIndex + 1] ?? ''
    if (candidate !== '' && !candidate.startsWith('-')) {
      return candidate
    }
  }
  return log.args[log.args.length - 1] ?? ''
}

interface ExpectWrapperRun {
  fixture: Fixture
  log: FakeCliLog
  observe: ObserveJson
  result: { status: number }
}

interface ExpectFollowupRun {
  log: FakeCliLog
  observe: ObserveJson
  result: { status: number }
  sessionHome: string
}

interface ExpectFailedRunUnavailable {
  backend: Backend
  expectedStatus: number
  fixture: Fixture
  model: string
  observe: ObserveJson
  result: { status: number }
}

const expectClaudeResumableArgs = (fixture: Fixture, log: FakeCliLog): string => {
  const sessionIdIndex = log.args.indexOf('--session-id')
  expect(log.args).not.toContain('--no-session-persistence')
  expect(sessionIdIndex).toBeGreaterThan(-1)
  expect(log.env.CLAUDE_CONFIG_DIR).toBe(path.join(fixture.runDir, 'claude-config'))
  expect(existsSync(path.join(fixture.runDir, 'claude-config', '.credentials.json'))).toBe(true)
  return log.args[sessionIdIndex + 1]
}

const expectClaudeResumableObserve = (observe: ObserveJson, sessionId: string): void => {
  const backendSession = requireBackendSession(observe)
  const runContext = requireRunContext(observe)
  expect(backendSession.persistence).toBe('resumable')
  expect(backendSession.resume_id).toBe(sessionId)
  expect(backendSession.resume_source).toBe('session_id_arg')
  expect(runContext.repo_root).toBe(repoRoot)
}

const expectClaudeResumable = ({ fixture, log, observe, result }: ExpectWrapperRun): void => {
  const sessionId = expectClaudeResumableArgs(fixture, log)
  expect(result.status).toBe(0)
  expectClaudeResumableObserve(observe, sessionId)
}

const expectClaudeFollowup = ({ log, observe, result, sessionHome }: ExpectFollowupRun): void => {
  expect(result.status).toBe(0)
  expect(log.args).toContain('--resume')
  expect(log.args).toContain('sid-1')
  expect(log.args).not.toContain('--session-id')
  expect(log.args).not.toContain('--no-session-persistence')
  expect(log.env.CLAUDE_CONFIG_DIR).toBe(sessionHome)
  expect(requireBackendSession(observe).resume_id).toBe('sid-1')
}

const expectUnavailable = (result: { status: number }, observe: ObserveJson): void => {
  const backendSession = requireBackendSession(observe)
  expect(result.status).toBe(0)
  expect(backendSession.persistence).toBe('unavailable')
  expect(backendSession.resume_id).toBeNull()
}

const errorOutputPart = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8')
  }
  return ''
}

const runFollowupValidation = (
  fixture: Fixture,
  backend: Backend,
  model: string
): { output: string; status: number } => {
  const script = `
    set -euo pipefail
    source shared/observe-json.sh
    delegate_observe_validate_followup "${fixture.observeFile}" ${backend} ${model} "${repoRoot}" "${repoRoot}"
  `
  try {
    const output = execFileSync('bash', ['-c', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    return { output, status: 0 }
  } catch (error) {
    if (isRecord(error) && typeof error.status === 'number') {
      return {
        output: `${errorOutputPart(error.stdout)}${errorOutputPart(error.stderr)}`,
        status: error.status,
      }
    }
    throw error
  }
}

const expectFailedRunUnavailable = ({
  backend,
  expectedStatus,
  fixture,
  model,
  observe,
  result,
}: ExpectFailedRunUnavailable): void => {
  const backendSession = requireBackendSession(observe)
  const validation = runFollowupValidation(fixture, backend, model)

  expect(result.status).toBe(expectedStatus)
  expect(readResponseStatus(fixture.responseFile)).toBe('failed')
  expect(backendSession.persistence).toBe('unavailable')
  expect(backendSession.resume_id).toBeNull()
  expect(validation.status).not.toBe(0)
  expect(validation.output).toContain('backend_session.persistence is not resumable')
}

const expectCodexResumable = ({ fixture, log, observe, result }: ExpectWrapperRun): void => {
  const backendSession = requireBackendSession(observe)
  const runContext = requireRunContext(observe)
  expect(result.status).toBe(0)
  expect(log.args).not.toContain('--ephemeral')
  expect(log.args).toContain('--sandbox')
  expect(log.env.CODEX_HOME).toBe(path.join(fixture.runDir, 'codex-home'))
  expect(backendSession.persistence).toBe('resumable')
  expect(backendSession.resume_id).toBe('thread-1')
  expect(backendSession.resume_source).toBe('codex_json')
  expect(runContext.worktree_root).toBe(repoRoot)
}

const expectCodexFollowup = ({ log, observe, result, sessionHome }: ExpectFollowupRun): void => {
  expect(result.status).toBe(0)
  expect(log.args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-1'])
  expect(log.args).toContain('-c')
  expect(log.args).toContain('sandbox_mode=danger-full-access')
  expect(log.args).not.toContain('--ephemeral')
  expect(log.args).not.toContain('--sandbox')
  expect(log.args).not.toContain('-C')
  expect(log.cwd).toBe(repoRoot)
  expect(log.env.CODEX_HOME).toBe(sessionHome)
  expect(requireBackendSession(observe).resume_id).toBe('thread-1')
}

const expectDevinResumable = ({ log, observe, result }: ExpectWrapperRun): void => {
  const backendSession = requireBackendSession(observe)
  const runContext = requireRunContext(observe)
  expect(result.status).toBe(0)
  expect(log.args).toContain('--export')
  expect(log.args).not.toContain('--resume')
  expect(backendSession.persistence).toBe('resumable')
  expect(backendSession.resume_id).toBe('devin-session-1')
  expect(backendSession.resume_source).toBe('devin_atif_export')
  expect(backendSession.home_dir).toBeNull()
  expect(runContext.repo_root).toBe(repoRoot)
}

const expectDevinFollowup = ({ log, observe, result }: ExpectWrapperRun): void => {
  expect(result.status).toBe(0)
  expect(log.args).toContain('--resume')
  expect(log.args).toContain('devin-session-1')
  expect(log.args).toContain('--export')
  expect(requireBackendSession(observe).resume_id).toBe('devin-session-1')
}

const expectCursorResumableArgs = (
  createChatLog: FakeCliLog,
  log: FakeCliLog,
  result: { status: number }
): void => {
  expect(result.status).toBe(0)
  expect(createChatLog.args).toEqual(['create-chat'])
  expect(log.args).toContain('--resume')
  expect(log.args).toContain('cursor-chat-1')
}

const expectCursorResumableObserve = (observe: ObserveJson): void => {
  const backendSession = requireBackendSession(observe)
  const runContext = requireRunContext(observe)
  expect(backendSession.persistence).toBe('resumable')
  expect(backendSession.resume_id).toBe('cursor-chat-1')
  expect(backendSession.resume_source).toBe('cursor_create_chat')
  expect(backendSession.home_dir).toBeNull()
  expect(runContext.worktree_root).toBe(repoRoot)
}

const expectCursorResumable = ({
  log,
  observe,
  result,
  createChatLog,
}: ExpectWrapperRun & { createChatLog: FakeCliLog }): void => {
  expectCursorResumableArgs(createChatLog, log, result)
  expectCursorResumableObserve(observe)
}

const expectCursorFollowup = ({ log, observe, result }: ExpectWrapperRun): void => {
  expect(result.status).toBe(0)
  expect(log.args).toContain('--resume')
  expect(log.args).toContain('cursor-chat-1')
  expect(requireBackendSession(observe).resume_id).toBe('cursor-chat-1')
}

const prepareClaudeSessionHome = (workDir: string): string => {
  const sessionHome = path.join(workDir, 'claude-home')
  mkdirSync(path.join(sessionHome, 'projects', 'repo'), { recursive: true })
  writeFileSync(path.join(sessionHome, 'projects', 'repo', 'sid-1.jsonl'), '{}\n')
  return sessionHome
}

const prepareCodexSessionHome = (workDir: string): string => {
  const sessionHome = path.join(workDir, 'codex-home')
  mkdirSync(sessionHome, { recursive: true })
  return sessionHome
}

const expectFailedWithoutChild = (fixture: Fixture, result: { status: number }): void => {
  expect(result.status).toBe(5)
  expect(readResponseStatus(fixture.responseFile)).toBe('failed')
  expect(existsSync(fixture.logFile)).toBe(false)
}

describe('delegate-claude.sh session modes', () => {
  it('keeps normal runs non-persistent', () => {
    const fixture = makeFixture('claude')
    const result = runClaude(fixture)
    const log = readLog(fixture.logFile)

    expect(result.status).toBe(0)
    expect(log.args).toContain('--no-session-persistence')
    expect(log.args).not.toContain('--session-id')
    expect(log.args).not.toContain('--resume')
    expect(log.env.CLAUDE_CONFIG_DIR).toBeNull()
  })

  it('injects Bash tool timeout caps into the child env by default', () => {
    const fixture = makeFixture('claude')
    const result = runClaude(fixture)
    const log = readLog(fixture.logFile)

    expect(result.status).toBe(0)
    expect(log.env.BASH_DEFAULT_TIMEOUT_MS).toBe('300000')
    expect(log.env.BASH_MAX_TIMEOUT_MS).toBe('300000')
  })

  it('overrides the injected Bash timeout via DELEGATE_CHILD_BASH_TIMEOUT_MS', () => {
    const fixture = makeFixture('claude')
    const result = runClaude(fixture, [], {
      ...fixture.env,
      DELEGATE_CHILD_BASH_TIMEOUT_MS: '120000',
    })
    const log = readLog(fixture.logFile)

    expect(result.status).toBe(0)
    expect(log.env.BASH_DEFAULT_TIMEOUT_MS).toBe('120000')
    expect(log.env.BASH_MAX_TIMEOUT_MS).toBe('120000')
  })

  it('skips Bash timeout injection when DELEGATE_CHILD_BASH_TIMEOUT_MS is 0', () => {
    const fixture = makeFixture('claude')
    const result = runClaude(fixture, [], {
      ...fixture.env,
      DELEGATE_CHILD_BASH_TIMEOUT_MS: '0',
    })
    const log = readLog(fixture.logFile)

    expect(result.status).toBe(0)
    expect(log.env.BASH_DEFAULT_TIMEOUT_MS).toBeNull()
    expect(log.env.BASH_MAX_TIMEOUT_MS).toBeNull()
  })

  it('starts resumable runs with a lineage config dir and session id', () => {
    const fixture = makeFixture('claude')
    const result = runClaude(fixture, ['resumable', '', ''])
    const log = readLog(fixture.logFile)
    const observe = readObserve(fixture.observeFile)

    expectClaudeResumable({ fixture, log, observe, result })
  })

  it('resumes follow-up runs with --resume', () => {
    const fixture = makeFixture('claude')
    const sessionHome = prepareClaudeSessionHome(fixture.workDir)
    const result = runClaude(fixture, ['followup', 'sid-1', sessionHome])
    const log = readLog(fixture.logFile)
    const observe = readObserve(fixture.observeFile)

    expectClaudeFollowup({ log, observe, result, sessionHome })
  })

  it('fails closed before launching Claude when the session file is missing', () => {
    const fixture = makeFixture('claude')
    const sessionHome = prepareClaudeSessionHome(fixture.workDir)
    const result = runClaude(fixture, ['followup', 'missing', sessionHome])

    expectFailedWithoutChild(fixture, result)
  })

  it('records unavailable persistence when the resumable session file is absent', () => {
    const fixture = makeFixture('claude')
    const result = runClaude(fixture, ['resumable', '', ''], {
      ...fixture.env,
      FAKE_CLAUDE_NO_SESSION: '1',
    })
    const observe = readObserve(fixture.observeFile)

    expectUnavailable(result, observe)
  })

  it('does not record failed resumable runs as follow-up bases', () => {
    const fixture = makeFixture('claude')
    const result = runClaude(fixture, ['resumable', '', ''], {
      ...fixture.env,
      FAKE_CLAUDE_EXIT_WITHOUT_RESPONSE: '1',
    })
    const observe = readObserve(fixture.observeFile)

    expectFailedRunUnavailable({
      backend: 'claude',
      expectedStatus: 9,
      fixture,
      model: 'sonnet',
      observe,
      result,
    })
  })

  it('does not record failed protocol responses as follow-up bases', () => {
    const fixture = makeFixture('claude')
    const result = runClaude(fixture, ['resumable', '', ''], {
      ...fixture.env,
      FAKE_CLAUDE_FAILED_RESPONSE: '1',
    })
    const observe = readObserve(fixture.observeFile)

    expectFailedRunUnavailable({
      backend: 'claude',
      expectedStatus: 0,
      fixture,
      model: 'sonnet',
      observe,
      result,
    })
  })
})

const seedCodexHomeLeftovers = (fixture: Fixture): string => {
  const codexHome = path.join(fixture.runDir, 'codex-home')
  mkdirSync(path.join(codexHome, '.tmp'), { recursive: true })
  mkdirSync(path.join(codexHome, 'sessions'), { recursive: true })
  writeFileSync(path.join(codexHome, '.tmp', 'cache.bin'), 'cache')
  writeFileSync(path.join(codexHome, 'models_cache.json'), '{}')
  writeFileSync(path.join(codexHome, 'sessions', 'rollout.jsonl'), '{}\n')
  writeFileSync(path.join(codexHome, 'config.toml'), '')
  return codexHome
}

describe('read-only tool config and prompt constraints', () => {
  it('uses a repo-write denylist for claude explore instead of the allowlist', () => {
    const fixture = makeFixture('claude')
    const result = runClaudeTaskType(fixture, 'explore')
    const log = readLog(fixture.logFile)
    const denyIndex = log.args.indexOf('--disallowedTools')

    expect(result.status).toBe(0)
    expect(denyIndex).toBeGreaterThan(-1)
    expect(log.args[denyIndex + 1]).toBe('Edit,MultiEdit,Write,NotebookEdit')
    expect(log.args).not.toContain('--allowedTools')
  })

  it('keeps the claude review allowlist unchanged', () => {
    const fixture = makeFixture('claude')
    const result = runClaudeTaskType(fixture, 'review')
    const log = readLog(fixture.logFile)
    const allowIndex = log.args.indexOf('--allowedTools')

    expect(result.status).toBe(0)
    expect(allowIndex).toBeGreaterThan(-1)
    expect(log.args[allowIndex + 1]).toBe('Read,Bash')
    expect(log.args).not.toContain('--disallowedTools')
  })

  it('mentions web/MCP exploration in the claude explore prompt without MCP restriction by default', () => {
    const fixture = makeFixture('claude')
    const result = runClaudeTaskType(fixture, 'explore')
    const prompt = promptFromLog(readLog(fixture.logFile))

    expect(result.status).toBe(0)
    expect(prompt).toContain('WebSearch / WebFetch')
    expect(prompt).toContain('read-only 制約')
    expect(prompt).not.toContain('MCP 制約')
  })

  it('injects the MCP read-only constraint when DELEGATE_EXPLORE_MCP_READ_ONLY=1', () => {
    const fixture = makeFixture('claude')
    const result = runClaudeTaskType(fixture, 'explore', {
      ...fixture.env,
      DELEGATE_EXPLORE_MCP_READ_ONLY: '1',
    })
    const prompt = promptFromLog(readLog(fixture.logFile))

    expect(result.status).toBe(0)
    expect(prompt).toContain('MCP 制約')
  })

  it('shares the explore constraints with the cursor prompt', () => {
    const fixture = makeFixture('cursor')
    const result = runCursorTaskType(fixture, 'explore', {
      ...fixture.env,
      DELEGATE_EXPLORE_MCP_READ_ONLY: '1',
    })
    const prompt = promptFromLog(readLog(fixture.logFile))

    expect(result.status).toBe(0)
    expect(prompt).toContain('WebSearch / WebFetch')
    expect(prompt).toContain('read-only 制約')
    expect(prompt).toContain('MCP 制約')
  })
})

describe('delegate-codex.sh session modes', () => {
  it('keeps normal runs ephemeral', () => {
    const fixture = makeFixture('codex')
    const result = runCodex(fixture)
    const log = readLog(fixture.logFile)

    expect(result.status).toBe(0)
    expect(log.args).toContain('--ephemeral')
    expect(log.args).toContain('--sandbox')
    expect(log.args).toContain('-C')
    expect(log.args).not.toContain('resume')
  })

  it('prunes codex-home caches and the auth copy after successful runs', () => {
    const fixture = makeFixture('codex')
    const codexHome = seedCodexHomeLeftovers(fixture)
    const result = runCodex(fixture)

    expect(result.status).toBe(0)
    expect(existsSync(path.join(codexHome, '.tmp'))).toBe(false)
    expect(existsSync(path.join(codexHome, 'models_cache.json'))).toBe(false)
    expect(existsSync(path.join(codexHome, 'auth.json'))).toBe(false)
    expect(existsSync(path.join(codexHome, 'sessions', 'rollout.jsonl'))).toBe(true)
    expect(existsSync(path.join(codexHome, 'config.toml'))).toBe(true)
  })

  it('keeps codex-home intact when DELEGATE_CODEX_HOME_PRUNE is 0', () => {
    const fixture = makeFixture('codex')
    const codexHome = seedCodexHomeLeftovers(fixture)
    const result = runCodex(fixture, [], {
      ...fixture.env,
      DELEGATE_CODEX_HOME_PRUNE: '0',
    })

    expect(result.status).toBe(0)
    expect(existsSync(path.join(codexHome, '.tmp'))).toBe(true)
    expect(existsSync(path.join(codexHome, 'auth.json'))).toBe(true)
  })

  it('keeps codex-home intact when the run fails', () => {
    const fixture = makeFixture('codex')
    const codexHome = seedCodexHomeLeftovers(fixture)
    const result = runCodex(fixture, [], {
      ...fixture.env,
      FAKE_CODEX_EXIT_WITHOUT_RESPONSE: '1',
    })

    expect(result.status).toBe(9)
    expect(existsSync(path.join(codexHome, '.tmp'))).toBe(true)
    expect(existsSync(path.join(codexHome, 'auth.json'))).toBe(true)
  })

  it('starts resumable runs without --ephemeral and records thread.started', () => {
    const fixture = makeFixture('codex')
    const result = runCodex(fixture, ['resumable', '', ''])
    const log = readLog(fixture.logFile)
    const observe = readObserve(fixture.observeFile)

    expectCodexResumable({ fixture, log, observe, result })
  })

  it('resumes follow-up runs from the lineage home', () => {
    const fixture = makeFixture('codex')
    const sessionHome = prepareCodexSessionHome(fixture.workDir)
    const result = runCodex(fixture, ['followup', 'thread-1', sessionHome])
    const log = readLog(fixture.logFile)
    const observe = readObserve(fixture.observeFile)

    expectCodexFollowup({ log, observe, result, sessionHome })
  })

  it('fails closed before launching Codex when session_home is missing', () => {
    const fixture = makeFixture('codex')
    const missingHome = path.join(fixture.workDir, 'missing-home')
    const result = runCodex(fixture, ['followup', 'thread-1', missingHome])

    expectFailedWithoutChild(fixture, result)
  })

  it('records unavailable persistence when thread.started is absent', () => {
    const fixture = makeFixture('codex')
    const result = runCodex(fixture, ['resumable', '', ''], {
      ...fixture.env,
      FAKE_CODEX_NO_THREAD: '1',
    })
    const observe = readObserve(fixture.observeFile)

    expectUnavailable(result, observe)
  })

  it('does not record failed resumable runs as follow-up bases', () => {
    const fixture = makeFixture('codex')
    const result = runCodex(fixture, ['resumable', '', ''], {
      ...fixture.env,
      FAKE_CODEX_EXIT_WITHOUT_RESPONSE: '1',
    })
    const observe = readObserve(fixture.observeFile)

    expectFailedRunUnavailable({
      backend: 'codex',
      expectedStatus: 9,
      fixture,
      model: 'gpt-5.5',
      observe,
      result,
    })
  })

  it('does not record failed protocol responses as follow-up bases', () => {
    const fixture = makeFixture('codex')
    const result = runCodex(fixture, ['resumable', '', ''], {
      ...fixture.env,
      FAKE_CODEX_FAILED_RESPONSE: '1',
    })
    const observe = readObserve(fixture.observeFile)

    expectFailedRunUnavailable({
      backend: 'codex',
      expectedStatus: 0,
      fixture,
      model: 'gpt-5.5',
      observe,
      result,
    })
  })
})

const runImagegen = (
  fixture: Fixture,
  env: NodeJS.ProcessEnv = fixture.env
): { status: number } => {
  const script = path.join(
    repoRoot,
    'skills',
    'delegate-imagegen',
    'scripts',
    'delegate-imagegen-codex.sh'
  )
  const args = [
    'gpt-5.5',
    fixture.requestFile,
    fixture.responseFile,
    fixture.runDir,
    fixture.observeFile,
  ]
  try {
    execFileSync('bash', [script, ...args], { cwd: repoRoot, env, stdio: 'pipe' })
    return { status: 0 }
  } catch (error) {
    if (isRecord(error) && typeof error.status === 'number') {
      return { status: error.status }
    }
    throw error
  }
}

describe('delegate-imagegen-codex.sh prune', () => {
  it('prunes codex-home after successful runs', () => {
    const fixture = makeFixture('codex')
    const codexHome = seedCodexHomeLeftovers(fixture)
    const result = runImagegen(fixture)

    expect(result.status).toBe(0)
    expect(existsSync(path.join(codexHome, '.tmp'))).toBe(false)
    expect(existsSync(path.join(codexHome, 'auth.json'))).toBe(false)
    expect(existsSync(path.join(codexHome, 'sessions', 'rollout.jsonl'))).toBe(true)
  })

  it('keeps codex-home when the protocol response status is failed', () => {
    const fixture = makeFixture('codex')
    const codexHome = seedCodexHomeLeftovers(fixture)
    const result = runImagegen(fixture, {
      ...fixture.env,
      FAKE_CODEX_FAILED_RESPONSE: '1',
    })

    expect(result.status).toBe(0)
    expect(readResponseStatus(fixture.responseFile)).toBe('failed')
    expect(existsSync(path.join(codexHome, '.tmp'))).toBe(true)
    expect(existsSync(path.join(codexHome, 'auth.json'))).toBe(true)
  })
})

describe('delegate-devin.sh session modes', () => {
  it('keeps normal runs without --resume', () => {
    const fixture = makeFixture('devin')
    const result = runDevin(fixture)
    const log = readLog(fixture.logFile)

    expect(result.status).toBe(0)
    expect(log.args).toContain('--export')
    expect(log.args).not.toContain('--resume')
  })

  it('records export session_id for resumable runs', () => {
    const fixture = makeFixture('devin')
    const result = runDevin(fixture, ['resumable', '', ''])
    const log = readLog(fixture.logFile)
    const observe = readObserve(fixture.observeFile)

    expectDevinResumable({ fixture, log, observe, result })
  })

  it('resumes follow-up runs with --resume', () => {
    const fixture = makeFixture('devin')
    const result = runDevin(fixture, ['followup', 'devin-session-1', ''])
    const log = readLog(fixture.logFile)
    const observe = readObserve(fixture.observeFile)

    expectDevinFollowup({ fixture, log, observe, result })
  })

  it('fails closed before launching Devin when resume_id is missing', () => {
    const fixture = makeFixture('devin')
    const result = runDevin(fixture, ['followup', '', ''])

    expectFailedWithoutChild(fixture, result)
  })

  it('records unavailable persistence when export session_id is absent', () => {
    const fixture = makeFixture('devin')
    const result = runDevin(fixture, ['resumable', '', ''], {
      ...fixture.env,
      FAKE_DEVIN_NO_SESSION: '1',
    })
    const observe = readObserve(fixture.observeFile)

    expectUnavailable(result, observe)
  })

  it('does not record failed resumable runs as follow-up bases', () => {
    const fixture = makeFixture('devin')
    const result = runDevin(fixture, ['resumable', '', ''], {
      ...fixture.env,
      FAKE_DEVIN_EXIT_WITHOUT_RESPONSE: '1',
    })
    const observe = readObserve(fixture.observeFile)

    expectFailedRunUnavailable({
      backend: 'devin',
      expectedStatus: 9,
      fixture,
      model: 'devin-glm-5.2',
      observe,
      result,
    })
  })

  it('does not record failed protocol responses as follow-up bases', () => {
    const fixture = makeFixture('devin')
    const result = runDevin(fixture, ['resumable', '', ''], {
      ...fixture.env,
      FAKE_DEVIN_FAILED_RESPONSE: '1',
    })
    const observe = readObserve(fixture.observeFile)

    expectFailedRunUnavailable({
      backend: 'devin',
      expectedStatus: 0,
      fixture,
      model: 'devin-glm-5.2',
      observe,
      result,
    })
  })
})

describe('delegate-cursor.sh session modes', () => {
  it('keeps normal runs without create-chat or --resume', () => {
    const fixture = makeFixture('cursor')
    const result = runCursor(fixture)
    const log = readLog(fixture.logFile)

    expect(result.status).toBe(0)
    expect(log.args).not.toContain('create-chat')
    expect(log.args).not.toContain('--resume')
    expect(log.args.join(' ')).toContain('--output-format stream-json')
  })

  it('isolates CURSOR_CONFIG_DIR into the run dir and copies cli-config.json', () => {
    const fixture = makeFixture('cursor')
    const result = runCursor(fixture)
    const log = readLog(fixture.logFile)

    expect(result.status).toBe(0)
    expect(log.env.CURSOR_CONFIG_DIR).toBe(path.join(fixture.runDir, 'cursor-config'))
    expect(existsSync(path.join(fixture.runDir, 'cursor-config', 'cli-config.json'))).toBe(true)
  })

  it('runs create-chat with the isolated CURSOR_CONFIG_DIR too', () => {
    const fixture = makeFixture('cursor')
    const result = runCursor(fixture, ['resumable', '', ''])
    const logs = readLogs(fixture.logFile)

    expect(result.status).toBe(0)
    expect(logs[0].args).toEqual(['create-chat'])
    expect(logs[0].env.CURSOR_CONFIG_DIR).toBe(path.join(fixture.runDir, 'cursor-config'))
  })

  it('creates a chat and starts resumable runs with --resume', () => {
    const fixture = makeFixture('cursor')
    const result = runCursor(fixture, ['resumable', '', ''])
    const logs = readLogs(fixture.logFile)
    const observe = readObserve(fixture.observeFile)

    expectCursorResumable({
      createChatLog: logs[0],
      fixture,
      log: logs[1],
      observe,
      result,
    })
  })

  it('resumes follow-up runs with --resume', () => {
    const fixture = makeFixture('cursor')
    const result = runCursor(fixture, ['followup', 'cursor-chat-1', ''])
    const log = readLog(fixture.logFile)
    const observe = readObserve(fixture.observeFile)

    expectCursorFollowup({ fixture, log, observe, result })
  })

  it('fails closed before launching Cursor when resume_id is missing', () => {
    const fixture = makeFixture('cursor')
    const result = runCursor(fixture, ['followup', '', ''])

    expectFailedWithoutChild(fixture, result)
  })

  it('retries create-chat and continues when a later attempt succeeds', () => {
    const fixture = makeFixture('cursor')
    const result = runCursor(fixture, ['resumable', '', ''], {
      ...fixture.env,
      FAKE_CURSOR_CREATE_CHAT_FAIL_ONCE: '1',
    })
    const logs = readLogs(fixture.logFile)
    const observe = readObserve(fixture.observeFile)

    expect(logs.slice(0, 2).map((log) => log.args)).toEqual([['create-chat'], ['create-chat']])
    expectCursorResumable({
      createChatLog: logs[1],
      fixture,
      log: logs[2],
      observe,
      result,
    })
  })

  it('fails closed and records unavailable persistence when create-chat keeps failing', () => {
    const fixture = makeFixture('cursor')
    const result = runCursor(fixture, ['resumable', '', ''], {
      ...fixture.env,
      FAKE_CURSOR_CREATE_CHAT_FAIL: '1',
    })
    const logs = readLogs(fixture.logFile)
    const observe = readObserve(fixture.observeFile)

    expect(result.status).toBe(5)
    expect(readResponseStatus(fixture.responseFile)).toBe('failed')
    expect(logs).toHaveLength(3)
    expect(logs.map((log) => log.args)).toEqual([['create-chat'], ['create-chat'], ['create-chat']])
    expect(requireBackendSession(observe).persistence).toBe('unavailable')
  })

  it('does not record failed resumable runs as follow-up bases', () => {
    const fixture = makeFixture('cursor')
    const result = runCursor(fixture, ['resumable', '', ''], {
      ...fixture.env,
      FAKE_CURSOR_EXIT_WITHOUT_RESPONSE: '1',
    })
    const observe = readObserve(fixture.observeFile)

    expectFailedRunUnavailable({
      backend: 'cursor',
      expectedStatus: 9,
      fixture,
      model: 'cursor-glm-5.2-high',
      observe,
      result,
    })
  })

  it('does not record failed protocol responses as follow-up bases', () => {
    const fixture = makeFixture('cursor')
    const result = runCursor(fixture, ['resumable', '', ''], {
      ...fixture.env,
      FAKE_CURSOR_FAILED_RESPONSE: '1',
    })
    const observe = readObserve(fixture.observeFile)

    expectFailedRunUnavailable({
      backend: 'cursor',
      expectedStatus: 0,
      fixture,
      model: 'cursor-glm-5.2-high',
      observe,
      result,
    })
  })
})
