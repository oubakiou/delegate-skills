// run.sh / run-imagegen.sh / run-x-research.sh の one-shot 契約（単一 JSON stdout・
// exit code 透過・observe_file の stderr 先出し・selector 既定）を fake CLI で検証する。
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

interface RunJson {
  content: string
  content_truncated: boolean
  exit_code: number
  observe_file: string | null
  response_file: string | null
  run_dir: string | null
  status: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isRunJson = (value: unknown): value is RunJson =>
  isRecord(value) &&
  typeof value.exit_code === 'number' &&
  typeof value.status === 'string' &&
  typeof value.content === 'string' &&
  typeof value.content_truncated === 'boolean'

const parseRunJson = (stdout: string): RunJson => {
  const value: unknown = JSON.parse(stdout)
  if (!isRunJson(value)) {
    throw new Error('stdout is not the run.sh JSON contract')
  }
  return value
}

const fakeClaudeScript = `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
const prompt = args[args.indexOf('-p') + 1] || ''
const matches = [...prompt.matchAll(/"([^"]+_res\\.json)"/g)].map((match) => match[1])
const responseFile = matches[matches.length - 1]
if (process.env.FAKE_CLAUDE_EXIT_WITHOUT_RESPONSE === '1') process.exit(9)
if (responseFile && process.env.FAKE_CLAUDE_CORRUPT_RESPONSE === '1') {
  fs.writeFileSync(responseFile, 'not json')
} else if (responseFile) {
  let summary = '# Summary\\nok from fake worker'
  if (process.env.FAKE_CLAUDE_MULTIBYTE === '1') summary = '# Summary\\nあいうえおかきくけこ'
  fs.writeFileSync(responseFile, JSON.stringify({protocol_version: 1, type: 'response', status: 'completed', responder_session_id: 'fake', index: '- Summary', sections: [summary]}))
}
console.log(JSON.stringify({type: 'result', num_turns: 1, usage: {input_tokens: 1, output_tokens: 1}}))
`

const fakeGrokScript = `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
if (args[0] === 'models') {
  console.log('  - grok-build')
  process.exit(0)
}
const prompt = args[args.indexOf('-p') + 1] || ''
const matches = [...prompt.matchAll(/"([^"]+_res\\.json)"/g)].map((match) => match[1])
const responseFile = matches[matches.length - 1]
if (responseFile) {
  fs.writeFileSync(responseFile, JSON.stringify({protocol_version: 1, type: 'response', status: 'completed', responder_session_id: 'fake', index: '- Summary', sections: ['# Summary\\nx research ok']}))
}
console.log('plain output')
`

const fakeCodexScript = `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
const prompt = args[args.length - 1] || ''
const matches = [...prompt.matchAll(/"([^"]+_res\\.json)"/g)].map((match) => match[1])
const responseFile = matches[matches.length - 1]
if (responseFile) {
  fs.writeFileSync(responseFile, JSON.stringify({protocol_version: 1, type: 'response', status: 'completed', responder_session_id: 'fake', index: '- Summary', sections: ['# Summary\\nimagegen ok']}))
}
console.log(JSON.stringify({type: 'turn.completed', usage: {input_tokens: 1, output_tokens: 1}}))
`

interface Harness {
  env: NodeJS.ProcessEnv
  metricsFile: string
  workDir: string
}

// fake が上書きする CLI と、テスト対象のモデル解決へ漏れ得る ambient env を親環境から落とす
const DROPPED_ENV_KEYS = new Set([
  'DELEGATE_IMAGEGEN_MODEL',
  'DELEGATE_METRICS_FILE',
  'DELEGATE_RUN_CONTENT_MAX',
  'DELEGATE_RUN_TEST_MODEL',
  'DELEGATE_WORK_DIR',
  'DELEGATE_X_RESEARCH_MODEL',
])

const writeFakeCli = (binDir: string, name: string, script: string): void => {
  const cliPath = path.join(binDir, name)
  writeFileSync(cliPath, script)
  chmodSync(cliPath, 0o755)
}

const makeFakeBinDir = (workDir: string): string => {
  const binDir = path.join(workDir, 'bin')
  mkdirSync(binDir, { recursive: true })
  writeFakeCli(binDir, 'claude', fakeClaudeScript)
  writeFakeCli(binDir, 'grok', fakeGrokScript)
  writeFakeCli(binDir, 'codex', fakeCodexScript)
  return binDir
}

const makeHarnessEnv = (workDir: string, binDir: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !DROPPED_ENV_KEYS.has(key))
  )
  env.PATH = `${binDir}:${process.env.PATH ?? ''}`
  env.DELEGATE_WORK_DIR = path.join(workDir, 'work')
  return env
}

