import {
  type Dirent,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { onTestFinished } from 'vitest'
import { isRecord } from './jq-compat.ts'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// test 所有物だけを入れる専用 namespace。削除判定を名前ではなくパスの包含で決めるための境界で、
// AGENTS.md の規約に従って .temp/ 直下へ置かれた手動作業ディレクトリを巻き込まないようにする。
export const TEST_SCRATCH_ROOT = path.join(repoRoot, '.temp', 'test-scratch')

const OWNER_MARKER = '.owner.json'
const DEFAULT_STALE_MS = 60 * 60 * 1000

// 専用 namespace 導入前に .temp/ 直下へ蓄積した残骸を一度だけ回収するための明示 allowlist。
// 恒常経路 (sweepTestScratch) は名前マッチを使わない。
export const LEGACY_TEST_SCRATCH_PREFIXES: readonly string[] = [
  'build-request-test-',
  'build-response-test-',
  'clean-devcontainer-disk-test-',
  'clean-devcontainer-disk-wrapper-test-',
  'codex-devcontainer-test-',
  'delegate-mcp-test-',
  'delegate-run-test-',
  'delegate-wrapper-session-test-',
  'dispatch-test-',
  'observe-effort-test-',
  'observe-followup-test-',
  'observe-lock-test-',
  'observe-store-test-',
  'prepare-imagegen-test-',
  'prepare-test-',
  'read-json-test-',
  'read-request-test-',
  'read-response-test-',
  'read-tail-test-',
  'run-oneshot-test-',
  'wrapper-common-test-',
  'wrapper-cursor-resolver-test-',
  'wrapper-dedicated-test-',
  'wrapper-report-test-',
  'wrapper-wait-test-',
]

const keepScratch = (): boolean => {
  const raw = process.env.KEEP_TEST_SCRATCH ?? ''
  return raw === '1' || raw === 'true' || raw === 'yes'
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM は「別 uid の生存 process」なので alive 扱いにする
    if (isRecord(error)) {
      return error.code === 'EPERM'
    }
    return false
  }
}

