import { readFileSync } from 'node:fs'
import path from 'node:path'
import { md2idx } from 'md2idx'
import { runBuildRequest } from './build-request.ts'
import { runBuildResponse } from './build-response.ts'
import { runCheckDelegateChain } from './check-delegate-chain.ts'
import type { CliResult } from './cli-result.ts'
import { runDispatch } from './dispatch.ts'
import { runPrepareImagegen } from './prepare-imagegen.ts'
import { runPrepare } from './prepare.ts'
import { runReadRequest } from './read-request.ts'
import { runReadResponse } from './read-response.ts'
import { runResolveModel } from './resolve-model.ts'
import { runRun, runRunImagegen, runRunXResearch, type OneShotIo } from './run-oneshot.ts'
import { runWrapperClaude } from './wrapper-claude.ts'
import { runWrapperCodex } from './wrapper-codex.ts'
import { runWrapperCursor } from './wrapper-cursor.ts'
import { runWrapperDevin } from './wrapper-devin.ts'
import { runWrapperImagegen } from './wrapper-imagegen.ts'
import { runWrapperXresearch } from './wrapper-xresearch.ts'

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

// stdin (本文 Markdown) は handler が必要になった時点で読む遅延渡し。
// bash 版と同じく引数エラーは stdin を消費せず即 exit 2 になり、
// 対話起動した delegate-cli --version 等も入力待ちで止まらない
const EMPTY_STDIN = (): Buffer => Buffer.alloc(0)

// build-request / build-response は Buffer 契約 (prepare が in-process で本文を渡す) の
// ため、bash 版が usage 検証後に cat していたのと同じ順序を main 側で再現する
const stdinForMinArgs = (
  readStdin: () => Buffer,
  args: { rest: readonly string[]; minArgs: number }
): Buffer => {
  if (args.rest.length < args.minArgs) {
    return Buffer.alloc(0)
  }
  return readStdin()
}

// dispatch / run は同ディレクトリの backend wrapper .sh を bash で起動する。
// 配布形態ではバンドルと wrapper が同 dir に並び、リポジトリ正本ではバンドルが
// shared/dist/ 配下にあるため dist の親 (shared/) を scripts dir とみなす
const scriptsDirOf = (entry: string): string => {
  const dir = path.dirname(path.resolve(entry))
  if (path.basename(dir) === 'dist') {
    return path.dirname(dir)
  }
  return dir
}

const oneShotIo = (): OneShotIo => ({
  scriptsDir: scriptsDirOf(process.argv[1] ?? '.'),
  writeStderr: (text: string): void => {
    process.stderr.write(text)
  },
})

// backend wrapper は `wrapper <backend> <args...>` の 2 語で選択する（shim が固定で渡す）
const WRAPPER_BACKENDS: Readonly<
  Partial<
    Record<
      string,
      (
        argv: readonly string[],
        env: NodeJS.ProcessEnv,
        io: { scriptsDir: string }
      ) => Promise<CliResult>
    >
  >
> = {
  claude: runWrapperClaude,
  codex: runWrapperCodex,
  cursor: runWrapperCursor,
  devin: runWrapperDevin,
  imagegen: runWrapperImagegen,
  xresearch: runWrapperXresearch,
}

const runWrapperBackend = async (rest: readonly string[]): Promise<CliResult> => {
  const [backendName, ...wrapperArgv] = rest
  const backendRunner = WRAPPER_BACKENDS[backendName ?? '']
  if (typeof backendRunner !== 'function') {
    return {
      exitCode: 2,
      stderr: `delegate-cli: unknown wrapper backend: ${backendName ?? ''}\n`,
      stdout: '',
    }
  }
  return backendRunner(wrapperArgv, process.env, {
    scriptsDir: scriptsDirOf(process.argv[1] ?? '.'),
  })
}

type SubcommandHandler = (
  rest: readonly string[],
  readStdin: () => Buffer
) => CliResult | Promise<CliResult>

