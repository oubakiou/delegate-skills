import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const launcherPath = path.join(repoRoot, 'scripts', 'codex-devcontainer.sh')
const fixtureRoots = new Set<string>()

interface LauncherFixture {
  env: NodeJS.ProcessEnv
  launcher: string
}

interface LauncherOutcome {
  childPid: number
  status: number
  stderr: string
  stdout: string
}

const createFixtureDirectory = (): { binDir: string; fixtureDir: string } => {
  const tempRoot = path.join(repoRoot, '.temp')
  mkdirSync(tempRoot, { recursive: true })
  const fixtureDir = mkdtempSync(path.join(tempRoot, 'codex-devcontainer-test-'))
  fixtureRoots.add(fixtureDir)
  const binDir = path.join(fixtureDir, 'bin')
  mkdirSync(binDir)
  return { binDir, fixtureDir }
}

const writeFakeCodex = (binDir: string): void => {
  const fakeCodex = path.join(binDir, 'codex')
  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
console.log(JSON.stringify({ args: process.argv.slice(2), pid: process.pid }))
`
  )
  chmodSync(fakeCodex, 0o755)
}

const writeFixtureLauncher = (fixtureDir: string): string => {
  const launcher = path.join(fixtureDir, 'codex-devcontainer.sh')
  copyFileSync(launcherPath, launcher)
  chmodSync(launcher, 0o755)
  return launcher
}

const makeFixture = (): LauncherFixture => {
  const { binDir, fixtureDir } = createFixtureDirectory()
  writeFakeCodex(binDir)
  const launcher = writeFixtureLauncher(fixtureDir)

  return {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    launcher,
  }
}

const runLauncher = async (fixture: LauncherFixture, args: string[]): Promise<LauncherOutcome> =>
  new Promise((resolve, reject) => {
    const child = spawn(fixture.launcher, args, { cwd: repoRoot, env: fixture.env })
    let stderr = ''
    let stdout = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ childPid: child.pid ?? -1, status: code ?? -1, stderr, stdout })
    })
  })

const launcherModeCases = [
  {
    expectedArgs: [
      '--sandbox',
      'danger-full-access',
      '--ask-for-approval',
      'on-request',
      '--model',
      'gpt-test',
      'prompt text',
    ],
    inputArgs: ['--model', 'gpt-test', 'prompt text'],
    name: 'interactive',
  },
  {
    expectedArgs: [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--model',
      'gpt-test',
      'prompt text',
    ],
    inputArgs: ['--unattended', '--model', 'gpt-test', 'prompt text'],
    name: 'unattended',
  },
] as const

const rejectedPolicyArgv: string[][] = [
  ['--dangerously-bypass-approvals-and-sandbox'],
  ['exec', '--dangerously-bypass-approvals-and-sandbox=true'],
  ['exec', '--yolo'],
  ['--yolo=true'],
  ['--full-auto'],
  ['exec', '--full-auto=true'],
  ['exec', '--ask-for-approval', 'never'],
  ['exec', '--ask-for-approval=never'],
  ['-a', 'never'],
  ['-a=never'],
  ['-anever'],
  ['exec', '--sandbox', 'workspace-write'],
  ['exec', '--sandbox=workspace-write'],
  ['-s', 'workspace-write'],
  ['-s=workspace-write'],
  ['-sworkspace-write'],
  ['exec', '-c', 'sandbox_mode="workspace-write"'],
  ['exec', '-csandbox_mode="workspace-write"'],
  ['-c=approval_policy="never"'],
  ['exec', '--config', 'permissions.allow_network=true'],
  ['--config=default_permissions="allow"'],
  ['--profile', 'unsafe'],
  ['exec', '--profile=unsafe'],
  ['-p', 'unsafe'],
  ['-p=unsafe'],
  ['-punsafe'],
  ['--remote', 'https://remote.example.test'],
  ['exec', '--remote', 'https://remote.example.test'],
  ['--remote=https://remote.example.test'],
  ['exec', '--remote=https://remote.example.test'],
  ['--remote-auth-token-env', 'REMOTE_TOKEN'],
  ['exec', '--remote-auth-token-env', 'REMOTE_TOKEN'],
  ['--remote-auth-token-env=REMOTE_TOKEN'],
  ['exec', '--remote-auth-token-env=REMOTE_TOKEN'],
]

const rejectedPolicyCases = rejectedPolicyArgv.map((args) => ({ args }))

const expectRejectedLauncher = (outcome: LauncherOutcome, message: string): void => {
  expect(outcome.status).not.toBe(0)
  expect(outcome.stderr).toContain(message)
  expect(outcome.stdout).toBe('')
}

const expectLauncherInvocation = (
  outcome: LauncherOutcome,
  expectedArgs: readonly string[]
): void => {
  expect(outcome.status).toBe(0)
  const invocation: unknown = JSON.parse(outcome.stdout)
  expect(invocation).toEqual({
    args: expectedArgs,
    pid: outcome.childPid,
  })
}

const expectIsolationWarning = (outcome: LauncherOutcome): void => {
  const warnings = outcome.stderr.match(/WARNING: codex-devcontainer/g) ?? []
  expect(warnings).toHaveLength(1)
  expect(outcome.stderr).toContain('does not provide isolation')
  expect(outcome.stderr).toContain('full-access Codex can reach')
  expect(outcome.stderr).toContain('external isolation boundary')
}

afterEach(() => {
  for (const fixtureRoot of fixtureRoots) {
    rmSync(fixtureRoot, { force: true, recursive: true })
  }
  fixtureRoots.clear()
})

describe('codex Dev Container launcher', () => {
  it.each(launcherModeCases)('launches $name with one isolation warning', async (mode) => {
    const fixture = makeFixture()

    const outcome = await runLauncher(fixture, [...mode.inputArgs])

    expectLauncherInvocation(outcome, mode.expectedArgs)
    expectIsolationWarning(outcome)
  })

  it('keeps unattended mode non-interactive when no exec arguments are supplied', async () => {
    const fixture = makeFixture()

    const outcome = await runLauncher(fixture, ['--unattended'])

    expect(outcome.status).toBe(0)
    expectIsolationWarning(outcome)
    const invocation: unknown = JSON.parse(outcome.stdout)
    expect(invocation).toEqual({
      args: ['exec', '--dangerously-bypass-approvals-and-sandbox'],
      pid: outcome.childPid,
    })
  })

  it.each(rejectedPolicyCases)(
    'rejects normal-mode policy override argv $args',
    async ({ args }) => {
      const fixture = makeFixture()

      const outcome = await runLauncher(fixture, args)

      expectRejectedLauncher(outcome, 'normal mode does not allow policy override argument')
      expectIsolationWarning(outcome)
    }
  )
})
