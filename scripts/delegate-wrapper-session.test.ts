import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

interface FakeCliLog {
  args: string[]
  cwd: string
  env: {
    CLAUDE_CONFIG_DIR: string | null
    CODEX_HOME: string | null
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

const readLog = (filePath: string): FakeCliLog => {
  const value = readUnknownJson(filePath)
  if (!isRecord(value) || !Array.isArray(value.args) || !isRecord(value.env)) {
    throw new Error('invalid fake CLI log')
  }
  return {
    args: value.args.map(String),
    cwd: stringOrNullValue(value.cwd) ?? '',
    env: {
      CLAUDE_CONFIG_DIR: stringOrNullValue(value.env.CLAUDE_CONFIG_DIR),
      CODEX_HOME: stringOrNullValue(value.env.CODEX_HOME),
      TMPDIR: stringOrNullValue(value.env.TMPDIR),
    },
  }
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
const responseMatches = [...prompt.matchAll(/"([^"]+_res\\.json)"/g)].map((match) => match[1])
const responseFile = responseMatches[responseMatches.length - 1]
if (responseFile) {
  fs.writeFileSync(responseFile, JSON.stringify({protocol_version: 1, type: 'response', status: 'completed', responder_session_id: 'fake', sections: ['# Summary\\nok']}))
}
const sessionIdIndex = args.indexOf('--session-id')
if (sessionIdIndex !== -1 && process.env.CLAUDE_CONFIG_DIR && process.env.FAKE_CLAUDE_NO_SESSION !== '1') {
  const sessionDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fake-project')
  fs.mkdirSync(sessionDir, {recursive: true})
  fs.writeFileSync(path.join(sessionDir, args[sessionIdIndex + 1] + '.jsonl'), '{}\\n')
}
fs.writeFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({args, cwd: process.cwd(), env: {CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, TMPDIR: process.env.TMPDIR}}))
console.log(JSON.stringify({type: 'result', usage: {input_tokens: 1, output_tokens: 1}}))
`

const codexFakeScript = (): string => `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
const prompt = args[args.length - 1] || ''
const responseMatches = [...prompt.matchAll(/"([^"]+_res\\.json)"/g)].map((match) => match[1])
const responseFile = responseMatches[responseMatches.length - 1]
if (responseFile) {
  fs.writeFileSync(responseFile, JSON.stringify({protocol_version: 1, type: 'response', status: 'completed', responder_session_id: 'fake', sections: ['# Summary\\nok']}))
}
fs.writeFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({args, cwd: process.cwd(), env: {CODEX_HOME: process.env.CODEX_HOME, TMPDIR: process.env.TMPDIR}}))
if (process.env.FAKE_CODEX_NO_THREAD !== '1') {
  console.log(JSON.stringify({type: 'thread.started', thread_id: 'thread-1'}))
}
console.log(JSON.stringify({type: 'turn.completed', usage: {input_tokens: 1, output_tokens: 1}}))
`

const fakeScript = (name: 'claude' | 'codex'): string => {
  if (name === 'claude') {
    return claudeFakeScript()
  }
  return codexFakeScript()
}

const writeFakeCli = (binDir: string, name: 'claude' | 'codex'): void => {
  const scriptPath = path.join(binDir, name)
  writeFileSync(scriptPath, fakeScript(name))
  chmodSync(scriptPath, 0o755)
}

const makeFixturePaths = (
  backend: 'claude' | 'codex'
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
  backend: 'claude' | 'codex'
): void => {
  mkdirSync(paths.binDir, { recursive: true })
  mkdirSync(paths.runDir, { recursive: true })
  mkdirSync(path.join(paths.homeDir, '.claude'), { recursive: true })
  mkdirSync(path.join(paths.homeDir, '.codex'), { recursive: true })
  writeFileSync(path.join(paths.homeDir, '.claude', '.credentials.json'), '{}')
  writeFileSync(path.join(paths.homeDir, '.codex', 'auth.json'), '{}')
  writeFileSync(paths.requestFile, JSON.stringify({ sections: ['request'] }))
  writeFakeCli(paths.binDir, backend)
}

const fixtureEnv = (
  paths: Omit<Fixture, 'env'> & { binDir: string; homeDir: string }
): NodeJS.ProcessEnv => ({
  ...process.env,
  DELEGATE_OBSERVE_HEARTBEAT_INTERVAL: '1',
  FAKE_CLI_LOG: paths.logFile,
  HOME: paths.homeDir,
  PATH: `${paths.binDir}:${process.env.PATH ?? ''}`,
})

const makeFixture = (backend: 'claude' | 'codex'): Fixture => {
  const paths = makeFixturePaths(backend)
  writeFixtureFiles(paths, backend)
  return { ...paths, env: fixtureEnv(paths) }
}

const runWrapper = (
  scriptName: 'delegate-claude.sh' | 'delegate-codex.sh',
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
})
