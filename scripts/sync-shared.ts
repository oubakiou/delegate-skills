import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// shared/ の正本を配布元である各 delegate-* skill へ複製する同期スクリプト。

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const SHARED_SCRIPTS = [
  'resolve-model.sh',
  'check-md2idx.sh',
  'check-delegate-chain.sh',
  'delegate-codex.sh',
  'delegate-claude.sh',
  'prepare.sh',
  'build-request.sh',
  'read-request.sh',
  'build-response.sh',
  'read-response.sh',
]

const SHARED_ASSETS = ['model-token-prices.json']

const DELEGATE_SKILLS = [
  'delegate-explore',
  'delegate-implement',
  'delegate-chore',
  'delegate-review',
  'delegate-imagegen',
  'delegate-x-research',
]

interface Pair {
  src: string
  dest: string
}

const pairs = (): Pair[] => {
  const out: Pair[] = []
  for (const skill of DELEGATE_SKILLS) {
    for (const script of SHARED_SCRIPTS) {
      out.push({
        dest: path.join('skills', skill, 'scripts', script),
        src: path.join('shared', script),
      })
    }
    for (const asset of SHARED_ASSETS) {
      out.push({
        dest: path.join('skills', skill, asset),
        src: path.join('shared', asset),
      })
    }
  }
  return out
}

const sync = (): void => {
  for (const { src, dest } of pairs()) {
    const content = readFileSync(path.join(repoRoot, src))
    const destPath = path.join(repoRoot, dest)
    mkdirSync(path.dirname(destPath), { recursive: true })
    writeFileSync(destPath, content)
    if (dest.endsWith('.sh')) {
      chmodSync(destPath, 0o755)
    }
  }
  process.stdout.write(`sync-shared: synced ${pairs().length} file(s)\n`)
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

const check = (): void => {
  const drift = findDrift()
  if (drift.length > 0) {
    const lines = drift.map((dest) => `  ${dest}`).join('\n')
    throw new Error(
      `sync-shared: drift detected (run \`npm run sync-shared\` to regenerate):\n${lines}`
    )
  }
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
  describe('pairs', () => {
    it('covers every shared file under the distribution tree', () => {
      const result = pairs()
      expect(result).toHaveLength(
        DELEGATE_SKILLS.length * (SHARED_SCRIPTS.length + SHARED_ASSETS.length)
      )
      expect(result.every((pair) => pair.src.startsWith('shared/'))).toBe(true)
      expect(result.every((pair) => pair.dest.startsWith('skills/'))).toBe(true)
      expect(result.some((pair) => pair.dest.endsWith('model-token-prices.json'))).toBe(true)
    })
  })
}
