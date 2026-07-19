import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// コミット済み delegate-cli.mjs バンドル単体の起動回帰テスト。
// md2idx の内包 (CLI 自己判定の非発火含む) と self-contained 性を配布物そのものに対して検証する。

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const distPath = path.join(repoRoot, 'shared', 'dist', 'delegate-cli.mjs')

const runBundle = (args: string[], bundlePath = distPath): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [bundlePath, ...args], { encoding: 'utf8' })

describe('delegate-cli bundle', () => {
  it('prints only the version line for --version', () => {
    const result = runBundle(['--version'])
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^delegate-cli \S+\n$/)
    expect(result.stderr).toBe('')
  })

  it('fails closed with exit 2 on an unknown subcommand', () => {
    const result = runBundle(['no-such-subcommand'])
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('unknown subcommand')
  })

  it('runs the bundled md2idx library without firing its CLI entry', () => {
    const result = runBundle(['md2idx-smoke'])
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    const parsed: unknown = JSON.parse(result.stdout)
    expect(parsed).toMatchObject({ index: expect.any(String) })
    expect(parsed).toMatchObject({ section_count: expect.any(Number) })
  })

  it('keeps in-source test branches out of dist', () => {
    const dist = readFileSync(distPath, 'utf8')
    expect(dist).not.toContain('import.meta.vitest')
  })

  it('has no imports beyond node: builtins', () => {
    const dist = readFileSync(distPath, 'utf8')
    const importLines = dist
      .split('\n')
      .filter((line) => /^import[\s'"{]/.test(line) || /^export\s.*\sfrom\s*['"]/.test(line))
    const bare = importLines.filter((line) => !/['"]node:/.test(line))
    expect(bare).toEqual([])
    // 行頭の静的 import 検査は動的解決をすり抜けるため、dynamic import / require も禁止する
    expect(dist).not.toMatch(/\bimport\s*\(/)
    expect(dist).not.toMatch(/\brequire\s*\(/)
  })

  it('starts from an isolated directory without node_modules', () => {
    // リポジトリ内 (.temp/ 含む) だと上位の node_modules で bare import が解決できてしまい
    // 隔離にならないため、この検証に限り OS tmpdir を使う
    const isolatedDir = mkdtempSync(path.join(tmpdir(), 'delegate-cli-isolated-'))
    try {
      const isolatedBundle = path.join(isolatedDir, 'delegate-cli.mjs')
      copyFileSync(distPath, isolatedBundle)
      const version = runBundle(['--version'], isolatedBundle)
      expect(version.status).toBe(0)
      const smoke = runBundle(['md2idx-smoke'], isolatedBundle)
      expect(smoke.status).toBe(0)
      expect(smoke.stderr).toBe('')
    } finally {
      rmSync(isolatedDir, { force: true, recursive: true })
    }
  })
})

describe('delegate-cli subcommand shims', () => {
  const runShim = (
    shimRelPath: string,
    args: string[],
    env: NodeJS.ProcessEnv = {}
  ): SpawnSyncReturns<string> =>
    spawnSync('bash', [path.join(repoRoot, shimRelPath), ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })

  it('resolves models through the shared/ shim with the bash contract', () => {
    const fromDefault = runShim('shared/resolve-model.sh', ['DELEGATE_SHIM_TEST_MODEL', 'haiku'])
    expect(fromDefault.status).toBe(0)
    expect(fromDefault.stdout).toBe('haiku\n')
    const fromEnv = runShim('shared/resolve-model.sh', ['DELEGATE_SHIM_TEST_MODEL', 'haiku'], {
      DELEGATE_SHIM_TEST_MODEL: 'gpt-5.5@high',
    })
    expect(fromEnv.stdout).toBe('gpt-5.5@high\n')
  })

  it('resolves models through the distributed skill copy of the shim', () => {
    const result = runShim(
      'skills/delegate-explore/scripts/resolve-model.sh',
      ['DELEGATE_SHIM_TEST_MODEL', 'haiku'],
      { DELEGATE_SHIM_TEST_MODEL: '' }
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('haiku\n')
  })

  it('preserves whitespace in arguments passed through the shim', () => {
    const result = runShim('shared/check-delegate-chain.sh', ['task type with space', '[]'])
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('["task type with space"]\n')
  })

  it('fails closed with exit 3 when node is missing from PATH', () => {
    const result = spawnSync(
      '/bin/sh',
      [path.join(repoRoot, 'shared', 'resolve-model.sh'), 'DELEGATE_SHIM_TEST_MODEL', 'haiku'],
      { encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent-path-for-test' } }
    )
    expect(result.status).toBe(3)
    expect(result.stderr).toContain('node')
  })

  it('runs directly via its shebang from a spaced directory beside the bundle', () => {
    const isolatedDir = mkdtempSync(path.join(tmpdir(), 'delegate shim spaced '))
    try {
      const shim = path.join(isolatedDir, 'check-delegate-chain.sh')
      copyFileSync(path.join(repoRoot, 'shared', 'check-delegate-chain.sh'), shim)
      copyFileSync(distPath, path.join(isolatedDir, 'delegate-cli.mjs'))
      chmodSync(shim, 0o755)
      const result = spawnSync(shim, ['chore', '["explore"]'], { encoding: 'utf8' })
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('["explore","chore"]\n')
    } finally {
      rmSync(isolatedDir, { force: true, recursive: true })
    }
  })

  it('keeps the check-delegate-chain exit code table through the shim', () => {
    const ok = runShim('shared/check-delegate-chain.sh', ['chore', '["explore"]'])
    expect(ok.status).toBe(0)
    expect(ok.stdout).toBe('["explore","chore"]\n')
    const cycle = runShim('shared/check-delegate-chain.sh', ['explore', '["explore"]'])
    expect(cycle.status).toBe(4)
    expect(cycle.stderr).toContain('委譲チェーン')
    const malformed = runShim('shared/check-delegate-chain.sh', ['explore', 'not-json'])
    expect(malformed.status).toBe(5)
    const usage = runShim('shared/check-delegate-chain.sh', [])
    expect(usage.status).toBe(2)
  })
})
