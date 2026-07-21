import { spawn } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const launcherPath = path.join(repoRoot, 'scripts', 'codex-devcontainer.sh')
const fixtureRoots = new Set<string>()

interface LauncherFixture {
  containerenv: string
  dockerenv: string
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

const writeFixtureLauncher = (
  fixtureDir: string,
  dockerenv: string,
  containerenv: string
): string => {
  const launcher = path.join(fixtureDir, 'codex-devcontainer.sh')
  copyFileSync(launcherPath, launcher)
  const launcherSource = readFileSync(launcher, 'utf8')
    .replaceAll('/.dockerenv', dockerenv)
    .replaceAll('/run/.containerenv', containerenv)
  writeFileSync(launcher, launcherSource)
  chmodSync(launcher, 0o755)
  return launcher
}

const makeFixture = (): LauncherFixture => {
  const { binDir, fixtureDir } = createFixtureDirectory()
  writeFakeCodex(binDir)
  const dockerenv = path.join(fixtureDir, '.dockerenv')
  const containerenv = path.join(fixtureDir, '.containerenv')
  const launcher = writeFixtureLauncher(fixtureDir, dockerenv, containerenv)

  return {
    containerenv,
    dockerenv,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    launcher,
  }
}

const makeLauncherEnv = (fixture: LauncherFixture, boundaryEnabled: boolean): NodeJS.ProcessEnv => {
  const env = { ...fixture.env }
  if (boundaryEnabled) {
    env.DELEGATE_DEVCONTAINER_BOUNDARY = '1'
  } else {
    delete env.DELEGATE_DEVCONTAINER_BOUNDARY
  }
  return env
}

const runLauncher = async (
  fixture: LauncherFixture,
  args: string[],
  boundaryEnabled: boolean
): Promise<LauncherOutcome> =>
  new Promise((resolve, reject) => {
    const env = makeLauncherEnv(fixture, boundaryEnabled)
    const child = spawn(fixture.launcher, args, { cwd: repoRoot, env })
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

const runtimeMarkerCases = [
  { containerenv: false, dockerenv: false, name: 'no runtime marker' },
  { containerenv: false, dockerenv: true, name: '.dockerenv' },
  { containerenv: true, dockerenv: false, name: '.containerenv' },
  { containerenv: true, dockerenv: true, name: 'both runtime markers' },
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

const writeRuntimeMarkers = (
  fixture: LauncherFixture,
  dockerenv: boolean,
  containerenv: boolean
): void => {
  if (dockerenv) {
    writeFileSync(fixture.dockerenv, '')
  }
  if (containerenv) {
    writeFileSync(fixture.containerenv, '')
  }
}

const expectRejectedLauncher = (outcome: LauncherOutcome, message: string): void => {
  expect(outcome.status).not.toBe(0)
  expect(outcome.stderr).toContain(message)
  expect(outcome.stdout).toBe('')
}

const expectInteractiveInvocation = (outcome: LauncherOutcome): void => {
  expect(outcome.status).toBe(0)
  expect(outcome.stderr).toBe('')
  const invocation: unknown = JSON.parse(outcome.stdout)
  expect(invocation).toEqual({
    args: [
      '--sandbox',
      'danger-full-access',
      '--ask-for-approval',
      'on-request',
      '--model',
      'gpt-test',
      'prompt text',
    ],
    pid: outcome.childPid,
  })
}

afterEach(() => {
  for (const fixtureRoot of fixtureRoots) {
    rmSync(fixtureRoot, { force: true, recursive: true })
  }
  fixtureRoots.clear()
})

describe('codex Dev Container launcher', () => {
  it.each(runtimeMarkerCases)(
    'rejects a missing explicit boundary marker with $name',
    async ({ containerenv, dockerenv }) => {
      const fixture = makeFixture()
      writeRuntimeMarkers(fixture, dockerenv, containerenv)

      const outcome = await runLauncher(fixture, ['prompt text'], false)

      expectRejectedLauncher(outcome, 'DELEGATE_DEVCONTAINER_BOUNDARY=1 is required')
    }
  )

  it.each(runtimeMarkerCases)(
    'handles the explicit marker with $name',
    async ({ containerenv, dockerenv }) => {
      const fixture = makeFixture()
      writeRuntimeMarkers(fixture, dockerenv, containerenv)

      const outcome = await runLauncher(fixture, ['--model', 'gpt-test', 'prompt text'], true)

      if (!dockerenv && !containerenv) {
        expectRejectedLauncher(outcome, 'no container runtime marker found')
        return
      }

      expectInteractiveInvocation(outcome)
    }
  )

  it('keeps unattended approval bypass behind an explicit launcher flag', async () => {
    const fixture = makeFixture()
    writeFileSync(fixture.dockerenv, '')

    const outcome = await runLauncher(
      fixture,
      ['--unattended', '--model', 'gpt-test', 'prompt text'],
      true
    )

    expect(outcome.status).toBe(0)
    const invocation: unknown = JSON.parse(outcome.stdout)
    expect(invocation).toEqual({
      args: [
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--model',
        'gpt-test',
        'prompt text',
      ],
      pid: outcome.childPid,
    })
  })

  it('keeps unattended mode non-interactive when no exec arguments are supplied', async () => {
    const fixture = makeFixture()
    writeFileSync(fixture.containerenv, '')

    const outcome = await runLauncher(fixture, ['--unattended'], true)

    expect(outcome.status).toBe(0)
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
      writeFileSync(fixture.dockerenv, '')

      const outcome = await runLauncher(fixture, args, true)

      expectRejectedLauncher(outcome, 'normal mode does not allow policy override argument')
    }
  )
})
