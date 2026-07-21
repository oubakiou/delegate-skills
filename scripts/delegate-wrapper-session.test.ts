import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// 各テストが bash wrapper + fake CLI (node) を実プロセスとして spawn するため、
// 並列実行の負荷次第で既定 5 秒を超え得る
vi.setConfig({ testTimeout: 30_000 })

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const codexAuthSecret = 'root-auth-secret'

interface FakeCliLog {
  args: string[]
  authPresent: boolean | null
  command: string | null
  cwd: string
  prompt: string | null
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
  model: string | null
  persistence: string | null
  resume_id: string | null
  resume_source: string | null
}

interface RunContext {
  git_head: string | null
  repo_root: string | null
  worktree_root: string | null
}

interface McpConfig {
  servers: string[]
  source: string | null
}

interface RunEffort {
  requested: string | null
  effective: {
    value: string | null
    source: string | null
    fast?: boolean
  }
}

interface ObserveJson {
  backend_session: BackendSession | null
  event_kinds: string[]
  mcp_config: McpConfig | null
  run_context: RunContext | null
  run_effort: RunEffort | null
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

const booleanOrNullValue = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') {
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
    authPresent: booleanOrNullValue(record.authPresent),
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
    prompt: stringOrNullValue(record.prompt),
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
      authPresent: booleanOrNullValue(record.authPresent),
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
      prompt: stringOrNullValue(record.prompt),
    }
  })
}

const parseBackendSession = (value: unknown): BackendSession | null => {
  if (!isRecord(value)) {
    return null
  }
  return {
    home_dir: stringOrNullValue(value.home_dir),
    model: stringOrNullValue(value.model),
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

const parseRunEffort = (run: unknown): RunEffort | null => {
  if (!isRecord(run) || !isRecord(run.effort)) {
    return null
  }
  const { effort } = run
  if (!isRecord(effort.effective)) {
    return null
  }
  const effective: RunEffort['effective'] = {
    source: stringOrNullValue(effort.effective.source),
    value: stringOrNullValue(effort.effective.value),
  }
  if (typeof effort.effective.fast === 'boolean') {
    effective.fast = effort.effective.fast
  }
  return {
    effective,
    requested: stringOrNullValue(effort.requested),
  }
}

const parseEventKinds = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return []
  }
  const kinds: string[] = []
  for (const event of value) {
    if (isRecord(event) && typeof event.kind === 'string') {
      kinds.push(event.kind)
    }
  }
  return kinds
}

const parseMcpConfig = (value: unknown): McpConfig | null => {
  if (!isRecord(value)) {
    return null
  }
  const servers: string[] = []
  if (Array.isArray(value.servers)) {
    servers.push(...value.servers.map(String))
  }
  return {
    servers,
    source: stringOrNullValue(value.source),
  }
}

const readObserve = (filePath: string): ObserveJson => {
  const value = readUnknownJson(filePath)
  if (!isRecord(value)) {
    throw new Error('invalid observe JSON')
  }
  return {
    backend_session: parseBackendSession(value.backend_session),
    event_kinds: parseEventKinds(value.events),
    mcp_config: parseMcpConfig(value.mcp_config),
    run_context: parseRunContext(value.run_context),
    run_effort: parseRunEffort(value.run),
  }
}

const readResponseStatus = (filePath: string): string => {
  const value = readUnknownJson(filePath)
  if (!isRecord(value) || typeof value.status !== 'string') {
    throw new Error('invalid response JSON')
  }
  return value.status
}

const countMetricKind = (filePath: string, kind: string): number =>
  readFileSync(filePath, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line): unknown => JSON.parse(line))
    .filter((record) => isRecord(record) && record.kind === kind).length

