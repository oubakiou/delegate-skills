import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