const makeHarness = (): Harness => {
  const tempRoot = path.join(repoRoot, '.temp')
  mkdirSync(tempRoot, { recursive: true })
  const workDir = mkdtempSync(path.join(tempRoot, 'delegate-run-test-'))
  const binDir = makeFakeBinDir(workDir)
  return {
    env: makeHarnessEnv(workDir, binDir),
    metricsFile: path.join(workDir, 'metrics.jsonl'),
    workDir,
  }
}

interface RunOutcome {
  status: number
  stderr: string
  stdout: string
}

const runOneShot = (
  harness: Harness,
  scriptAndArgs: string[],
  extraEnv: NodeJS.ProcessEnv = {}
): RunOutcome => {
  const result = spawnSync('bash', scriptAndArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...harness.env, ...extraEnv },
    input: '# Task\none-shot test body\n',
  })
  return { status: result.status ?? -1, stderr: result.stderr, stdout: result.stdout }
}

const chorArgs = (selector = ''): string[] => {
  const args = ['shared/run.sh', 'chore', 'DELEGATE_RUN_TEST_MODEL', 'haiku', '[]', 'run-test']
  if (selector !== '') {
    args.push(selector)
  }
  return args
}

const expectRunPaths = (json: RunJson): void => {
  expect(json.response_file).toMatch(/_res\.json$/)
  expect(json.observe_file).toMatch(/_observe\.json$/)
  expect(json.run_dir).toBeTruthy()
}

const expectNullPaths = (json: RunJson): void => {
  expect(json.response_file).toBeNull()
  expect(json.observe_file).toBeNull()
  expect(json.run_dir).toBeNull()
}

const readResponseSelectors = (harness: Harness): string[] => {
  const lines = readFileSync(harness.metricsFile, 'utf8').trimEnd().split('\n')
  return lines
    .map((line): unknown => JSON.parse(line))
    .filter(
      (record): record is { kind: string; selector: string } =>
        isRecord(record) && record.kind === 'read_response'
    )
    .map((record) => record.selector)
}