const countEventKind = (observe: ObserveJson, kind: string): number =>
  observe.event_kinds.filter((eventKind) => eventKind === kind).length

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
let prompt = ''
try { prompt = fs.readFileSync(0, 'utf8') } catch {}
const loggedEnv = () => ({
  BASH_DEFAULT_TIMEOUT_MS: process.env.BASH_DEFAULT_TIMEOUT_MS,
  BASH_MAX_TIMEOUT_MS: process.env.BASH_MAX_TIMEOUT_MS,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  TMPDIR: process.env.TMPDIR,
})
if (process.env.FAKE_CLAUDE_EXIT_WITHOUT_RESPONSE === '1') {
  fs.writeFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({args, prompt, cwd: process.cwd(), env: loggedEnv()}))
  process.exit(9)
}
const status = process.env.FAKE_CLAUDE_FAILED_RESPONSE === '1' ? 'failed' : 'completed'
const sessionIdIndex = args.indexOf('--session-id')
if (sessionIdIndex !== -1 && process.env.CLAUDE_CONFIG_DIR && process.env.FAKE_CLAUDE_NO_SESSION !== '1') {
  const sessionDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fake-project')
  fs.mkdirSync(sessionDir, {recursive: true})
  fs.writeFileSync(path.join(sessionDir, args[sessionIdIndex + 1] + '.jsonl'), '{}\\n')
}
fs.writeFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({args, prompt, cwd: process.cwd(), env: loggedEnv()}))
if (process.env.FAKE_CLAUDE_NO_STRUCTURED === '1') {
  console.log(JSON.stringify({type: 'result', usage: {input_tokens: 1, output_tokens: 1}}))
} else if (process.env.FAKE_CLAUDE_EMPTY_REPORT === '1') {
  console.log(JSON.stringify({type: 'result', structured_output: {status, report_markdown: '   '}, usage: {input_tokens: 1, output_tokens: 1}}))
} else {
  console.log(JSON.stringify({type: 'result', structured_output: {status, report_markdown: '# Summary\\nok'}, usage: {input_tokens: 1, output_tokens: 1}}))
}
`

const codexFakeScript = (): string => `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
if (args.join(' ') === 'mcp list --json') {
  console.log(process.env.FAKE_CODEX_MCP_LIST_JSON || '[]')
  process.exit(0)
}
let prompt = args[args.length - 1] || ''
if (prompt === '-') {
  prompt = ''
  try { prompt = fs.readFileSync(0, 'utf8') } catch {}
}
const authPresent = Boolean(process.env.CODEX_HOME && fs.existsSync(path.join(process.env.CODEX_HOME, 'auth.json')))
const logRun = () => fs.writeFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({args, authPresent, prompt, cwd: process.cwd(), env: {CODEX_HOME: process.env.CODEX_HOME, TMPDIR: process.env.TMPDIR}}))
if (process.env.FAKE_CODEX_SIGNAL_SELF === '1') {
  logRun()
  process.kill(process.pid, 'SIGTERM')
}
if (process.env.FAKE_CODEX_WAIT_FOR_SIGNAL === '1') {
  logRun()
  fs.writeFileSync(process.env.FAKE_CODEX_READY_FILE, 'ready')
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
if (process.env.FAKE_CODEX_EXIT_WITHOUT_RESPONSE === '1') {
  logRun()
  process.exit(9)
}
const status = process.env.FAKE_CODEX_FAILED_RESPONSE === '1' ? 'failed' : 'completed'
const lastMsgIndex = args.indexOf('--output-last-message')
if (lastMsgIndex !== -1 && process.env.FAKE_CODEX_NO_LAST_MSG !== '1') {
  fs.writeFileSync(args[lastMsgIndex + 1], JSON.stringify({status, report_markdown: '# Summary\\nok'}))
}
logRun()
if (process.env.FAKE_CODEX_SESSION_EFFORT && process.env.CODEX_HOME && !args.includes('--ephemeral')) {
  const sessionDir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '07', '18')
  fs.mkdirSync(sessionDir, {recursive: true})
  fs.writeFileSync(path.join(sessionDir, 'rollout.jsonl'), JSON.stringify({type: 'turn_context', payload: {effort: process.env.FAKE_CODEX_SESSION_EFFORT}}) + '\\n')
}
if (process.env.FAKE_CODEX_BREAK_AUTH_CLEANUP === '1' && process.env.CODEX_HOME) {
  const authFile = path.join(process.env.CODEX_HOME, 'auth.json')
  fs.rmSync(authFile, {force: true})
  fs.mkdirSync(authFile)
}
if (process.env.FAKE_CODEX_SIGNAL_WRAPPER_AFTER_RESULT === '1') {
  process.kill(process.ppid, 'SIGTERM')
}
if (process.env.FAKE_CODEX_NO_THREAD !== '1') {
  console.log(JSON.stringify({type: 'thread.started', thread_id: 'thread-1'}))
}
console.log(JSON.stringify({type: 'turn.completed', usage: {input_tokens: 1, output_tokens: 1}}))
`

const devinFakeScript = (): string => `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
const promptFileIndex = args.indexOf('--prompt-file')
let prompt = args[args.indexOf('-p') + 1] || ''
if (promptFileIndex !== -1) {
  try { prompt = fs.readFileSync(args[promptFileIndex + 1], 'utf8') } catch {}
}
if (process.env.FAKE_DEVIN_EXIT_WITHOUT_RESPONSE === '1') {
  fs.writeFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({args, prompt, command: 'devin', cwd: process.cwd(), env: {TMPDIR: process.env.TMPDIR}}))
  process.exit(9)
}
const reportMatches = [...prompt.matchAll(/"([^"]+report\\.md)"/g)].map((match) => match[1])
const reportFile = reportMatches[reportMatches.length - 1]
const status = process.env.FAKE_DEVIN_FAILED_RESPONSE === '1' ? 'failed' : 'completed'
if (reportFile && process.env.FAKE_DEVIN_NO_REPORT !== '1') {
  if (process.env.FAKE_DEVIN_EMPTY_REPORT === '1') {
    fs.writeFileSync(reportFile, '---\\nstatus: ' + status + '\\n---\\n   \\n')
  } else {
    fs.writeFileSync(reportFile, '---\\nstatus: ' + status + '\\n---\\n# Summary\\nok\\n')
  }
}
const exportIndex = args.indexOf('--export')
if (exportIndex !== -1 && process.env.FAKE_DEVIN_NO_SESSION !== '1') {
  fs.writeFileSync(args[exportIndex + 1], JSON.stringify({session_id: 'devin-session-1', final_metrics: {prompt_tokens: 1, completion_tokens: 1}}))
}
fs.writeFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({args, prompt, command: 'devin', cwd: process.cwd(), env: {TMPDIR: process.env.TMPDIR}}))
`

const cursorFakeScript = (): string => `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
let prompt = ''
try { prompt = fs.readFileSync(0, 'utf8') } catch {}
const entry = {args, prompt, command: 'agent', cwd: process.cwd(), env: {CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR, TMPDIR: process.env.TMPDIR}}
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
const reportMatches = [...prompt.matchAll(/"([^"]+report\\.md)"/g)].map((match) => match[1])
const reportFile = reportMatches[reportMatches.length - 1]
const status = process.env.FAKE_CURSOR_FAILED_RESPONSE === '1' ? 'failed' : 'completed'
if (reportFile) {
  fs.writeFileSync(reportFile, '---\\nstatus: ' + status + '\\n---\\n# Summary\\nok\\n')
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
  writeFileSync(
    path.join(paths.homeDir, '.codex', 'auth.json'),
    JSON.stringify({ access_token: codexAuthSecret })
  )
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

// request が prompt へ埋め込まれる既定経路では read-request.sh の許可も不要
const claudeMinimalAllowedTools = (): string => 'Read'

// claude は `-p <prompt>`、cursor は `-p` が単独フラグでプロンプトが最終引数
const promptFromLog = (log: FakeCliLog): string => {
  if (log.prompt !== null && log.prompt !== '') {
    return log.prompt
  }
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

// follow-up 検証は TS 実装 (validateFollowup) を delegate-cli の internal subcommand
// 経由で叩く。bash 版 delegate_observe_validate_followup と同じ argv / exit 契約。
const followupBundle = path.join(repoRoot, 'shared', 'dist', 'delegate-cli.mjs')

const runFollowupValidation = (
  fixture: Fixture,
  backend: Backend,
  model: string
): { output: string; status: number } => {
  try {
    const output = execFileSync(
      'node',
      [
        followupBundle,
        'validate-followup',
        fixture.observeFile,
        backend,
        model,
        repoRoot,
        repoRoot,
      ],
      { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }
    )
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

const prepareCodexSessionHome = (workDir: string, model = 'gpt-5.5'): string => {
  const previousRun = path.join(workDir, 'delegate_implement_20260721_120000_abcde')
  const sessionHome = path.join(previousRun, 'codex-home')
  mkdirSync(path.join(sessionHome, 'sessions'), { recursive: true })
  writeFileSync(path.join(sessionHome, 'config.toml'), '# session config\n')
  writeFileSync(path.join(sessionHome, 'sessions', 'rollout.jsonl'), '{}\n')
  writeFileSync(
    `${previousRun}_observe.json`,
    JSON.stringify({
      backend_session: {
        backend: 'codex',
        home_dir: sessionHome,
        model,
        persistence: 'resumable',
        resume_id: 'thread-1',
      },
    })
  )
  return sessionHome
}

type CodexTestMode = 'normal' | 'resumable' | 'followup'

const codexTestModeArgs = (fixture: Fixture, mode: CodexTestMode): string[] => {
  if (mode === 'normal') {
    return []
  }
  if (mode === 'resumable') {
    return ['resumable', '', '']
  }
  return ['followup', 'thread-1', prepareCodexSessionHome(fixture.workDir)]
}

const codexTerminationCases = [
  { failure: 'child error', envName: 'FAKE_CODEX_EXIT_WITHOUT_RESPONSE', expectedStatus: 9 },
  { failure: 'missing response', envName: 'FAKE_CODEX_NO_LAST_MSG', expectedStatus: 1 },
  { failure: 'child signal', envName: 'FAKE_CODEX_SIGNAL_SELF', expectedStatus: 143 },
] as const

const codexAuthCleanupMatrix = (['normal', 'resumable', 'followup'] as const).flatMap((mode) =>
  codexTerminationCases.map((termination) => ({
    envName: termination.envName,
    expectedStatus: termination.expectedStatus,
    failure: termination.failure,
    mode,
  }))
)

const waitForFile = async (filePath: string, attempts = 100): Promise<void> => {
  if (existsSync(filePath)) {
    return Promise.resolve()
  }
  if (attempts <= 0) {
    return Promise.reject(new Error('timed out waiting for fake Codex'))
  }
  return new Promise((resolve) => {
    setTimeout(resolve, 20)
  }).then(async () => waitForFile(filePath, attempts - 1))
}

const terminateRunningCodexWrapper = async (fixture: Fixture): Promise<number> => {
  const readyFile = path.join(fixture.workDir, 'codex-ready')
  const child = spawn(
    'bash',
    [path.join(repoRoot, 'shared', 'delegate-codex.sh'), ...codexArgs(fixture)],
    {
      cwd: repoRoot,
      env: {
        ...fixture.env,
        FAKE_CODEX_READY_FILE: readyFile,
        FAKE_CODEX_WAIT_FOR_SIGNAL: '1',
      },
      stdio: 'ignore',
    }
  )
  const exited = new Promise<number>((resolve) => {
    child.once('exit', (code) => resolve(code ?? 1))
  })
  await waitForFile(readyFile)
  child.kill('SIGTERM')
  return exited
}

interface ProcessExit {
  code: number | null
  signal: NodeJS.Signals | null
}

const runCodexProcess = async (
  fixture: Fixture,
  env: NodeJS.ProcessEnv = fixture.env
): Promise<ProcessExit> => {
  const child = spawn(
    'bash',
    [path.join(repoRoot, 'shared', 'delegate-codex.sh'), ...codexArgs(fixture)],
    {
      cwd: repoRoot,
      env,
      stdio: 'ignore',
    }
  )
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

const writeNodePreload = (fixture: Fixture, name: string, source: string): string => {
  const preload = path.join(fixture.workDir, `${name}.cjs`)
  writeFileSync(preload, source)
  return preload
}

const preloadEnv = (fixture: Fixture, preload: string): NodeJS.ProcessEnv => ({
  ...fixture.env,
  NODE_OPTIONS: `${fixture.env.NODE_OPTIONS ?? ''} --require=${preload}`.trim(),
})

const expectNoCodexAuthArtifacts = (fixture: Fixture): void => {
  const codexHome = path.join(fixture.runDir, 'codex-home')
  expect(existsSync(path.join(codexHome, 'auth.json'))).toBe(false)
  expect(readdirSync(codexHome).filter((name) => name.startsWith('.auth.json.stage-'))).toEqual([])
}

interface ExpectedSynchronousAuthOperationFailure {
  fixture: Fixture
  metricsFile: string
  observe: ObserveJson
  eventKinds: readonly string[]
  metricKinds: readonly string[]
  expectUnavailableSession?: boolean
}

const expectSynchronousAuthOperationFailure = ({
  fixture,
  metricsFile,
  observe,
  eventKinds,
  metricKinds,
  expectUnavailableSession = false,
}: ExpectedSynchronousAuthOperationFailure): void => {
  expect(readResponseStatus(fixture.responseFile)).toBe('failed')
  expect(existsSync(fixture.logFile)).toBe(false)
  expect(existsSync(path.join(fixture.runDir, 'codex-home', 'auth.json'))).toBe(false)
  for (const kind of eventKinds) {
    expect(countEventKind(observe, kind)).toBe(1)
  }
  for (const kind of metricKinds) {
    expect(countMetricKind(metricsFile, kind)).toBe(1)
  }
  if (expectUnavailableSession) {
    expect(requireBackendSession(observe).persistence).toBe('unavailable')
  }
}

const mcpServers: Record<string, unknown> = {
  alpha: { args: ['--fast'], command: 'alpha-server', env: { TOKEN: 'secret' } },
  beta: { url: 'https://example.test/mcp' },
}

const codexMcpListFixture = JSON.stringify([
  {
    enabled: true,
    name: 'alpha',
    transport: {
      args: ['--fast'],
      command: 'alpha-server',
      env: { TOKEN: 'secret' },
      type: 'stdio',
    },
  },
  {
    enabled: true,
    name: 'beta',
    transport: { url: 'https://example.test/mcp' },
  },
])

const writeClaudeUserMcp = (fixture: Fixture, servers = mcpServers): void => {
  writeFileSync(
    path.join(fixture.workDir, 'home', '.claude.json'),
    JSON.stringify({ mcpServers: servers })
  )
}

const writeCursorGlobalMcp = (fixture: Fixture, servers = mcpServers): void => {
  writeFileSync(
    path.join(fixture.workDir, 'home', '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: servers })
  )
}

const requireMcpConfig = (observe: ObserveJson): McpConfig => {
  if (!observe.mcp_config) {
    throw new Error('missing mcp_config')
  }
  return observe.mcp_config
}

const expectNoMcpPayloadInObserve = (observeFile: string): void => {
  const content = readFileSync(observeFile, 'utf8')
  expect(content).not.toContain('alpha-server')
  expect(content).not.toContain('secret')
  expect(content).not.toContain('https://example.test/mcp')
}

const expectNoCodexAuthPayloadInDiagnostics = (fixture: Fixture, configToml: string): void => {
  expect(configToml).not.toContain(codexAuthSecret)
  expect(readFileSync(fixture.observeFile, 'utf8')).not.toContain(codexAuthSecret)
  expect(readFileSync(path.join(fixture.runDir, 'worker-stderr.capture'), 'utf8')).not.toContain(
    codexAuthSecret
  )
}

const expectClaudeMcpConfigArg = (fixture: Fixture, log: FakeCliLog): string => {
  const mcpConfigFile = path.join(fixture.runDir, 'claude-config', 'mcp-config.json')
  expect(log.args).toContain('--mcp-config')
  expect(log.args).toContain(mcpConfigFile)
  return mcpConfigFile
}

const expectInjectedMcpObserve = (observe: ObserveJson): void => {
  expect(requireMcpConfig(observe)).toEqual({ servers: ['alpha', 'beta'], source: 'injected' })
}

const expectCodexMcpToml = (configToml: string): void => {
  expect(configToml).toContain('[mcp_servers."alpha"]')
  expect(configToml).toContain('command = "alpha-server"')
  expect(configToml).toContain('[mcp_servers."alpha".env]')
  expect(configToml).toContain('[mcp_servers."beta"]')
  expect(configToml).not.toContain('model')
}

const prepareClaudeFollowupMcpConfig = (
  fixture: Fixture
): { mcpConfigFile: string; sessionHome: string } => {
  writeClaudeUserMcp(fixture, { changed: { command: 'changed-server' } })
  const sessionHome = prepareClaudeSessionHome(fixture.workDir)
  const mcpConfigFile = path.join(sessionHome, 'mcp-config.json')
  writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers }))
  return { mcpConfigFile, sessionHome }
}

const expectFailedWithoutChild = (fixture: Fixture, result: { status: number }): void => {
  expect(result.status).toBe(5)
  expect(readResponseStatus(fixture.responseFile)).toBe('failed')
  expect(existsSync(fixture.logFile)).toBe(false)
}

describe('wrapper MCP config injection', () => {
  it('keeps Claude normal runs on shared MCP config without generated files', () => {
    const fixture = makeFixture('claude')
    writeClaudeUserMcp(fixture)
    const result = runClaude(fixture)
    const log = readLog(fixture.logFile)

    expect(result.status).toBe(0)
    expect(log.args).not.toContain('--mcp-config')
    expect(existsSync(path.join(fixture.runDir, 'claude-config', 'mcp-config.json'))).toBe(false)
    expect(requireMcpConfig(readObserve(fixture.observeFile)).source).toBe('shared')
  })

  it('injects parent MCP config for Claude resumable runs', () => {
    const fixture = makeFixture('claude')
    writeClaudeUserMcp(fixture)
    const result = runClaude(fixture, ['resumable', '', ''])
    const mcpConfigFile = expectClaudeMcpConfigArg(fixture, readLog(fixture.logFile))
    const observe = readObserve(fixture.observeFile)

    expect(result.status).toBe(0)
    expect(readUnknownJson(mcpConfigFile)).toEqual({ mcpServers })
    expectInjectedMcpObserve(observe)
    expectNoMcpPayloadInObserve(fixture.observeFile)
  })

  it('does not inject Claude resumable MCP config when parent MCP is absent', () => {
    const fixture = makeFixture('claude')
    const result = runClaude(fixture, ['resumable', '', ''])
    const log = readLog(fixture.logFile)

    expect(result.status).toBe(0)
    expect(log.args).not.toContain('--mcp-config')
    expect(existsSync(path.join(fixture.runDir, 'claude-config', 'mcp-config.json'))).toBe(false)
    expect(requireMcpConfig(readObserve(fixture.observeFile)).source).toBe('none')
  })

  it('reuses the existing Claude follow-up MCP config without regenerating it', () => {
    const fixture = makeFixture('claude')
    const { mcpConfigFile, sessionHome } = prepareClaudeFollowupMcpConfig(fixture)

    const result = runClaude(fixture, ['followup', 'sid-1', sessionHome])
    const log = readLog(fixture.logFile)

    expect(result.status).toBe(0)
    expect(log.args).toContain(mcpConfigFile)
    expect(readUnknownJson(mcpConfigFile)).toEqual({ mcpServers })
    expectInjectedMcpObserve(readObserve(fixture.observeFile))
  })

  it('generates isolated Codex MCP config from the parent list output', () => {
    const fixture = makeFixture('codex')
    const result = runCodex(fixture, [], {
      ...fixture.env,
      FAKE_CODEX_MCP_LIST_JSON: codexMcpListFixture,
    })
    const configToml = readFileSync(path.join(fixture.runDir, 'codex-home', 'config.toml'), 'utf8')

    expect(result.status).toBe(0)
    expectCodexMcpToml(configToml)
    expectInjectedMcpObserve(readObserve(fixture.observeFile))
    expectNoMcpPayloadInObserve(fixture.observeFile)
    expectNoCodexAuthPayloadInDiagnostics(fixture, configToml)
  })

  it('does not generate Codex MCP config when parent MCP is absent', () => {
    const fixture = makeFixture('codex')
    const result = runCodex(fixture)

    expect(result.status).toBe(0)
    expect(existsSync(path.join(fixture.runDir, 'codex-home', 'config.toml'))).toBe(false)
    expect(requireMcpConfig(readObserve(fixture.observeFile)).source).toBe('none')
  })

  it('records injected MCP for Codex follow-up when the session config exists', () => {
    const fixture = makeFixture('codex')
    const sessionHome = prepareCodexSessionHome(fixture.workDir)
    writeFileSync(
      path.join(sessionHome, 'config.toml'),
      [
        '[mcp_servers."alpha"]',
        'command = "alpha"',
        '',
        '[mcp_servers."alpha".env]',
        'TOKEN = "secret"',
        '',
        '[mcp_servers."beta"]',
        'url = "https://example.test/mcp"',
      ].join('\n')
    )
    const result = runCodex(fixture, ['followup', 'thread-1', sessionHome])

    expect(result.status).toBe(0)
    expectInjectedMcpObserve(readObserve(fixture.observeFile))
  })

  it('generates Cursor MCP config and approves MCPs when parent MCP exists', () => {
    const fixture = makeFixture('cursor')
    writeCursorGlobalMcp(fixture)
    const result = runCursor(fixture)
    const log = readLog(fixture.logFile)
    const mcpConfigFile = path.join(fixture.runDir, 'cursor-config', 'mcp.json')

    expect(result.status).toBe(0)
    expect(log.args).toContain('--approve-mcps')
    expect(readUnknownJson(mcpConfigFile)).toEqual({ mcpServers })
    expectInjectedMcpObserve(readObserve(fixture.observeFile))
  })
})

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
    expect(requireMcpConfig(readObserve(fixture.observeFile)).source).toBe('shared')
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
  it('adds minimal allowed tools and keeps the repo-write denylist for claude explore', () => {
    const fixture = makeFixture('claude')
    const result = runClaudeTaskType(fixture, 'explore')
    const log = readLog(fixture.logFile)
    const allowIndex = log.args.indexOf('--allowedTools')
    const denyIndex = log.args.indexOf('--disallowedTools')

    expect(result.status).toBe(0)
    expect(allowIndex).toBeGreaterThan(-1)
    expect(log.args[allowIndex + 1]).toBe(claudeMinimalAllowedTools())
    expect(denyIndex).toBeGreaterThan(-1)
    expect(log.args[denyIndex + 1]).toBe('Edit,MultiEdit,Write,NotebookEdit')
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

  it('adds minimal edit/write allowed tools for default claude task types', () => {
    const fixture = makeFixture('claude')
    const result = runClaudeTaskType(fixture, 'htmldoc')
    const log = readLog(fixture.logFile)
    const allowIndex = log.args.indexOf('--allowedTools')

    expect(result.status).toBe(0)
    expect(allowIndex).toBeGreaterThan(-1)
    expect(log.args[allowIndex + 1]).toBe(`${claudeMinimalAllowedTools()},Edit,Write`)
    expect(log.args).not.toContain('--disallowedTools')
  })

  it('instructs a structured final answer and passes the report schema to claude', () => {
    const fixture = makeFixture('claude')
    const result = runClaudeTaskType(fixture, 'htmldoc')
    const log = readLog(fixture.logFile)
    const prompt = promptFromLog(log)
    const schemaIndex = log.args.indexOf('--json-schema')

    expect(result.status).toBe(0)
    expect(prompt).toContain('構造化出力 {status, report_markdown}')
    expect(prompt).not.toContain('build-response.sh <status>')
    expect(schemaIndex).toBeGreaterThan(-1)
    expect(JSON.parse(log.args[schemaIndex + 1])).toMatchObject({
      required: ['status', 'report_markdown'],
    })
  })

  it('always injects web/MCP exploration and MCP read-only constraints into the claude explore prompt', () => {
    const fixture = makeFixture('claude')
    const result = runClaudeTaskType(fixture, 'explore')
    const prompt = promptFromLog(readLog(fixture.logFile))

    expect(result.status).toBe(0)
    expect(prompt).toContain('WebSearch / WebFetch')
    expect(prompt).toContain('read-only 制約')
    expect(prompt).toContain('MCP 制約')
  })

  it('shares the explore constraints with the cursor prompt', () => {
    const fixture = makeFixture('cursor')
    const result = runCursorTaskType(fixture, 'explore')
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
    expect(log.args).not.toContain('--ignore-user-config')
    expect(log.args).not.toContain('resume')
    expect(log.authPresent).toBe(true)
  })
})

describe('delegate-codex.sh auth cleanup', () => {
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

  it('keeps caches but removes auth when DELEGATE_CODEX_HOME_PRUNE is 0', () => {
    const fixture = makeFixture('codex')
    const codexHome = seedCodexHomeLeftovers(fixture)
    const result = runCodex(fixture, [], {
      ...fixture.env,
      DELEGATE_CODEX_HOME_PRUNE: '0',
    })

    expect(result.status).toBe(0)
    expect(existsSync(path.join(codexHome, '.tmp'))).toBe(true)
    expect(existsSync(path.join(codexHome, 'auth.json'))).toBe(false)
    expect(existsSync(path.join(codexHome, 'sessions', 'rollout.jsonl'))).toBe(true)
    expect(existsSync(path.join(codexHome, 'config.toml'))).toBe(true)
  })

  it('keeps failed-run diagnostics but removes auth after a child error', () => {
    const fixture = makeFixture('codex')
    const codexHome = seedCodexHomeLeftovers(fixture)
    const result = runCodex(fixture, [], {
      ...fixture.env,
      FAKE_CODEX_EXIT_WITHOUT_RESPONSE: '1',
    })

    expect(result.status).toBe(9)
    expect(existsSync(path.join(codexHome, '.tmp'))).toBe(true)
    expect(existsSync(path.join(codexHome, 'auth.json'))).toBe(false)
  })

  it('removes auth when the child exits without a structured response', () => {
    const fixture = makeFixture('codex')
    const codexHome = seedCodexHomeLeftovers(fixture)
    const result = runCodex(fixture, [], {
      ...fixture.env,
      FAKE_CODEX_NO_LAST_MSG: '1',
    })

    expect(result.status).toBe(1)
    expect(readResponseStatus(fixture.responseFile)).toBe('failed')
    expect(existsSync(path.join(codexHome, 'auth.json'))).toBe(false)
  })

  it('removes auth after child signal termination', () => {
    const fixture = makeFixture('codex')
    const codexHome = seedCodexHomeLeftovers(fixture)
    const result = runCodex(fixture, [], {
      ...fixture.env,
      FAKE_CODEX_SIGNAL_SELF: '1',
    })

    expect(result.status).toBe(143)
    expect(readLog(fixture.logFile).authPresent).toBe(true)
    expect(existsSync(path.join(codexHome, 'auth.json'))).toBe(false)
  })
})

describe('delegate-codex.sh auth lifecycle failures', () => {
  it('fails before launch instead of overwriting a stale destination auth file', () => {
    const fixture = makeFixture('codex')
    const codexHome = path.join(fixture.runDir, 'codex-home')
    const staleAuth = path.join(codexHome, 'auth.json')
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(staleAuth, 'stale-auth')

    const result = runCodex(fixture)

    expect(result.status).toBe(1)
    expect(readResponseStatus(fixture.responseFile)).toBe('failed')
    expect(existsSync(fixture.logFile)).toBe(false)
    expect(readFileSync(staleAuth, 'utf8')).toBe('stale-auth')
  })

  it('fails before launch when the auth copy syscall rejects the source', () => {
    const fixture = makeFixture('codex')
    const sourceAuth = path.join(fixture.workDir, 'home', '.codex', 'auth.json')
    rmSync(sourceAuth)
    mkdirSync(sourceAuth)

    const result = runCodex(fixture)

    expect(result.status).toBe(1)
    expect(readResponseStatus(fixture.responseFile)).toBe('failed')
    expect(existsSync(fixture.logFile)).toBe(false)
  })

  it('removes a partial staging file when the auth copy syscall creates then fails', () => {
    const fixture = makeFixture('codex')
    const preload = writeNodePreload(
      fixture,
      'partial-auth-copy-failure',
      `const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const copyFileSync = fs.copyFileSync
fs.copyFileSync = (source, destination, flags) => {
  if (String(destination).includes('.auth.json.stage-')) {
    fs.writeFileSync(destination, 'partial-credential')
    throw new Error('forced partial auth copy failure')
  }
  return copyFileSync(source, destination, flags)
}
syncBuiltinESMExports()
`
    )

    const result = runCodex(fixture, [], preloadEnv(fixture, preload))
    expect(result.status).toBe(1)
    expect(readResponseStatus(fixture.responseFile)).toBe('failed')
    expect(existsSync(fixture.logFile)).toBe(false)
    expectNoCodexAuthArtifacts(fixture)
  })
})

describe('delegate-codex.sh auth signal windows', () => {
  it('cleans owned auth artifacts when SIGTERM arrives during staging', async () => {
    const fixture = makeFixture('codex')
    const marker = path.join(fixture.workDir, 'signal-during-stage')
    const preload = writeNodePreload(
      fixture,
      'signal-during-auth-stage',
      `const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const copyFileSync = fs.copyFileSync
fs.copyFileSync = (source, destination, flags) => {
  const result = copyFileSync(source, destination, flags)
  if (String(destination).includes('.auth.json.stage-')) {
    fs.writeFileSync(${JSON.stringify(marker)}, 'signaled')
    process.kill(process.pid, 'SIGTERM')
  }
  return result
}
syncBuiltinESMExports()
`
    )

    const exit = await runCodexProcess(fixture, preloadEnv(fixture, preload))

    expect(existsSync(marker)).toBe(true)
    expect(exit).toEqual({ code: null, signal: 'SIGTERM' })
    expectNoCodexAuthArtifacts(fixture)
  })

  it('cleans auth when SIGTERM arrives at the child spawn boundary', async () => {
    const fixture = makeFixture('codex')
    const preload = writeNodePreload(
      fixture,
      'signal-at-spawn',
      `const childProcess = require('node:child_process')
const { syncBuiltinESMExports } = require('node:module')
const spawn = childProcess.spawn
childProcess.spawn = function (command, ...args) {
  const child = spawn.call(this, command, ...args)
  if (command === 'codex') process.kill(process.pid, 'SIGTERM')
  return child
}
syncBuiltinESMExports()
`
    )

    const exit = await runCodexProcess(fixture, preloadEnv(fixture, preload))

    expect(exit).toEqual({ code: 143, signal: null })
    expect(existsSync(path.join(fixture.runDir, 'codex-home', 'auth.json'))).toBe(false)
  })

  it('cleans auth when SIGTERM races with child exit', async () => {
    const fixture = makeFixture('codex')

    const exit = await runCodexProcess(fixture, {
      ...fixture.env,
      FAKE_CODEX_SIGNAL_WRAPPER_AFTER_RESULT: '1',
    })

    expect(exit).toEqual({ code: 143, signal: null })
    expect(existsSync(path.join(fixture.runDir, 'codex-home', 'auth.json'))).toBe(false)
  })

  it('finishes auth cleanup when SIGTERM arrives during unlink', async () => {
    const fixture = makeFixture('codex')
    const marker = path.join(fixture.workDir, 'signal-during-cleanup')
    const preload = writeNodePreload(
      fixture,
      'signal-during-auth-cleanup',
      `const fs = require('node:fs')
const path = require('node:path')
const { syncBuiltinESMExports } = require('node:module')
const unlinkSync = fs.unlinkSync
fs.unlinkSync = (target) => {
  if (path.basename(String(target)) === 'auth.json' && !fs.existsSync(${JSON.stringify(marker)})) {
    fs.writeFileSync(${JSON.stringify(marker)}, 'signaled')
    process.emit('SIGTERM')
  }
  return unlinkSync(target)
}
syncBuiltinESMExports()
`
    )

    const exit = await runCodexProcess(fixture, preloadEnv(fixture, preload))

    expect(existsSync(marker)).toBe(true)
    expect(exit).toEqual({ code: null, signal: 'SIGTERM' })
    expectNoCodexAuthArtifacts(fixture)
  })
})

describe('delegate-codex.sh auth lifecycle finalization', () => {
  it('finalizes a synchronous Codex operation exception exactly once', () => {
    const fixture = makeFixture('codex')
    const metricsFile = path.join(fixture.workDir, 'metrics.jsonl')
    mkdirSync(path.join(fixture.runDir, 'worker-prompt.txt'))

    const result = runCodex(fixture, ['resumable', '', ''], {
      ...fixture.env,
      DELEGATE_METRICS_FILE: metricsFile,
    })
    const observe = readObserve(fixture.observeFile)

    expect(result.status).toBe(1)
    expectSynchronousAuthOperationFailure({
      fixture,
      metricsFile,
      observe,
      eventKinds: ['resume_unavailable', 'failed_response_written'],
      metricKinds: ['build_response'],
      expectUnavailableSession: true,
    })
  })

  it('turns an auth unlink failure into a sanitized failed response', () => {
    const fixture = makeFixture('codex')
    const result = runCodex(fixture, [], {
      ...fixture.env,
      FAKE_CODEX_BREAK_AUTH_CLEANUP: '1',
    })
    const diagnostic = readFileSync(path.join(fixture.runDir, 'worker-stderr.capture'), 'utf8')

    expect(result.status).toBe(1)
    expect(readResponseStatus(fixture.responseFile)).toBe('failed')
    expect(diagnostic).toBe('ERROR: Codex credential cleanup failed safely.\n')
    expect(diagnostic).not.toContain(codexAuthSecret)
  })

  it('finalizes a resumable auth unlink failure exactly once without resumable metadata', () => {
    const fixture = makeFixture('codex')
    const metricsFile = path.join(fixture.workDir, 'metrics.jsonl')
    const result = runCodex(fixture, ['resumable', '', ''], {
      ...fixture.env,
      DELEGATE_METRICS_FILE: metricsFile,
      FAKE_CODEX_BREAK_AUTH_CLEANUP: '1',
    })
    const observe = readObserve(fixture.observeFile)

    expect(result.status).toBe(1)
    expect(readResponseStatus(fixture.responseFile)).toBe('failed')
    expect(requireBackendSession(observe).persistence).toBe('unavailable')
    expect(countEventKind(observe, 'resume_unavailable')).toBe(1)
    expect(countEventKind(observe, 'failed_response_written')).toBe(1)
    expect(countMetricKind(metricsFile, 'build_response')).toBe(1)
  })

  it('removes the auth copy when the wrapper itself receives SIGTERM', async () => {
    const fixture = makeFixture('codex')

    const status = await terminateRunningCodexWrapper(fixture)
    const log = readLog(fixture.logFile)

    expect(status).toBe(143)
    expect(log.authPresent).toBe(true)
    expect(existsSync(path.join(fixture.runDir, 'codex-home', 'auth.json'))).toBe(false)
  })
})

describe('delegate-codex.sh auth cleanup matrix', () => {
  it.each(codexAuthCleanupMatrix)(
    'cleans auth for $mode after $failure',
    ({ envName, expectedStatus, mode }) => {
      const fixture = makeFixture('codex')
      const modeArgs = codexTestModeArgs(fixture, mode)
      const result = runCodex(fixture, modeArgs, { ...fixture.env, [envName]: '1' })
      const log = readLog(fixture.logFile)
      const codexHome = log.env.CODEX_HOME ?? ''

      expect(result.status).toBe(expectedStatus)
      expect(log.authPresent).toBe(true)
      expect(existsSync(path.join(codexHome, 'auth.json'))).toBe(false)
    }
  )
})

describe('delegate-codex.sh resumable session modes', () => {
  it('starts resumable runs without --ephemeral and records thread.started', () => {
    const fixture = makeFixture('codex')
    const result = runCodex(fixture, ['resumable', '', ''])
    const log = readLog(fixture.logFile)
    const observe = readObserve(fixture.observeFile)

    expectCodexResumable({ fixture, log, observe, result })
    expect(log.authPresent).toBe(true)
    expect(existsSync(path.join(fixture.runDir, 'codex-home', 'auth.json'))).toBe(false)
  })

  it('resumes follow-up runs from the lineage home', () => {
    const fixture = makeFixture('codex')
    const sessionHome = prepareCodexSessionHome(fixture.workDir)
    const result = runCodex(fixture, ['followup', 'thread-1', sessionHome])
    const log = readLog(fixture.logFile)
    const observe = readObserve(fixture.observeFile)

    expectCodexFollowup({ log, observe, result, sessionHome })
    expect(log.authPresent).toBe(true)
    expect(existsSync(path.join(sessionHome, 'auth.json'))).toBe(false)
    expect(existsSync(path.join(sessionHome, 'sessions', 'rollout.jsonl'))).toBe(true)
    expect(existsSync(path.join(sessionHome, 'config.toml'))).toBe(true)
  })

  it('rejects the real requester CODEX_HOME before launching a follow-up', () => {
    const fixture = makeFixture('codex')
    const realCodexHome = path.join(fixture.workDir, 'home', '.codex')
    const rootAuth = path.join(realCodexHome, 'auth.json')
    const result = runCodex(fixture, ['followup', 'thread-1', realCodexHome])

    expectFailedWithoutChild(fixture, result)
    expect(existsSync(rootAuth)).toBe(true)
  })

  it('rejects a follow-up home symlink to the real CODEX_HOME before launching', () => {
    const fixture = makeFixture('codex')
    const realCodexHome = path.join(fixture.workDir, 'home', '.codex')
    const linkedHome = path.join(fixture.workDir, 'linked-codex-home')
    const rootAuth = path.join(realCodexHome, 'auth.json')
    symlinkSync(realCodexHome, linkedHome, 'dir')

    const result = runCodex(fixture, ['followup', 'thread-1', linkedHome])

    expectFailedWithoutChild(fixture, result)
    expect(existsSync(rootAuth)).toBe(true)
  })

  it('rejects an unrelated external follow-up home before mutation or launch', () => {
    const fixture = makeFixture('codex')
    const unrelatedHome = path.join(fixture.workDir, 'unrelated', 'codex-home')
    mkdirSync(unrelatedHome, { recursive: true })
    writeFileSync(path.join(unrelatedHome, 'sentinel'), 'keep')

    const result = runCodex(fixture, ['followup', 'thread-1', unrelatedHome])

    expectFailedWithoutChild(fixture, result)
    expect(readFileSync(path.join(unrelatedHome, 'sentinel'), 'utf8')).toBe('keep')
    expect(existsSync(path.join(unrelatedHome, 'auth.json'))).toBe(false)
  })

  it('rejects a follow-up home whose previous observe session metadata does not match', () => {
    const fixture = makeFixture('codex')
    const sessionHome = prepareCodexSessionHome(fixture.workDir)
    const configFile = path.join(sessionHome, 'config.toml')
    writeFileSync(
      `${path.dirname(sessionHome)}_observe.json`,
      JSON.stringify({
        backend_session: {
          backend: 'codex',
          home_dir: sessionHome,
          model: 'gpt-mismatch',
          persistence: 'resumable',
          resume_id: 'thread-1',
        },
      })
    )

    const result = runCodex(fixture, ['followup', 'thread-1', sessionHome])

    expectFailedWithoutChild(fixture, result)
    expect(readFileSync(configFile, 'utf8')).toBe('# session config\n')
    expect(existsSync(path.join(sessionHome, 'auth.json'))).toBe(false)
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

  it('keeps caches but removes auth when the protocol response status is failed', () => {
    const fixture = makeFixture('codex')
    const codexHome = seedCodexHomeLeftovers(fixture)
    const result = runImagegen(fixture, {
      ...fixture.env,
      FAKE_CODEX_FAILED_RESPONSE: '1',
    })

    expect(result.status).toBe(0)
    expect(readResponseStatus(fixture.responseFile)).toBe('failed')
    expect(existsSync(path.join(codexHome, '.tmp'))).toBe(true)
    expect(existsSync(path.join(codexHome, 'auth.json'))).toBe(false)
  })

  it.each(codexTerminationCases)(
    'removes auth after imagegen $failure',
    ({ envName, expectedStatus }) => {
      const fixture = makeFixture('codex')
      const result = runImagegen(fixture, { ...fixture.env, [envName]: '1' })

      expect(result.status).toBe(expectedStatus)
      expect(readLog(fixture.logFile).authPresent).toBe(true)
      expect(existsSync(path.join(fixture.runDir, 'codex-home', 'auth.json'))).toBe(false)
    }
  )

  it('fails before imagegen launch when a stale auth destination exists', () => {
    const fixture = makeFixture('codex')
    const codexHome = path.join(fixture.runDir, 'codex-home')
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(path.join(codexHome, 'auth.json'), 'stale-auth')

    const result = runImagegen(fixture)

    expect(result.status).toBe(1)
    expect(readResponseStatus(fixture.responseFile)).toBe('failed')
    expect(existsSync(fixture.logFile)).toBe(false)
  })

  it('finalizes an imagegen auth unlink failure once with exit 1', () => {
    const fixture = makeFixture('codex')
    const metricsFile = path.join(fixture.workDir, 'metrics.jsonl')
    const result = runImagegen(fixture, {
      ...fixture.env,
      DELEGATE_METRICS_FILE: metricsFile,
      FAKE_CODEX_BREAK_AUTH_CLEANUP: '1',
    })
    const observe = readObserve(fixture.observeFile)

    expect(result.status).toBe(1)
    expect(readResponseStatus(fixture.responseFile)).toBe('failed')
    expect(countEventKind(observe, 'dispatch_end')).toBe(1)
    expect(countEventKind(observe, 'failed_response_written')).toBe(1)
    expect(countMetricKind(metricsFile, 'dispatch')).toBe(1)
    expect(countMetricKind(metricsFile, 'build_response')).toBe(1)
  })

  it('finalizes a synchronous imagegen operation exception exactly once', () => {
    const fixture = makeFixture('codex')
    const metricsFile = path.join(fixture.workDir, 'metrics.jsonl')
    mkdirSync(path.join(fixture.runDir, 'report-schema.json'))

    const result = runImagegen(fixture, {
      ...fixture.env,
      DELEGATE_METRICS_FILE: metricsFile,
    })
    const observe = readObserve(fixture.observeFile)

    expect(result.status).toBe(1)
    expectSynchronousAuthOperationFailure({
      fixture,
      metricsFile,
      observe,
      eventKinds: ['dispatch_end', 'failed_response_written'],
      metricKinds: ['dispatch', 'build_response'],
    })
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
    expect(requireMcpConfig(readObserve(fixture.observeFile)).source).toBe('shared')
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
    expect(log.args).not.toContain('--approve-mcps')
    expect(requireMcpConfig(readObserve(fixture.observeFile)).source).toBe('none')
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

describe('wrapper effort recording', () => {
  it('records not exposed effort for ephemeral Codex runs without session artifacts', () => {
    const fixture = makeFixture('codex')
    const result = runCodex(fixture, [], {
      ...fixture.env,
      FAKE_CODEX_SESSION_EFFORT: 'high',
    })
    const observe = readObserve(fixture.observeFile)

    expect(result.status).toBe(0)
    expect(observe.run_effort).toEqual({
      effective: { source: 'not_exposed', value: null },
      requested: null,
    })
  })

  it('records measured effort from persisted sessions on resumable Codex runs', () => {
    const fixture = makeFixture('codex')
    const result = runCodex(fixture, ['resumable', '', ''], {
      ...fixture.env,
      FAKE_CODEX_SESSION_EFFORT: 'high',
    })
    const observe = readObserve(fixture.observeFile)

    expect(result.status).toBe(0)
    expect(observe.run_effort).toEqual({
      effective: { source: 'measured', value: 'high' },
      requested: null,
    })
  })

  it('records measured effort from the Cursor model slug', () => {
    const fixture = makeFixture('cursor')
    const result = runCursor(fixture)
    const observe = readObserve(fixture.observeFile)

    expect(result.status).toBe(0)
    expect(observe.run_effort).toEqual({
      effective: { source: 'measured', value: 'high' },
      requested: null,
    })
  })

  it('records not exposed effort for Claude and Devin runs', () => {
    const claudeFixture = makeFixture('claude')
    const claudeResult = runClaude(claudeFixture)
    const devinFixture = makeFixture('devin')
    const devinResult = runDevin(devinFixture)

    expect(claudeResult.status).toBe(0)
    expect(devinResult.status).toBe(0)
    expect(readObserve(claudeFixture.observeFile).run_effort).toEqual({
      effective: { source: 'not_exposed', value: null },
      requested: null,
    })
    expect(readObserve(devinFixture.observeFile).run_effort).toEqual({
      effective: { source: 'not_exposed', value: null },
      requested: null,
    })
  })
})

const wrapperModelArgs = (fixture: Fixture, model: string, modeArgs: string[] = []): string[] => [
  model,
  'implement',
  fixture.requestFile,
  fixture.responseFile,
  fixture.runDir,
  fixture.observeFile,
  ...modeArgs,
]

describe('wrapper effort suffix', () => {
  it('passes --effort to Claude and strips the suffix from --model', () => {
    const fixture = makeFixture('claude')
    const result = runWrapper(
      'delegate-claude.sh',
      wrapperModelArgs(fixture, 'sonnet@high'),
      fixture.env
    )
    const log = readLog(fixture.logFile)
    const observe = readObserve(fixture.observeFile)
    const modelIndex = log.args.indexOf('--model')

    const effortIndex = log.args.indexOf('--effort')
    expect(result.status).toBe(0)
    expect(log.args.slice(modelIndex, modelIndex + 2)).toEqual(['--model', 'sonnet'])
    expect(log.args.slice(effortIndex, effortIndex + 2)).toEqual(['--effort', 'high'])
    expect(observe.run_effort).toEqual({
      effective: { source: 'not_exposed', value: null },
      requested: 'high',
    })
  })

  it('passes model_reasoning_effort to Codex and keeps --ephemeral on normal runs', () => {
    const fixture = makeFixture('codex')
    const result = runWrapper(
      'delegate-codex.sh',
      wrapperModelArgs(fixture, 'gpt-5.5@high'),
      fixture.env
    )
    const log = readLog(fixture.logFile)
    const observe = readObserve(fixture.observeFile)

    expect(result.status).toBe(0)
    expect(log.args).toContain('--ephemeral')
    expect(log.args.join(' ')).toContain('-m gpt-5.5 -c model_reasoning_effort=high')
    expect(observe.run_effort).toEqual({
      effective: { source: 'not_exposed', value: null },
      requested: 'high',
    })
  })

  it('passes the ultra effort suffix through to Codex', () => {
    const fixture = makeFixture('codex')
    const result = runWrapper(
      'delegate-codex.sh',
      wrapperModelArgs(fixture, 'gpt-5.6-sol@ultra'),
      fixture.env
    )
    const log = readLog(fixture.logFile)
    const observe = readObserve(fixture.observeFile)

    expect(result.status).toBe(0)
    expect(log.args.join(' ')).toContain('-m gpt-5.6-sol -c model_reasoning_effort=ultra')
    expect(observe.run_effort).toEqual({
      effective: { source: 'not_exposed', value: null },
      requested: 'ultra',
    })
  })

  it('converts the suffix to a Cursor bracket override', () => {
    const fixture = makeFixture('cursor')
    const result = runWrapper(
      'delegate-cursor.sh',
      wrapperModelArgs(fixture, 'cursor-glm-5.2@high'),
      fixture.env
    )
    const log = readLog(fixture.logFile)
    const observe = readObserve(fixture.observeFile)

    expect(result.status).toBe(0)
    expect(log.args).toContain('glm-5.2[reasoning=high]')
    expect(log.args).not.toContain('glm-5.2')
    expect(observe.run_effort).toEqual({
      effective: { source: 'not_exposed', value: null },
      requested: 'high',
    })
  })

  it('fails closed before launching the CLI for unsupported suffixes', () => {
    const devinFixture = makeFixture('devin')
    const devinResult = runWrapper(
      'delegate-devin.sh',
      wrapperModelArgs(devinFixture, 'devin-glm-5.2@low'),
      devinFixture.env
    )
    const cursorFixture = makeFixture('cursor')
    const cursorResult = runWrapper(
      'delegate-cursor.sh',
      wrapperModelArgs(cursorFixture, 'composer-2.5@high'),
      cursorFixture.env
    )

    expect(devinResult.status).toBe(6)
    expect(cursorResult.status).toBe(6)
    expect(existsSync(devinFixture.logFile)).toBe(false)
    expect(existsSync(cursorFixture.logFile)).toBe(false)
    expect(readResponseStatus(devinFixture.responseFile)).toBe('failed')
    expect(readResponseStatus(cursorFixture.responseFile)).toBe('failed')
  })

  it('keeps launch argv free of effort flags when no suffix is given', () => {
    const claudeFixture = makeFixture('claude')
    runClaude(claudeFixture)
    const codexFixture = makeFixture('codex')
    runCodex(codexFixture)
    const claudeArgsLog = readLog(claudeFixture.logFile).args
    const codexArgsLog = readLog(codexFixture.logFile).args

    expect(claudeArgsLog).not.toContain('--effort')
    expect(codexArgsLog.some((arg) => arg.startsWith('model_reasoning_effort'))).toBe(false)
  })

  it('records the suffixed model as the resumable follow-up base', () => {
    const fixture = makeFixture('codex')
    const result = runWrapper(
      'delegate-codex.sh',
      wrapperModelArgs(fixture, 'gpt-5.5@high', ['resumable', '', '']),
      { ...fixture.env, FAKE_CODEX_SESSION_EFFORT: 'high' }
    )
    const observe = readObserve(fixture.observeFile)

    expect(result.status).toBe(0)
    expect(requireBackendSession(observe).model).toBe('gpt-5.5@high')
    expect(observe.run_effort).toEqual({
      effective: { source: 'measured', value: 'high' },
      requested: 'high',
    })
    expect(observe.event_kinds).not.toContain('effort_mismatch')
  })

  it('reuses the effort flag on follow-up and fails validation for a respecified base model', () => {
    const fixture = makeFixture('codex')
    const sessionHome = prepareCodexSessionHome(fixture.workDir, 'gpt-5.5@high')
    const result = runWrapper(
      'delegate-codex.sh',
      wrapperModelArgs(fixture, 'gpt-5.5@high', ['followup', 'thread-1', sessionHome]),
      fixture.env
    )
    const log = readLog(fixture.logFile)
    const validation = runFollowupValidation(fixture, 'codex', 'gpt-5.5')

    expect(result.status).toBe(0)
    expect(log.args.join(' ')).toContain('-m gpt-5.5 -c model_reasoning_effort=high')
    expect(validation.status).not.toBe(0)
    expect(validation.output).toContain('model mismatch')
  })

  it('appends an effort mismatch event when the measured effort differs', () => {
    const fixture = makeFixture('codex')
    const result = runWrapper(
      'delegate-codex.sh',
      wrapperModelArgs(fixture, 'gpt-5.5@high', ['resumable', '', '']),
      { ...fixture.env, FAKE_CODEX_SESSION_EFFORT: 'medium' }
    )
    const observe = readObserve(fixture.observeFile)

    expect(result.status).toBe(0)
    expect(observe.run_effort).toEqual({
      effective: { source: 'measured', value: 'medium' },
      requested: 'high',
    })
    expect(observe.event_kinds).toContain('effort_mismatch')
  })
})

// Step 4: wrapper 側 report 回収（構造化最終応答 / report.md）の分岐と fail-closed
const protocolResponse = (
  filePath: string
): { responder_session_id: string; sections: string[]; status: string } => {
  const value = readUnknownJson(filePath)
  if (
    !isRecord(value) ||
    typeof value.status !== 'string' ||
    typeof value.responder_session_id !== 'string' ||
    !Array.isArray(value.sections)
  ) {
    throw new Error('invalid protocol response')
  }
  return {
    responder_session_id: value.responder_session_id,
    sections: value.sections.map(String),
    status: value.status,
  }
}

const structuredParseFrom = (observeFile: string): boolean | null => {
  const value = readUnknownJson(observeFile)
  if (!isRecord(value) || !isRecord(value.timing)) {
    return null
  }
  const parse = value.timing.structured_output_parse
  if (typeof parse === 'boolean') {
    return parse
  }
  return null
}

describe('wrapper report collection', () => {
  it('builds the response from the claude structured final answer', () => {
    const fixture = makeFixture('claude')
    const result = runWrapper(
      'delegate-claude.sh',
      taskTypeArgs(fixture, 'haiku', 'chore'),
      fixture.env
    )
    const response = protocolResponse(fixture.responseFile)

    expect(result.status).toBe(0)
    expect(response.status).toBe('completed')
    expect(response.responder_session_id).toMatch(/^claude:haiku:/)
    expect(response.sections.join('\n')).toContain('# Summary')
    expect(structuredParseFrom(fixture.observeFile)).toBe(true)
  })

  it('fails closed when the claude structured output is missing', () => {
    const fixture = makeFixture('claude')
    const result = runWrapper('delegate-claude.sh', taskTypeArgs(fixture, 'haiku', 'chore'), {
      ...fixture.env,
      FAKE_CLAUDE_NO_STRUCTURED: '1',
    })
    const response = protocolResponse(fixture.responseFile)

    expect(result.status).toBe(1)
    expect(response.status).toBe('failed')
    expect(structuredParseFrom(fixture.observeFile)).toBe(false)
  })

  it('builds the response from the codex output-schema last message', () => {
    const fixture = makeFixture('codex')
    const result = runWrapper(
      'delegate-codex.sh',
      taskTypeArgs(fixture, 'gpt-5.5', 'chore'),
      fixture.env
    )
    const log = readLog(fixture.logFile)
    const response = protocolResponse(fixture.responseFile)

    expect(result.status).toBe(0)
    expect(log.args).toContain('--output-schema')
    expect(response.status).toBe('completed')
    expect(response.responder_session_id).toMatch(/^codex:gpt-5\.5:/)
    expect(structuredParseFrom(fixture.observeFile)).toBe(true)
  })

  it('fails closed when the codex last message is missing', () => {
    const fixture = makeFixture('codex')
    const result = runWrapper('delegate-codex.sh', taskTypeArgs(fixture, 'gpt-5.5', 'chore'), {
      ...fixture.env,
      FAKE_CODEX_NO_LAST_MSG: '1',
    })
    const response = protocolResponse(fixture.responseFile)

    expect(result.status).toBe(1)
    expect(response.status).toBe('failed')
    expect(structuredParseFrom(fixture.observeFile)).toBe(false)
  })

  it('builds the response from the devin front-matter report file', () => {
    const fixture = makeFixture('devin')
    const result = runWrapper(
      'delegate-devin.sh',
      taskTypeArgs(fixture, 'swe-1.7', 'chore'),
      fixture.env
    )
    const prompt = promptFromLog(readLog(fixture.logFile))
    const response = protocolResponse(fixture.responseFile)

    expect(result.status).toBe(0)
    expect(prompt).toContain('status: <completed | partial | failed | needs_input のいずれか>')
    expect(response.status).toBe('completed')
    expect(response.responder_session_id).toMatch(/^devin:swe-1\.7:/)
    expect(structuredParseFrom(fixture.observeFile)).toBeNull()
  })

  it('fails closed without leaving a partial response when the claude report body is blank', () => {
    const fixture = makeFixture('claude')
    const result = runWrapper('delegate-claude.sh', taskTypeArgs(fixture, 'haiku', 'chore'), {
      ...fixture.env,
      FAKE_CLAUDE_EMPTY_REPORT: '1',
    })
    const response = protocolResponse(fixture.responseFile)

    expect(result.status).toBe(1)
    expect(response.status).toBe('failed')
    expect(response.sections.join('\n')).toContain('did not write a response')
    expect(structuredParseFrom(fixture.observeFile)).toBe(false)
  })

  it('fails closed without leaving a partial response when the devin report body is blank', () => {
    const fixture = makeFixture('devin')
    const result = runWrapper('delegate-devin.sh', taskTypeArgs(fixture, 'swe-1.7', 'chore'), {
      ...fixture.env,
      FAKE_DEVIN_EMPTY_REPORT: '1',
    })
    const response = protocolResponse(fixture.responseFile)

    expect(result.status).toBe(1)
    expect(response.status).toBe('failed')
    expect(response.sections.join('\n')).toContain('did not write a response')
  })

  it('fails closed when the devin report file is missing', () => {
    const fixture = makeFixture('devin')
    const result = runWrapper('delegate-devin.sh', taskTypeArgs(fixture, 'swe-1.7', 'chore'), {
      ...fixture.env,
      FAKE_DEVIN_NO_REPORT: '1',
    })
    const response = protocolResponse(fixture.responseFile)

    expect(result.status).toBe(1)
    expect(response.status).toBe('failed')
    expect(structuredParseFrom(fixture.observeFile)).toBeNull()
  })

  it('builds the response from the cursor front-matter report file', () => {
    const fixture = makeFixture('cursor')
    const result = runWrapper(
      'delegate-cursor.sh',
      taskTypeArgs(fixture, 'composer-2.5', 'chore'),
      fixture.env
    )
    const response = protocolResponse(fixture.responseFile)

    expect(result.status).toBe(0)
    expect(response.status).toBe('completed')
    expect(response.responder_session_id).toMatch(/^cursor:composer-2\.5:/)
    expect(structuredParseFrom(fixture.observeFile)).toBeNull()
  })
})

describe('request prompt embedding', () => {
  it('embeds the request sections and task_type_chain into the initial prompt', () => {
    const fixture = makeFixture('claude')
    const result = runWrapper(
      'delegate-claude.sh',
      taskTypeArgs(fixture, 'haiku', 'chore'),
      fixture.env
    )
    const prompt = promptFromLog(readLog(fixture.logFile))

    expect(result.status).toBe(0)
    expect(prompt).toContain('<request>')
    expect(prompt).toContain('task_type_chain: []')
    expect(prompt).toContain('request')
    expect(prompt).not.toContain('read-request.sh')
  })

  it('falls back to read-request instructions above the inline gate', () => {
    const fixture = makeFixture('claude')
    const result = runWrapper('delegate-claude.sh', taskTypeArgs(fixture, 'haiku', 'chore'), {
      ...fixture.env,
      DELEGATE_REQUEST_INLINE_MAX: '1',
    })
    const log = readLog(fixture.logFile)
    const prompt = promptFromLog(log)
    const allowIndex = log.args.indexOf('--allowedTools')

    expect(result.status).toBe(0)
    expect(prompt).toContain('read-request.sh')
    expect(prompt).not.toContain('<request>')
    expect(log.args[allowIndex + 1]).toContain('read-request.sh')
  })

  it('passes the embedded prompt to devin via --prompt-file', () => {
    const fixture = makeFixture('devin')
    const result = runWrapper(
      'delegate-devin.sh',
      taskTypeArgs(fixture, 'swe-1.7', 'chore'),
      fixture.env
    )
    const log = readLog(fixture.logFile)
    const prompt = promptFromLog(log)

    expect(result.status).toBe(0)
    expect(log.args).toContain('--prompt-file')
    expect(prompt).toContain('<request>')
  })
})

describe('argv-path inline gate', () => {
  it('shrinks the inline gate below MAX_ARG_STRLEN for codex follow-up prompts', () => {
    const fixture = makeFixture('codex')
    const bigSection = 'x'.repeat(120_000)
    writeFileSync(
      fixture.requestFile,
      JSON.stringify({ sections: [bigSection], task_type_chain: ['chore'] })
    )
    const followupHome = prepareCodexSessionHome(fixture.workDir)
    const result = runWrapper(
      'delegate-codex.sh',
      [...taskTypeArgs(fixture, 'gpt-5.5', 'chore'), 'followup', 'thread-1', followupHome],
      fixture.env
    )
    const prompt = promptFromLog(readLog(fixture.logFile))

    expect(result.status).toBe(0)
    expect(prompt).toContain('read-request.sh')
    expect(prompt).not.toContain('<request>')
  })

  it('keeps the same request inline for normal codex runs passed via stdin', () => {
    const fixture = makeFixture('codex')
    const bigSection = 'x'.repeat(120_000)
    writeFileSync(
      fixture.requestFile,
      JSON.stringify({ sections: [bigSection], task_type_chain: ['chore'] })
    )
    const result = runWrapper(
      'delegate-codex.sh',
      taskTypeArgs(fixture, 'gpt-5.5', 'chore'),
      fixture.env
    )
    const prompt = promptFromLog(readLog(fixture.logFile))

    expect(result.status).toBe(0)
    expect(prompt).toContain('<request>')
  })
})
