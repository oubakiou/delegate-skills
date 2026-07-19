import { readFileSync } from 'node:fs'
import { md2idx } from 'md2idx'
import { runBuildRequest } from './build-request.ts'
import { runBuildResponse } from './build-response.ts'
import { runCheckDelegateChain } from './check-delegate-chain.ts'
import type { CliResult } from './cli-result.ts'
import { runReadRequest } from './read-request.ts'
import { runReadResponse } from './read-response.ts'
import { runResolveModel } from './resolve-model.ts'

// delegate-cli のバージョン。gh skill publish のリリースタグと同期させる運用は
// 全スクリプト移行完了後に確定する（それまでは 0.0.0-dev のまま）。
export const CLI_VERSION = '0.0.0-dev'

export type { CliResult } from './cli-result.ts'

const versionResult = (): CliResult => ({
  exitCode: 0,
  stderr: '',
  stdout: `delegate-cli ${CLI_VERSION}\n`,
})

// バンドルへの md2idx 内包と CLI 自己判定の非発火を、配布物単体の起動回帰テストで
// 検証するための内部サブコマンド。ユーザー向け契約には含めない。
const md2idxSmokeResult = (): CliResult => {
  const { index, sections } = md2idx('# smoke\n\nbody\n\n## child\n\nbody2\n')
  return {
    exitCode: 0,
    stderr: '',
    stdout: `${JSON.stringify({ index, section_count: sections.length })}\n`,
  }
}

// stdin から本文を受けるサブコマンド。それ以外では stdin を読まない
// (対話起動した delegate-cli --version が入力待ちで止まらないように)
const STDIN_SUBCOMMANDS = new Set(['build-request', 'build-response'])

type SubcommandHandler = (rest: readonly string[], stdin: Buffer) => CliResult

const HANDLERS: Readonly<Partial<Record<string, SubcommandHandler>>> = {
  '--version': () => versionResult(),
  version: () => versionResult(),
  'md2idx-smoke': () => md2idxSmokeResult(),
  'resolve-model': (rest) => runResolveModel(rest, process.env),
  'check-delegate-chain': (rest) => runCheckDelegateChain(rest),
  'build-request': (rest, stdin) => runBuildRequest(rest, process.env, stdin),
  'read-request': (rest) => runReadRequest(rest, process.env),
  'build-response': (rest, stdin) => runBuildResponse(rest, process.env, stdin),
  'read-response': (rest) => runReadResponse(rest, process.env),
}

export const runCli = (argv: readonly string[], stdin: Buffer = Buffer.alloc(0)): CliResult => {
  if (argv.length === 0) {
    return {
      exitCode: 2,
      stderr: 'delegate-cli: missing subcommand (try --version)\n',
      stdout: '',
    }
  }
  const [subcommand, ...rest] = argv
  const handler = HANDLERS[subcommand]
  if (typeof handler !== 'function') {
    return {
      exitCode: 2,
      stderr: `delegate-cli: unknown subcommand: ${subcommand}\n`,
      stdout: '',
    }
  }
  return handler(rest, stdin)
}

if (!import.meta.vitest) {
  const argv = process.argv.slice(2)
  let stdin = Buffer.alloc(0)
  if (typeof argv[0] === 'string' && STDIN_SUBCOMMANDS.has(argv[0])) {
    stdin = readFileSync(0)
  }
  const result = runCli(argv, stdin)
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exitCode = result.exitCode
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  describe('runCli', () => {
    it('prints the version for --version and the version subcommand', () => {
      for (const argv of [['--version'], ['version']]) {
        const result = runCli(argv)
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe(`delegate-cli ${CLI_VERSION}\n`)
        expect(result.stderr).toBe('')
      }
    })

    it('fails closed with exit 2 when no subcommand is given', () => {
      const result = runCli([])
      expect(result.exitCode).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('missing subcommand')
    })

    it('fails closed with exit 2 on an unknown subcommand', () => {
      const result = runCli(['no-such-subcommand'])
      expect(result.exitCode).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('no-such-subcommand')
    })

    it('runs the md2idx library entry in-process', () => {
      const result = runCli(['md2idx-smoke'])
      expect(result.exitCode).toBe(0)
      const parsed: unknown = JSON.parse(result.stdout)
      expect(parsed).toMatchObject({ index: expect.any(String) })
      expect(parsed).toMatchObject({ section_count: expect.any(Number) })
    })
  })
}
