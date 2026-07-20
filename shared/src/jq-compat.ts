import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import path from 'node:path'

// bash(jq) 実装と同じ評価規則を共有するためのプリミティブ群。

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// jq の `//` は null と false を「無し」として次候補に落とす
export const jqCoalesce = (...values: unknown[]): unknown => {
  for (const value of values) {
    if (value !== null && value !== false && typeof value !== 'undefined') {
      return value
    }
  }
  return null
}

// jq の `.a.b?` 相当。途中が object でなければ null
export const getPath = (value: unknown, keys: readonly string[]): unknown => {
  let current: unknown = value
  for (const key of keys) {
    if (!isRecord(current)) {
      return null
    }
    current = current[key] ?? null
  }
  return current
}

export const numberOrNull = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return value
  }
  return null
}

export const parseJsonLine = (line: string): unknown => {
  if (line.length === 0) {
    return null
  }
  try {
    return JSON.parse(line)
  } catch {
    // 不正行は skip (jq: try fromjson catch empty)
    return null
  }
}

// jq -R -s + split("\n") + select(object) 相当
export const parseJsonObjects = (text: string): Record<string, unknown>[] => {
  const objects: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    const value = parseJsonLine(line)
    if (isRecord(value)) {
      objects.push(value)
    }
  }
  return objects
}

export const isDirectory = (target: string): boolean => {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

// bash の `[ -s file ]` 相当
export const hasFileContent = (file: string): boolean => {
  try {
    return statSync(file).size > 0
  } catch {
    return false
  }
}

export const readFileOrEmpty = (file: string): string => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

const readDirEntriesOrEmpty = (dir: string): Dirent[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

// find の出力順 (readdir 生順) を保つため sort しない。読めない entry は
// bash 版の `find/xargs 2>/dev/null` と同じく黙って skip する
export const collectJsonlFiles = (dir: string): string[] => {
  const files: string[] = []
  for (const entry of readDirEntriesOrEmpty(dir)) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectJsonlFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(full)
    }
  }
  return files
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  describe('jq compatibility primitives', () => {
    it('coalesces like jq //, treating null and false as absent', () => {
      expect(jqCoalesce(null, false, 0, 'x')).toBe(0)
      expect(jqCoalesce(null, false)).toBeNull()
    })

    it('walks optional paths like .a.b?', () => {
      expect(getPath({ outer: { inner: 5 } }, ['outer', 'inner'])).toBe(5)
      expect(getPath({ outer: 'text' }, ['outer', 'inner'])).toBeNull()
      expect(getPath(null, ['outer'])).toBeNull()
    })

    it('parses JSONL keeping only objects', () => {
      const objects = parseJsonObjects('{"aa":1}\nnot-json\n[1]\n"str"\n\n{"bb":2}')
      expect(objects).toEqual([{ aa: 1 }, { bb: 2 }])
    })
  })
}
