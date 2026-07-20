import { lstatSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import path from 'node:path'

// bash 版 observe-json.sh の symlink lock と同一プロトコル。
// `ln -s` / fs.symlinkSync の atomic な作成が取得そのもので、target に保持者
// "<pid> <token>" を埋め込む。取得と owner 公開が単一操作のため無所有の窓が無い。
// 停止した保持者の回収は reap mutex の中でのみ行う (詳細は bash 版のコメント参照)。

export const observeLockPath = (observeFile: string, runDir: string): string =>
  path.join(runDir, `${path.basename(observeFile).replace(/\.json$/, '')}.lock`)

const DEFAULT_LOCK_TIMEOUT_SECONDS = 30

const lockTimeoutSeconds = (env: Readonly<Partial<Record<string, string>>>): number => {
  const value = env.DELEGATE_OBSERVE_LOCK_TIMEOUT_SECONDS ?? ''
  if (!/^[0-9]+$/.test(value)) {
    return DEFAULT_LOCK_TIMEOUT_SECONDS
  }
  return Number(value)
}

const sleepMs = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const readlinkOrNull = (target: string): string | null => {
  try {
    return readlinkSync(target)
  } catch {
    return null
  }
}

const errorCode = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error
    if (typeof code === 'string') {
      return code
    }
  }
  return ''
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM はプロセス存在。delegate プロセス群は同一ユーザー前提なので通常発生しない
    return errorCode(error) === 'EPERM'
  }
}

// 非 symlink の残骸 (旧 flock ファイル等) も検出するため lstat で確認する
const lockEntryExists = (target: string): boolean => {
  try {
    lstatSync(target)
    return true
  } catch {
    return false
  }
}

const removeQuietly = (target: string): void => {
  try {
    rmSync(target, { force: true })
  } catch {
    // 除去失敗は次の周回・bounded wait に委ねる
  }
}

const tryCreateLock = (lockPath: string, owner: string): boolean => {
  try {
    symlinkSync(owner, lockPath)
    return true
  } catch {
    return false
  }
}

const ownerPidAlive = (owner: string): boolean => {
  const pid = Number(owner.split(' ')[0])
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  return pidAlive(pid)
}

// 保持者 pid が死んでいる lock と symlink でない残骸を、reap mutex の中で
// 再検証してから除去する。mutex 下では lock path の除去者が他に存在しないため
// 再検証 → rm が race-free になる
const reapUnderMutex = (lockPath: string): void => {
  const current = readlinkOrNull(lockPath)
  if (current !== null) {
    if (!ownerPidAlive(current)) {
      removeQuietly(lockPath)
    }
  } else if (lockEntryExists(lockPath)) {
    // symlink でない残骸 (旧実装の flock ファイル等) は保持者を持たないので除去する
    removeQuietly(lockPath)
  }
}

const tryReapStale = (lockPath: string): void => {
  const sampled = readlinkOrNull(lockPath)
  if (sampled !== null && ownerPidAlive(sampled)) {
    return
  }
  if (sampled === null && !lockEntryExists(lockPath)) {
    return
  }
  const reapLock = `${lockPath}.reap`
  if (!tryCreateLock(reapLock, `${process.pid} reap`)) {
    return
  }
  reapUnderMutex(lockPath)
  removeQuietly(reapLock)
}

const spinForLock = (lockPath: string, owner: string, timeoutMs: number): boolean => {
  const startedAt = Date.now()
  for (;;) {
    if (tryCreateLock(lockPath, owner)) {
      return true
    }
    tryReapStale(lockPath)
    if (Date.now() - startedAt >= timeoutMs) {
      return false
    }
    sleepMs(50)
  }
}

export const acquireObserveLock = (
  lockPath: string,
  env: Readonly<Partial<Record<string, string>>> = process.env
): string => {
  const token = `${process.pid}-${Math.floor(Math.random() * 1e9)}`
  if (!spinForLock(lockPath, `${process.pid} ${token}`, lockTimeoutSeconds(env) * 1000)) {
    throw new Error(`observe lock acquisition timed out: ${lockPath}`)
  }
  return token
}

export const releaseObserveLock = (lockPath: string, token: string): void => {
  if (readlinkOrNull(lockPath) === `${process.pid} ${token}`) {
    removeQuietly(lockPath)
  }
}

export const withObserveLock = <ResultType>(
  observeFile: string,
  runDir: string,
  operation: () => ResultType
): ResultType => {
  const lockPath = observeLockPath(observeFile, runDir)
  const token = acquireObserveLock(lockPath)
  try {
    return operation()
  } finally {
    releaseObserveLock(lockPath, token)
  }
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  describe('observe lock path', () => {
    it('derives the lock path beside the observe file', () => {
      expect(observeLockPath('/w/run_observe.json', '/w')).toBe('/w/run_observe.lock')
    })

    it('detects non-symlink leftovers via lstat', () => {
      expect(lockEntryExists('/nonexistent-lock-path')).toBe(false)
    })
  })
}