describe('run.sh one-shot', () => {
  it('returns the single JSON contract and pre-announces observe_file on stderr', () => {
    const harness = makeHarness()
    const outcome = runOneShot(harness, chorArgs())
    expect(outcome.status).toBe(0)
    const json = parseRunJson(outcome.stdout)
    expect(json.exit_code).toBe(0)
    expect(json.status).toBe('completed')
    expect(json.content).toContain('ok from fake worker')
    expect(json.content_truncated).toBe(false)
    expectRunPaths(json)
    expect(outcome.stderr).toContain('observe_file: ')
  })

  it('truncates content at DELEGATE_RUN_CONTENT_MAX', () => {
    const harness = makeHarness()
    const outcome = runOneShot(harness, chorArgs(), { DELEGATE_RUN_CONTENT_MAX: '16' })
    expect(outcome.status).toBe(0)
    const json = parseRunJson(outcome.stdout)
    expect(json.content_truncated).toBe(true)
    expect(json.content).toHaveLength(16)
    expectRunPaths(json)
  })

  it('keeps truncated content within the byte cap on UTF-8 boundaries', () => {
    const harness = makeHarness()
    const outcome = runOneShot(harness, chorArgs(), {
      DELEGATE_RUN_CONTENT_MAX: '52',
      FAKE_CLAUDE_MULTIBYTE: '1',
    })
    expect(outcome.status).toBe(0)
    const json = parseRunJson(outcome.stdout)
    expect(json.content_truncated).toBe(true)
    expect(Buffer.byteLength(json.content, 'utf8')).toBeLessThanOrEqual(52)
    expect(json.content).not.toContain('�')
  })

  it('passes the delegation-cycle prepare failure through as exit 4', () => {
    const harness = makeHarness()
    const outcome = runOneShot(harness, [
      'shared/run.sh',
      'chore',
      'DELEGATE_RUN_TEST_MODEL',
      'haiku',
      '["chore"]',
      'run-test',
    ])
    expect(outcome.status).toBe(4)
    const json = parseRunJson(outcome.stdout)
    expect(json.exit_code).toBe(4)
    expect(json.status).toBe('failed')
    expect(json.content).toContain('委譲チェーン')
    expectNullPaths(json)
  })

  it('passes the invalid effort suffix prepare failure through as exit 6', () => {
    const harness = makeHarness()
    const outcome = runOneShot(harness, chorArgs(), { DELEGATE_RUN_TEST_MODEL: 'haiku@bogus' })
    expect(outcome.status).toBe(6)
    const json = parseRunJson(outcome.stdout)
    expect(json.exit_code).toBe(6)
    expect(json.content).toContain('invalid effort')
    expectNullPaths(json)
  })

  it('emits the same JSON contract on argument errors and exits 2', () => {
    const harness = makeHarness()
    const outcome = runOneShot(harness, ['shared/run.sh', 'chore'])
    expect(outcome.status).toBe(2)
    const json = parseRunJson(outcome.stdout)
    expect(json.exit_code).toBe(2)
    expect(json.status).toBe('failed')
    expect(json.content).toContain('Usage:')
    expectNullPaths(json)
    expect(outcome.stderr).toContain('Usage:')
  })

  it('propagates dispatch failure and surfaces the failed response content', () => {
    const harness = makeHarness()
    const outcome = runOneShot(harness, chorArgs(), { FAKE_CLAUDE_EXIT_WITHOUT_RESPONSE: '1' })
    expect(outcome.status).toBe(9)
    const json = parseRunJson(outcome.stdout)
    expect(json.exit_code).toBe(9)
    expect(json.status).toBe('failed')
    expect(json.content).toContain('did not write a response')
    expectRunPaths(json)
  })

  it('returns the failure schema when the worker response is corrupt JSON', () => {
    const harness = makeHarness()
    const outcome = runOneShot(harness, chorArgs(), { FAKE_CLAUDE_CORRUPT_RESPONSE: '1' })
    expect(outcome.status).toBeGreaterThan(0)
    const json = parseRunJson(outcome.stdout)
    expect(json.exit_code).toBe(outcome.status)
    expect(json.status).toBe('failed')
    expectRunPaths(json)
  })

  it('defaults the selector to auto for chore and decision for review', () => {
    const harness = makeHarness()
    const chore = runOneShot(harness, chorArgs(), { DELEGATE_METRICS_FILE: harness.metricsFile })
    const review = runOneShot(
      harness,
      ['shared/run.sh', 'review', 'DELEGATE_RUN_TEST_MODEL', 'haiku', '[]', 'run-test'],
      { DELEGATE_METRICS_FILE: harness.metricsFile }
    )
    expect(chore.status).toBe(0)
    expect(review.status).toBe(0)
    expect(readResponseSelectors(harness)).toEqual(['auto', 'decision'])
  })

  it('forwards an explicit selector to read-response.sh', () => {
    const harness = makeHarness()
    const outcome = runOneShot(harness, chorArgs('status'), {
      DELEGATE_METRICS_FILE: harness.metricsFile,
    })
    expect(outcome.status).toBe(0)
    expect(parseRunJson(outcome.stdout).content.trimEnd()).toBe('completed')
    expect(readResponseSelectors(harness)).toEqual(['status'])
  })
})

describe('dedicated one-shot scripts', () => {
  it('run-x-research.sh returns the same contract via the grok wrapper', () => {
    const harness = makeHarness()
    const outcome = runOneShot(harness, [
      'skills/delegate-x-research/scripts/run-x-research.sh',
      '[]',
      'run-test',
    ])
    expect(outcome.status).toBe(0)
    const json = parseRunJson(outcome.stdout)
    expect(json.status).toBe('completed')
    expect(json.content).toContain('x research ok')
    expectRunPaths(json)
    expect(outcome.stderr).toContain('observe_file: ')
  })

  it('run-imagegen.sh returns the same contract via the codex wrapper', () => {
    const harness = makeHarness()
    const outcome = runOneShot(harness, [
      'skills/delegate-imagegen/scripts/run-imagegen.sh',
      '[]',
      'run-test',
    ])
    expect(outcome.status).toBe(0)
    const json = parseRunJson(outcome.stdout)
    expect(json.status).toBe('completed')
    expect(json.content).toContain('imagegen ok')
    expectRunPaths(json)
    expect(outcome.stderr).toContain('observe_file: ')
  })
})
