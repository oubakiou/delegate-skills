import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// shared/ の正本を配布元である各 delegate-* skill へ複製する同期スクリプト。

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// 配布した dest 一覧の記録。正本から削除されたファイルの残骸コピーを
// sync で削除し --check で検知するために使う（コミット対象）。
const MANIFEST_PATH = 'scripts/sync-shared.manifest.json'

// asset（skill 直下へ置く非スクリプト）は明示 allowlist。shared/ 直下の未分類
// ファイルを黙って全 skill へ配布しないための境界で、未分類は fail-closed にする。
const SHARED_ASSETS = new Set(['model-token-prices.json'])

interface TopLevelFiles {
  scripts: string[]
  assets: string[]
}

export const classifyTopLevel = (names: readonly string[]): TopLevelFiles => {
  const sorted = names.toSorted()
  const scripts = sorted.filter((name) => name.endsWith('.sh'))
  const assets = sorted.filter((name) => SHARED_ASSETS.has(name))
  const unknown = sorted.filter((name) => !scripts.includes(name) && !assets.includes(name))
  if (unknown.length > 0) {
    throw new Error(
      `sync-shared: unclassified file(s) under shared/: ${unknown.join(', ')} — ` +
        'add to SHARED_ASSETS to distribute, or move out of shared/'
    )
  }
  return { assets, scripts }
}

// 手書きリストだと shared/ への新規追加が配布から漏れても検知できないため、
// readdir で自動列挙する。
const sharedTopLevelFiles = (): TopLevelFiles =>
  classifyTopLevel(
    readdirSync(path.join(repoRoot, 'shared'), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
  )

const sharedDistFiles = (): string[] => {
  const distDir = path.join(repoRoot, 'shared', 'dist')
  if (!existsSync(distDir)) {
    return []
  }
  return readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .toSorted()
}

const DELEGATE_SKILLS = [
  'delegate-explore',
  'delegate-implement',
  'delegate-chore',
  'delegate-review',
  'delegate-imagegen',
  'delegate-x-research',
  'delegate-htmldoc',
]

interface Pair {
  src: string
  dest: string
}

const pairsForSkill = (skill: string): Pair[] => {
  const { scripts, assets } = sharedTopLevelFiles()
  return [
    ...scripts.map((script) => ({
      dest: path.join('skills', skill, 'scripts', script),
      src: path.join('shared', script),
    })),
    ...sharedDistFiles().map((bundle) => ({
      dest: path.join('skills', skill, 'scripts', bundle),
      src: path.join('shared', 'dist', bundle),
    })),
    ...assets.map((asset) => ({
      dest: path.join('skills', skill, asset),
      src: path.join('shared', asset),
    })),
  ]
}

const pairs = (): Pair[] => DELEGATE_SKILLS.flatMap(pairsForSkill)

export const staleDests = (previous: readonly string[], current: readonly string[]): string[] =>
  previous.filter((dest) => !current.includes(dest)).toSorted()

const readManifest = (): string[] => {
  const manifestPath = path.join(repoRoot, MANIFEST_PATH)
  if (!existsSync(manifestPath)) {
    return []
  }
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
    throw new Error(`sync-shared: ${MANIFEST_PATH} is corrupt (expected a string array)`)
  }
  return parsed
}

const writeManifest = (dests: readonly string[]): void => {
  const manifestPath = path.join(repoRoot, MANIFEST_PATH)
  writeFileSync(manifestPath, `${JSON.stringify(dests.toSorted(), null, 2)}\n`)
}

const copyPair = ({ src, dest }: Pair): void => {
  const content = readFileSync(path.join(repoRoot, src))
  const destPath = path.join(repoRoot, dest)
  mkdirSync(path.dirname(destPath), { recursive: true })
  writeFileSync(destPath, content)
  if (dest.endsWith('.sh')) {
    chmodSync(destPath, 0o755)
  }
}

const removeStaleCopies = (dests: readonly string[]): number => {
  const stale = staleDests(readManifest(), dests)
  for (const dest of stale) {
    rmSync(path.join(repoRoot, dest), { force: true })
  }
  return stale.length
}

