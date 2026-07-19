import type { CliResult } from './cli-result.ts'

// bash 版 resolve-model.sh と同一契約:
// Usage: resolve-model <TYPE_ENV_NAME> <DEFAULT_MODEL>
// 解決順: env（未設定・空はフォールバック)→ 引数デフォルト。出力はモデル ID + 改行。

const nonEmptyEnvValue = (value: string | null): string | null => {
  if (typeof value === 'string' && value !== '') {
    return value
  }
  return null
}

export const runResolveModel = (
  argv: readonly string[],
  env: Readonly<Partial<Record<string, string>>>
): CliResult => {
  if (argv.length < 2) {
    return {
      exitCode: 2,
      stderr: 'Usage: resolve-model <TYPE_ENV_NAME> <DEFAULT_MODEL>\n',
      stdout: '',
    }
  }
  const [typeEnvName, defaultModel] = argv
  // bash 版の間接展開は不正な変数名で bad substitution (exit 1) になる。契約を揃える
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(typeEnvName)) {
    return {
      exitCode: 1,
      stderr: `ERROR: invalid environment variable name: ${typeEnvName}\n`,
      stdout: '',
    }
  }
  const model = nonEmptyEnvValue(env[typeEnvName] ?? null) ?? defaultModel
  return { exitCode: 0, stderr: '', stdout: `${model}\n` }
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  describe('runResolveModel', () => {
    it('fails closed with exit 2 when arguments are missing', () => {
      for (const argv of [[], ['DELEGATE_EXPLORE_MODEL']]) {
        const result = runResolveModel(argv, {})
        expect(result.exitCode).toBe(2)
        expect(result.stderr).toContain('Usage:')
        expect(result.stdout).toBe('')
      }
    })

    it('falls back to the default when the env var is unset or empty', () => {
      expect(runResolveModel(['DELEGATE_EXPLORE_MODEL', 'haiku'], {}).stdout).toBe('haiku\n')
      expect(
        runResolveModel(['DELEGATE_EXPLORE_MODEL', 'haiku'], { DELEGATE_EXPLORE_MODEL: '' }).stdout
      ).toBe('haiku\n')
    })

    it('fails with exit 1 on an invalid env var name like the bash indirect expansion', () => {
      const result = runResolveModel(['BAD-NAME', 'haiku'], {})
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('BAD-NAME')
    })

    it('prefers the env var over the default, keeping effort suffixes intact', () => {
      const result = runResolveModel(['DELEGATE_IMPLEMENT_MODEL', 'sonnet'], {
        DELEGATE_IMPLEMENT_MODEL: 'gpt-5.5@high',
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('gpt-5.5@high\n')
      expect(result.stderr).toBe('')
    })
  })
}
