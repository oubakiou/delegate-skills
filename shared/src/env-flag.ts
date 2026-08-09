import type { Env } from './build-request.ts'

// 既定有効・明示的にのみ無効化できる（opt-out）env flag の判定。wrapper 各所の
// 直書き判定を集約するための中立モジュール（wrapper-common.ts 経由だと
// wrapper-report.ts と循環依存になるため独立させる）
export const envFlagEnabled = (env: Env, name: string): boolean => {
  const value = env[name] ?? ''
  return value !== '0' && value !== 'false' && value !== 'no'
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest

  describe('envFlagEnabled', () => {
    it('treats 0 / false / no as disabled', () => {
      expect(envFlagEnabled({ FLAG: '0' }, 'FLAG')).toBe(false)
      expect(envFlagEnabled({ FLAG: 'false' }, 'FLAG')).toBe(false)
      expect(envFlagEnabled({ FLAG: 'no' }, 'FLAG')).toBe(false)
    })

    it('treats unset and empty as enabled', () => {
      expect(envFlagEnabled({}, 'FLAG')).toBe(true)
      expect(envFlagEnabled({ FLAG: '' }, 'FLAG')).toBe(true)
    })

    it('treats any other value as enabled', () => {
      expect(envFlagEnabled({ FLAG: '1' }, 'FLAG')).toBe(true)
      expect(envFlagEnabled({ FLAG: 'yes' }, 'FLAG')).toBe(true)
      expect(envFlagEnabled({ FLAG: 'FALSE ' }, 'FLAG')).toBe(true)
    })
  })
}
