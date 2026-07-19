import type { CliResult } from './cli-result.ts'

// bash 版 check-delegate-chain.sh と同一契約:
// Usage: check-delegate-chain <task_type> <parent_task_type_chain_json>
// チェーンに task_type が既にあれば exit 4（委譲サイクル、fail-closed）。
// 成功時は親チェーン + [task_type] を compact JSON + 改行で stdout へ出力。
// チェーンが JSON 配列でない場合は exit 5（bash 版の jq エラー時と同じ code）。

const failure = (exitCode: number, stderr: string): CliResult => ({
  exitCode,
  stderr,
  stdout: '',
})

const normalizeChain = (rawChain: string): string => {
  if (rawChain === '') {
    return '[]'
  }
  return rawChain
}

// 文字列以外の要素は受理しない。bash(jq) 版は任意 JSON 配列を通したが、数値の
// 表記正規化 (1E-7 → 1e-7 等) で stdout が jq と一致しなくなるため、実運用で
// 文字列 task_type しか流れないチェーンを型で fail-closed に絞る
const parseChain = (rawChain: string): string[] | CliResult => {
  let parsed: unknown = null
  try {
    parsed = JSON.parse(rawChain)
  } catch {
    return failure(5, `ERROR: parent_task_type_chain is not valid JSON: ${rawChain}\n`)
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
    return failure(5, `ERROR: parent_task_type_chain is not a JSON string array: ${rawChain}\n`)
  }
  return parsed.map(String)
}

export const runCheckDelegateChain = (argv: readonly string[]): CliResult => {
  if (argv.length < 2) {
    return failure(2, 'Usage: check-delegate-chain <task_type> <parent_task_type_chain_json>\n')
  }
  const [taskType, rawChainArg] = argv
  const rawChain = normalizeChain(rawChainArg)
  const chain = parseChain(rawChain)
  if (!Array.isArray(chain)) {
    return chain
  }
  if (chain.includes(taskType)) {
    return failure(
      4,
      `ERROR: 委譲チェーンに '${taskType}' が既に存在します（同一種別の多段委譲は禁止）: ${rawChain}\n`
    )
  }
  return {
    exitCode: 0,
    stderr: '',
    stdout: `${JSON.stringify([...chain, taskType])}\n`,
  }
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  describe('runCheckDelegateChain', () => {
    it('fails closed with exit 2 when arguments are missing', () => {
      const result = runCheckDelegateChain(['explore'])
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('Usage:')
    })

    it('appends the task type to the chain and prints compact JSON', () => {
      expect(runCheckDelegateChain(['chore', '["explore"]'])).toEqual({
        exitCode: 0,
        stderr: '',
        stdout: '["explore","chore"]\n',
      })
      expect(runCheckDelegateChain(['explore', '[]']).stdout).toBe('["explore"]\n')
      expect(runCheckDelegateChain(['explore', '']).stdout).toBe('["explore"]\n')
    })

    it('fails closed with exit 4 on a delegation cycle', () => {
      const result = runCheckDelegateChain(['explore', '["explore"]'])
      expect(result.exitCode).toBe(4)
      expect(result.stderr).toContain("委譲チェーンに 'explore' が既に存在します")
      expect(result.stdout).toBe('')
    })

    it('fails closed with exit 5 on malformed chains, matching the bash jq behavior', () => {
      expect(runCheckDelegateChain(['explore', 'not-json']).exitCode).toBe(5)
      expect(runCheckDelegateChain(['explore', '{}']).exitCode).toBe(5)
      expect(runCheckDelegateChain(['explore', 'not-json']).stdout).toBe('')
    })

    it('fails closed with exit 5 on non-string chain elements', () => {
      const result = runCheckDelegateChain(['explore', '[1e-7, "chore"]'])
      expect(result.exitCode).toBe(5)
      expect(result.stderr).toContain('not a JSON string array')
    })
  })
}