// root 自身が symlink だと、配下と判定した entry の実体が namespace の外（例えば
// .temp/delegate/）になる。この場合は削除せず呼び出し元へ委ねる
const assertRealRoot = (root: string): string | null => {
  try {
    if (lstatSync(root).isSymbolicLink()) {
      throw new Error(`test scratch root must not be a symlink: ${root}`)
    }
    return realpathSync(root)
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

// 名前で選んだ entry の実体が root の外を指していないことを確認する。削除自体は
// realpath ではなく lexical path に対して行い、symlink の参照先を消さない
const isContained = (realRoot: string, entry: string): boolean => {
  try {
    return realpathSync(entry).startsWith(realRoot + path.sep)
  } catch {
    return false
  }
}

// ENOENT 以外（EACCES / EIO 等）を空扱いにすると、掃除できていない状態が成功として
// 報告される。呼び出し元の警告経路へ渡すため再送出する
const readDirOrEmpty = (root: string): Dirent[] => {
  try {
    return readdirSync(root, { withFileTypes: true })
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

const removableEntries = (root: string, realRoot: string): Dirent[] =>
  readDirOrEmpty(root).filter(
    (entry) => !entry.isSymbolicLink() && isContained(realRoot, path.join(root, entry.name))
  )

const removeScratch = (target: string): void => {
  if (keepScratch()) {
    process.stderr.write(`KEEP_TEST_SCRATCH: kept ${target}\n`)
    return
  }
  rmSync(target, { force: true, recursive: true })
}

let runDir: string | null = null

const currentRunDir = (): string => {
  if (runDir !== null) {
    return runDir
  }
  mkdirSync(TEST_SCRATCH_ROOT, { recursive: true })
  const dir = mkdtempSync(path.join(TEST_SCRATCH_ROOT, 'run-'))
  writeFileSync(
    path.join(dir, OWNER_MARKER),
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`
  )
  runDir = dir
  return dir
}

export type CleanupRegistrar = (cleanup: () => void) => void

// cleanup 登録を allocation より先に行う。順序を逆にすると、test 文脈外で呼ばれたときに
// run container と marker が残る
export const createScratchDirWith = (prefix: string, register: CleanupRegistrar): string => {
  const created: { dir: string | null } = { dir: null }
  try {
    register(() => {
      if (created.dir !== null) {
        removeScratch(created.dir)
      }
    })
  } catch (error) {
    throw new Error(
      `createTestScratchDir(${prefix}) must be called inside a test body so cleanup can be registered`,
      { cause: error }
    )
  }
  created.dir = mkdtempSync(path.join(currentRunDir(), `${prefix}-`))
  return created.dir
}

/**
 * test scratch ディレクトリを作り、そのテストの終了時に削除されるよう予約する。
 * test 文脈の外では fail-fast する（sweep へ暗黙に委ねると「実行後の増分 0」が静かに破れるため）。
 */
export const createTestScratchDir = (prefix: string): string =>
  createScratchDirWith(prefix, onTestFinished)

/** scratch ディレクトリ内のファイルパスを返す。実体の作成は呼び出し側が行う。 */
export const createTestScratchFile = (prefix: string, name: string): string =>
  path.join(createTestScratchDir(prefix), name)

export interface SweepTestScratchOptions {
  root?: string
  now?: number
  olderThanMs?: number
  isAlive?: (pid: number) => boolean
}

interface StaleCheck {
  dir: string
  now: number
  olderThanMs: number
  isAlive: (pid: number) => boolean
}

const ownerPidOf = (dir: string): number | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(dir, OWNER_MARKER), 'utf8'))
    if (isRecord(parsed) && typeof parsed.pid === 'number' && Number.isInteger(parsed.pid)) {
      if (parsed.pid > 0) {
        return parsed.pid
      }
    }
    return null
  } catch {
    // marker が読めない run は所有者を主張できないので age 条件だけで判定する
    return null
  }
}

const runIsStale = (check: StaleCheck): boolean => {
  const pid = ownerPidOf(check.dir)
  // marker が所有者を主張している run は age を見ない。ディレクトリ mtime は配下の
  // 深い更新では変わらないため、age 単独では生存 session を判別できない
  if (pid !== null) {
    return !check.isAlive(pid)
  }
  try {
    return check.now - statSync(check.dir).mtimeMs >= check.olderThanMs
  } catch {
    return false
  }
}

/**
 * 専用 namespace 配下の stale な run を回収する。marker を持つ run は所有 pid の
 * 生存だけで判定し、marker を持たない run は age で判定する。
 * `olderThanMs: Number.POSITIVE_INFINITY` を渡すと前者だけを対象にできる。
 */
export const sweepTestScratch = (options: SweepTestScratchOptions = {}): number => {
  const root = options.root ?? TEST_SCRATCH_ROOT
  const now = options.now ?? Date.now()
  const olderThanMs = options.olderThanMs ?? DEFAULT_STALE_MS
  const isAlive = options.isAlive ?? pidAlive
  if (keepScratch()) {
    return 0
  }
  const realRoot = assertRealRoot(root)
  if (realRoot === null) {
    return 0
  }
  return removableEntries(root, realRoot)
    .filter((entry) => entry.isDirectory())
    .reduce((removed, entry) => {
      const dir = path.join(root, entry.name)
      if (!runIsStale({ dir, isAlive, now, olderThanMs })) {
        return removed
      }
      rmSync(dir, { force: true, recursive: true })
      return removed + 1
    }, 0)
}

export interface RecoverLegacyOptions {
  root?: string
  prefixes?: readonly string[]
}

/** 専用 namespace 導入前の残骸を、既知 prefix の明示 allowlist に限って回収する。 */
export const recoverLegacyTestScratch = (options: RecoverLegacyOptions = {}): number => {
  const root = options.root ?? path.join(repoRoot, '.temp')
  const prefixes = options.prefixes ?? LEGACY_TEST_SCRATCH_PREFIXES
  if (keepScratch()) {
    return 0
  }
  const realRoot = assertRealRoot(root)
  if (realRoot === null) {
    return 0
  }
  return removableEntries(root, realRoot).reduce((removed, entry) => {
    if (!prefixes.some((prefix) => entry.name.startsWith(prefix))) {
      return removed
    }
    rmSync(path.join(root, entry.name), { force: true, recursive: true })
    return removed + 1
  }, 0)
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  const { existsSync, symlinkSync } = await import('node:fs')

  const isolatedRoot = (): string => createTestScratchDir('test-scratch-isolated')

  interface SeedOptions {
    marker?: string
    mtimeMs?: number
  }

  const seedRun = (root: string, name: string, options: SeedOptions = {}): string => {
    const dir = path.join(root, name)
    mkdirSync(dir, { recursive: true })
    const marker = options.marker ?? ''
    if (marker !== '') {
      writeFileSync(path.join(dir, OWNER_MARKER), marker)
    }
    const mtimeMs = options.mtimeMs ?? 0
    if (mtimeMs > 0) {
      utimesSync(dir, mtimeMs / 1000, mtimeMs / 1000)
    }
    return dir
  }

  const now = 10_000_000

  describe('createTestScratchDir', () => {
    it('creates a unique directory inside the dedicated namespace', () => {
      const first = createTestScratchDir('unit-test')
      const second = createTestScratchDir('unit-test')
      expect(first).not.toBe(second)
      expect(existsSync(first)).toBe(true)
      expect(realpathSync(first).startsWith(realpathSync(TEST_SCRATCH_ROOT) + path.sep)).toBe(true)
    })

    it('leaves no scratch behind when cleanup cannot be registered', () => {
      const before = readdirSync(TEST_SCRATCH_ROOT, { withFileTypes: true }).length
      expect(() =>
        createScratchDirWith('outside-context', () => {
          throw new Error('not inside a test')
        })
      ).toThrow('must be called inside a test body')
      expect(readdirSync(TEST_SCRATCH_ROOT, { withFileTypes: true }).length).toBe(before)
    })

    it('returns a writable path from createTestScratchFile', () => {
      const file = createTestScratchFile('unit-test', 'payload.json')
      writeFileSync(file, '{}\n')
      expect(readFileSync(file, 'utf8')).toBe('{}\n')
      expect(path.basename(file)).toBe('payload.json')
    })
  })

  describe('sweepTestScratch', () => {
    it('removes stale runs and keeps recent ones', () => {
      const root = isolatedRoot()
      seedRun(root, 'run-stale', { mtimeMs: now - 2 * DEFAULT_STALE_MS })
      seedRun(root, 'run-recent', { mtimeMs: now })
      expect(sweepTestScratch({ now, root })).toBe(1)
      expect(existsSync(path.join(root, 'run-stale'))).toBe(false)
      expect(existsSync(path.join(root, 'run-recent'))).toBe(true)
    })

    it('keeps a stale run whose owner pid is still alive', () => {
      const root = isolatedRoot()
      seedRun(root, 'run-live', { marker: '{"pid":4242}\n', mtimeMs: now - 2 * DEFAULT_STALE_MS })
      expect(sweepTestScratch({ isAlive: (pid) => pid === 4242, now, root })).toBe(0)
      expect(existsSync(path.join(root, 'run-live'))).toBe(true)
    })

    it('removes a stale run whose owner pid is gone', () => {
      const root = isolatedRoot()
      seedRun(root, 'run-dead', { marker: '{"pid":4242}\n', mtimeMs: now - 2 * DEFAULT_STALE_MS })
      expect(sweepTestScratch({ isAlive: () => false, now, root })).toBe(1)
      expect(existsSync(path.join(root, 'run-dead'))).toBe(false)
    })

    it('does not follow a symlink that escapes the root', () => {
      const root = isolatedRoot()
      const outside = createTestScratchDir('outside-target')
      writeFileSync(path.join(outside, 'keep.txt'), 'keep\n')
      symlinkSync(outside, path.join(root, 'run-escape'))
      expect(sweepTestScratch({ now, root })).toBe(0)
      expect(existsSync(path.join(outside, 'keep.txt'))).toBe(true)
    })

    it('does not delete through a symlink that stays inside the root', () => {
      const root = isolatedRoot()
      const inside = seedRun(root, 'kept-target', { mtimeMs: 1000 })
      writeFileSync(path.join(inside, 'keep.txt'), 'keep\n')
      symlinkSync(inside, path.join(root, 'run-alias'))
      sweepTestScratch({ now, root })
      expect(existsSync(path.join(root, 'run-alias'))).toBe(true)
    })

    it('refuses to sweep when the root itself is a symlink', () => {
      const base = isolatedRoot()
      const real = path.join(base, 'real')
      mkdirSync(real, { recursive: true })
      seedRun(real, 'run-stale', { mtimeMs: 1000 })
      const link = path.join(base, 'link')
      symlinkSync(real, link)
      expect(() => sweepTestScratch({ now, root: link })).toThrow('must not be a symlink')
      expect(existsSync(path.join(real, 'run-stale'))).toBe(true)
    })

    it('propagates a non-ENOENT readdir failure instead of reporting success', () => {
      const root = isolatedRoot()
      const file = path.join(root, 'not-a-directory')
      writeFileSync(file, '')
      expect(() => sweepTestScratch({ now, root: file })).toThrow()
    })

    it('ignores a marker whose pid is not a positive integer', () => {
      const root = isolatedRoot()
      seedRun(root, 'run-bogus', { marker: '{"pid":-1}\n', mtimeMs: now })
      expect(sweepTestScratch({ isAlive: () => true, now, root })).toBe(0)
      expect(existsSync(path.join(root, 'run-bogus'))).toBe(true)
    })

    it('returns 0 for a missing root and is idempotent', () => {
      const root = path.join(isolatedRoot(), 'absent')
      expect(sweepTestScratch({ root })).toBe(0)
      expect(sweepTestScratch({ root })).toBe(0)
    })

    it('keeps everything when KEEP_TEST_SCRATCH is set', () => {
      const root = isolatedRoot()
      seedRun(root, 'run-stale', { mtimeMs: 1000 })
      process.env.KEEP_TEST_SCRATCH = '1'
      try {
        expect(sweepTestScratch({ now, root })).toBe(0)
      } finally {
        delete process.env.KEEP_TEST_SCRATCH
      }
      expect(existsSync(path.join(root, 'run-stale'))).toBe(true)
    })
  })

  describe('recoverLegacyTestScratch', () => {
    it('removes allowlisted prefixes only', () => {
      const root = isolatedRoot()
      seedRun(root, 'prepare-test-abc')
      seedRun(root, 'delegate')
      seedRun(root, 'unrelated-work')
      writeFileSync(path.join(root, 'notes.md'), 'keep\n')
      expect(recoverLegacyTestScratch({ root })).toBe(1)
      expect(existsSync(path.join(root, 'prepare-test-abc'))).toBe(false)
      expect(existsSync(path.join(root, 'delegate'))).toBe(true)
      expect(existsSync(path.join(root, 'unrelated-work'))).toBe(true)
      expect(existsSync(path.join(root, 'notes.md'))).toBe(true)
    })

    it('removes a matching symlink target only through its own name', () => {
      const root = isolatedRoot()
      const protectedDir = path.join(root, 'delegate')
      mkdirSync(protectedDir, { recursive: true })
      writeFileSync(path.join(protectedDir, 'keep.txt'), 'keep\n')
      symlinkSync(protectedDir, path.join(root, 'prepare-test-link'))
      expect(recoverLegacyTestScratch({ root })).toBe(0)
      expect(existsSync(path.join(protectedDir, 'keep.txt'))).toBe(true)
      expect(existsSync(path.join(root, 'prepare-test-link'))).toBe(true)
    })

    it('keeps the allowlist aligned with the helper prefix convention', () => {
      expect(LEGACY_TEST_SCRATCH_PREFIXES).toContain('delegate-wrapper-session-test-')
      expect(LEGACY_TEST_SCRATCH_PREFIXES.every((prefix) => prefix.endsWith('-'))).toBe(true)
    })
  })
}