const HANDLERS: Readonly<Partial<Record<string, SubcommandHandler>>> = {
  '--version': () => versionResult(),
  version: () => versionResult(),
  'md2idx-smoke': () => md2idxSmokeResult(),
  'resolve-model': (rest) => runResolveModel(rest, process.env),
  'check-delegate-chain': (rest) => runCheckDelegateChain(rest),
  'build-request': (rest, readStdin) =>
    runBuildRequest(rest, process.env, stdinForMinArgs(readStdin, { rest, minArgs: 4 })),
  'read-request': (rest) => runReadRequest(rest, process.env),
  'build-response': (rest, readStdin) =>
    runBuildResponse(rest, process.env, stdinForMinArgs(readStdin, { rest, minArgs: 3 })),
  'read-response': (rest) => runReadResponse(rest, process.env),
  prepare: (rest, readStdin) => runPrepare(rest, process.env, readStdin),
  'prepare-imagegen': (rest, readStdin) => runPrepareImagegen(rest, process.env, readStdin),
  dispatch: (rest) =>
    runDispatch(rest, process.env, { scriptsDir: scriptsDirOf(process.argv[1] ?? '.') }),
  run: (rest, readStdin) => runRun(rest, { env: process.env, io: oneShotIo() }, readStdin),
  'run-imagegen': (rest, readStdin) =>
    runRunImagegen(rest, { env: process.env, io: oneShotIo() }, readStdin),
  'run-x-research': (rest, readStdin) =>
    runRunXResearch(rest, { env: process.env, io: oneShotIo() }, readStdin),
  wrapper: async (rest) => runWrapperBackend(rest),
}

export const runCli = async (
  argv: readonly string[],
  readStdin: () => Buffer = EMPTY_STDIN
): Promise<CliResult> => {
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
  return handler(rest, readStdin)
}

if (!import.meta.vitest) {
  const argv = process.argv.slice(2)
  const result = await runCli(argv, () => readFileSync(0))
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exitCode = result.exitCode
}

// in-source test 専用 helper (bundle からは treeshake で除去される)
const explodingStdin = (): Buffer => {
  throw new Error('stdin must not be read before argv validation')
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  describe('runCli', () => {
    it('prints the version for --version and the version subcommand', async () => {
      for (const argv of [['--version'], ['version']]) {
        // eslint-disable-next-line no-await-in-loop -- 2 ケースの逐次検証
        const result = await runCli(argv)
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe(`delegate-cli ${CLI_VERSION}\n`)
        expect(result.stderr).toBe('')
      }
    })

    it('fails closed with exit 2 when no subcommand is given', async () => {
      const result = await runCli([])
      expect(result.exitCode).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('missing subcommand')
    })

    it('fails closed with exit 2 on an unknown subcommand', async () => {
      const result = await runCli(['no-such-subcommand'])
      expect(result.exitCode).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('no-such-subcommand')
    })

    it('does not read stdin before argv validation like the bash originals', async () => {
      const argvCases: string[][] = [
        ['prepare'],
        ['prepare', 'chore', 'E', 'haiku', '[]', 'sid', 'bogus-mode'],
        ['prepare-imagegen'],
        ['run'],
        ['run-imagegen'],
        ['run-x-research'],
        ['build-request'],
        ['build-response'],
        ['--version'],
      ]
      for (const argv of argvCases) {
        // eslint-disable-next-line no-await-in-loop -- ケースごとの逐次検証
        const result = await runCli(argv, explodingStdin)
        expect(result.exitCode).toBeLessThanOrEqual(2)
      }
    })

    it('runs the md2idx library entry in-process', async () => {
      const result = await runCli(['md2idx-smoke'])
      expect(result.exitCode).toBe(0)
      const parsed: unknown = JSON.parse(result.stdout)
      expect(parsed).toMatchObject({ index: expect.any(String) })
      expect(parsed).toMatchObject({ section_count: expect.any(Number) })
    })
  })
}
