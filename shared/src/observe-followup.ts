import { execFileSync } from 'node:child_process'
import { realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { runBuildResponse } from './build-response.ts'
import { getPath, hasFileContent, isRecord, readFileOrEmpty } from './jq-compat.ts'
import { failedResponseWritten, type Env } from './observe-store.ts'
import { randomToken } from './protocol.ts'

// bash 版 observe-json.sh の session reuse / failed response 系関数と同一契約
// (等価性は scripts/observe-store-parity.test.ts が bash 実装との突き合わせで検証する)。

const RESUMABLE_BACKENDS = new Set(['claude', 'codex', 'devin', 'cursor'])

export const backendSupportsResume = (backend: string): boolean => RESUMABLE_BACKENDS.has(backend)

export type FollowupValidation = { ok: true } | { ok: false; message: string }

const unavailable = (message: string): FollowupValidation => ({
  ok: false,
  message: `follow-up unavailable: ${message}`,
})

export interface FollowupExpectation {
  previousObserveFile: string
  expectedBackend: string
  expectedModel: string
  expectedRepoRoot: string
  expectedWorktreeRoot: string
}

interface PreviousSession {
  backend: string
  model: string
  resumeId: string
  persistence: string
  repoRoot: string
  worktreeRoot: string
  gitHead: string
}

const previousSessionOf = (observeFile: string): PreviousSession | null => {
  let parsed: unknown = null
  try {
    parsed = JSON.parse(readFileOrEmpty(observeFile))
  } catch {
    return null
  }
  if (!isRecord(parsed)) {
    return null
  }
  const field = (keys: string[]): string => {
    const value = getPath(parsed, keys)
    if (typeof value === 'string') {
      return value
    }
    return ''
  }
  return {
    backend: field(['backend_session', 'backend']),
    model: field(['backend_session', 'model']),
    resumeId: field(['backend_session', 'resume_id']),
    persistence: field(['backend_session', 'persistence']),
    repoRoot: field(['run_context', 'repo_root']),
    worktreeRoot: field(['run_context', 'worktree_root']),
    gitHead: field(['run_context', 'git_head']),
  }
}

const gitHeadOrNull = (worktree: string): string | null => {
  try {
    return execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trimEnd()
  } catch {
    return null
  }
}

const isAncestor = (worktree: string, ancestor: string, descendant: string): boolean => {
  try {
    execFileSync('git', ['-C', worktree, 'merge-base', '--is-ancestor', ancestor, descendant], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

const backendLabelOf = (backend: string): string => {
  if (backend === '') {
    return 'missing'
  }
  return backend
}

const validateSessionShape = (previous: PreviousSession): FollowupValidation | null => {
  if (!backendSupportsResume(previous.backend)) {
    return unavailable(`unsupported backend: ${backendLabelOf(previous.backend)}`)
  }
  if (previous.persistence !== 'resumable') {
    return unavailable('backend_session.persistence is not resumable')
  }
  if (previous.resumeId === '') {
    return unavailable('backend_session.resume_id is missing')
  }
  if (previous.repoRoot === '' || previous.worktreeRoot === '' || previous.gitHead === '') {
    return unavailable('run_context required field is missing')
  }
  return null
}

const validateSessionMatch = (
  previous: PreviousSession,
  expectation: FollowupExpectation,
  reals: { repoReal: string; worktreeReal: string }
): FollowupValidation | null => {
  if (previous.backend !== expectation.expectedBackend) {
    return unavailable(
      `backend mismatch: expected ${expectation.expectedBackend}, got ${previous.backend}`
    )
  }
  if (previous.model !== expectation.expectedModel) {
    return unavailable(
      `model mismatch: expected ${expectation.expectedModel}, got ${previous.model}`
    )
  }
  if (previous.repoRoot !== reals.repoReal) {
    return unavailable(`repo_root mismatch: expected ${reals.repoReal}, got ${previous.repoRoot}`)
  }
  if (previous.worktreeRoot !== reals.worktreeReal) {
    return unavailable(
      `worktree_root mismatch: expected ${reals.worktreeReal}, got ${previous.worktreeRoot}`
    )
  }
  return null
}

const validateGitHead = (
  previous: PreviousSession,
  worktreeReal: string
): FollowupValidation | null => {
  const currentHead = gitHeadOrNull(worktreeReal)
  if (currentHead === null) {
    return unavailable('current git_head is unavailable')
  }
  if (
    previous.gitHead !== currentHead &&
    !isAncestor(worktreeReal, previous.gitHead, currentHead)
  ) {
    return unavailable('git_head is not current HEAD or its ancestor')
  }
  return null
}

const validateAgainstWorktree = (
  previous: PreviousSession,
  expectation: FollowupExpectation
): FollowupValidation => {
  const repoReal = realpathSync(expectation.expectedRepoRoot)
  const worktreeReal = realpathSync(expectation.expectedWorktreeRoot)
  const matchFailure = validateSessionMatch(previous, expectation, { repoReal, worktreeReal })
  if (matchFailure !== null) {
    return matchFailure
  }
  const headFailure = validateGitHead(previous, worktreeReal)
  if (headFailure !== null) {
    return headFailure
  }
  return { ok: true }
}

export const validateFollowup = (expectation: FollowupExpectation): FollowupValidation => {
  if (!hasFileContent(expectation.previousObserveFile)) {
    return unavailable('previous observe JSON is missing')
  }
  const previous = previousSessionOf(expectation.previousObserveFile)
  if (previous === null) {
    return unavailable('previous observe JSON is invalid')
  }
  const shapeFailure = validateSessionShape(previous)
  if (shapeFailure !== null) {
    return shapeFailure
  }
  return validateAgainstWorktree(previous, expectation)
}

export interface FailedResponseInput {
  observeFile: string
  runDir: string
  backend: string
  responseFile: string
  exitCode: number
}

// 子 CLI が response を書けなかった場合の fail-closed な失敗レスポンス生成
export const writeFailedResponse = (
  input: FailedResponseInput,
  env: Env = process.env
): boolean => {
  const base = path.basename(input.responseFile, '.json')
  const reportFile = path.join(input.runDir, `${base}_failed_${randomToken(5)}.md`)
  const report = [
    '# Summary',
    'Child CLI failed or did not write a response.',
    '',
    '# Error',
    `See observe JSON: ${input.observeFile}`,
    `Exit code: ${input.exitCode}`,
    '',
  ].join('\n')
  writeFileSync(reportFile, report)
  const result = runBuildResponse(
    ['failed', `wrapper:${input.backend}:${base}`, input.responseFile],
    env,
    Buffer.from(report)
  )
  if (result.exitCode !== 0) {
    return false
  }
  failedResponseWritten(input.observeFile, input.runDir)
  return true
}