const sync = (): void => {
  const currentPairs = pairs()
  for (const pair of currentPairs) {
    copyPair(pair)
  }
  const dests = currentPairs.map((pair) => pair.dest)
  const removed = removeStaleCopies(dests)
  writeManifest(dests)
  process.stdout.write(`sync-shared: synced ${dests.length} file(s), removed ${removed} stale\n`)
}

const findDrift = (): string[] => {
  const drift: string[] = []
  for (const { src, dest } of pairs()) {
    const content = readFileSync(path.join(repoRoot, src))
    const destPath = path.join(repoRoot, dest)
    const same = existsSync(destPath) && readFileSync(destPath).equals(content)
    if (!same) {
      drift.push(dest)
    }
  }
  return drift
}

// manifest が現在の配布集合と一致しない、または正本から消えた配布コピーが
// 残っている場合も drift として扱う。
const findManifestDrift = (): string[] => {
  const dests = pairs().map((pair) => pair.dest)
  const manifest = readManifest()
  const drift: string[] = []
  if (manifest.toSorted().join('\n') !== dests.toSorted().join('\n')) {
    drift.push(MANIFEST_PATH)
  }
  for (const dest of staleDests(manifest, dests)) {
    if (existsSync(path.join(repoRoot, dest))) {
      drift.push(dest)
    }
  }
  return drift
}

// shared/dist が shared/src の再ビルドと一致することも --check に含める。
// コピー同士の byte 比較だけでは「正本 dist 自体が stale」なケースを検知できない。
const checkDistBuild = (): void => {
  const result = spawnSync('bash', ['scripts/check-cli-build.sh'], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error('sync-shared: shared/dist is stale against shared/src')
  }
}

const check = (): void => {
  const drift = [...findDrift(), ...findManifestDrift()]
  if (drift.length > 0) {
    const lines = drift.map((dest) => `  ${dest}`).join('\n')
    throw new Error(
      `sync-shared: drift detected (run \`npm run sync-shared\` to regenerate):\n${lines}`
    )
  }
  checkDistBuild()
  process.stdout.write('sync-shared: no drift\n')
}

if (!import.meta.vitest) {
  if (process.argv.includes('--check')) {
    check()
  } else {
    sync()
  }
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  describe('classifyTopLevel', () => {
    it('splits scripts and allowlisted assets', () => {
      const result = classifyTopLevel(['run.sh', 'model-token-prices.json', 'dispatch.sh'])
      expect(result.scripts).toEqual(['dispatch.sh', 'run.sh'])
      expect(result.assets).toEqual(['model-token-prices.json'])
    })

    it('fails closed on files that are neither scripts nor allowlisted assets', () => {
      expect(() => classifyTopLevel(['run.sh', 'notes.md'])).toThrow(/unclassified/)
      expect(() => classifyTopLevel(['secrets.json'])).toThrow(/secrets\.json/)
    })
  })

  describe('staleDests', () => {
    it('returns previously distributed dests that are no longer managed', () => {
      expect(staleDests(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c'])
      expect(staleDests(['a'], ['a'])).toEqual([])
      expect(staleDests([], ['a'])).toEqual([])
    })
  })

  describe('pairs', () => {
    it('covers every shared file under the distribution tree', () => {
      const result = pairs()
      expect(result.length).toBeGreaterThan(0)
      expect(result.every((pair) => pair.src.startsWith('shared/'))).toBe(true)
      expect(result.every((pair) => pair.dest.startsWith('skills/'))).toBe(true)
      expect(result.some((pair) => pair.dest.endsWith('model-token-prices.json'))).toBe(true)
    })

    it('enumerates shared/ by readdir so new files cannot be missed', () => {
      const result = pairs()
      const { scripts } = sharedTopLevelFiles()
      const observed = result.filter((pair) =>
        pair.dest.includes(path.join('delegate-explore', 'scripts'))
      )
      expect(scripts.length).toBeGreaterThan(0)
      expect(observed.length).toBe(scripts.length + sharedDistFiles().length)
    })

    it('distributes the dist bundle into each skill scripts directory', () => {
      const result = pairs()
      for (const skill of DELEGATE_SKILLS) {
        expect(result).toContainEqual({
          dest: path.join('skills', skill, 'scripts', 'delegate-cli.mjs'),
          src: path.join('shared', 'dist', 'delegate-cli.mjs'),
        })
      }
    })
  })
}
