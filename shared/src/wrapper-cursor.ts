import { spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Env } from './build-request.ts'
import type { CliResult } from './cli-result.ts'
import { mcpExtractCursorGlobal, mcpHasServers, mcpRenderCursorMcpJson } from './delegate-mcp.ts'
import { effortFromCursorConfig } from './observe-effort.ts'
import { hasFileContent } from './jq-compat.ts'
import { resumeUnavailable, updateMcpConfig } from './observe-store.ts'
import { usageFromCapture } from './observe-usage.ts'
import { promptConstraints } from './prompt-constraints.ts'
import {
  completeResponse,
  effortFailure,
  finalizeResponse,
  finishWithoutChild,
  makeWrapperContext,
  parseWrapperArgs,
  quietly,
  recordFollowupOutcome,
  recordResumableOutcome,
  recordUsageAndEffort,
  reportMdTailLines,
  responderSessionIdOf,
  workerPrompt,
  wrapperResult,
  writePromptFile,
  type WrapperContext,
} from './wrapper-common.ts'
import { reportModeForBackend, requestPromptStep } from './wrapper-report.ts'
import {
  executableIn,
  executablePaths,
  spawnWorker,
  waitWithHeartbeat,
  type WaitResult,
} from './wrapper-wait.ts'

// bash 版 delegate-cursor.sh と同一契約の composer-* / cursor-* モデル向け
// Cursor agent CLI 子プロセス起動ラッパ。
// stdout: response_file のパスのみ（本文は親 context に入れない）

const stripCursorPrefix = (baseModel: string): string => {
  if (baseModel.startsWith('cursor-')) {
    return baseModel.slice('cursor-'.length)
  }
  return baseModel
}

const cursorAgentVersionPattern = /^\d{4}\.\d{2}\.\d{2}-[0-9a-zA-Z]+$/

// 候補は未検証のバイナリなので、SIGTERM を無視されても timeout で確実に戻れるよう
// SIGKILL で打ち切る。timeout 到達（error あり）は stdout が有効形式でも不合格にする
const cursorAgentVersionIsValid = (candidate: string, env: Env, timeoutMs: number): boolean => {
  const result = spawnSync(candidate, ['--version'], {
    encoding: 'utf8',
    env: { ...env },
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  })
  return (
    !result.error &&
    result.status === 0 &&
    cursorAgentVersionPattern.test((result.stdout ?? '').trim())
  )
}

const cursorAgentCandidates = (env: Env): string[] => {
  const candidates = executablePaths('agent', env)
  const home = env.HOME ?? ''
  if (home !== '') {
    const fallback = path.resolve(home, '.local', 'bin', 'agent')
    if (!candidates.includes(fallback) && executableIn(path.dirname(fallback), 'agent')) {
      candidates.push(fallback)
    }
  }
  return candidates
}

const resolveCursorAgent = (env: Env, timeoutMs = 10_000): string | null => {
  for (const candidate of cursorAgentCandidates(env)) {
    if (cursorAgentVersionIsValid(candidate, env, timeoutMs)) {
      return candidate
    }
  }
  return null
}

// 検証済みの effort を CLI model 名へ変換するモデル別テーブル。方式が分かれるのは
// Cursor catalog 側が parameterized model かどうかに従うため:
// glm-5.2 は parameterized で bracket override（glm-5.2[reasoning=<v>]）を受理し、
// grok-4.5 は bracket を受理せず catalog の effort 別 slug（cursor-grok-4.5-<v>）のみ
// 通る。CLI model 名は base model と一致しない場合がある
const cursorCliModelOf = (context: WrapperContext, model: string): string | CliResult => {
  if (context.effort === '') {
    return model
  }
  if (model === 'glm-5.2') {
    return `glm-5.2[reasoning=${context.effort}]`
  }
  if (model === 'grok-4.5') {
    return `cursor-grok-4.5-${context.effort}`
  }
  return finishWithoutChild(
    context,
    6,
    `ERROR: no bracket override mapping for cursor model '${context.args.originalModel}'`
  )
}

// Cursor agent CLI は起動時に <config dir>/cli-config.json を tmp ファイル + rename で
// 書き換えるため、共有 config のままだと並列 dispatch 同士で rename が競合し
// 片方が ENOENT で即死し得る。CURSOR_CONFIG_DIR を run_dir 配下へ隔離し、
// authInfo を含む既存 cli-config.json をコピーしてログインを維持する
// （codex backend の CODEX_HOME 隔離と対称）。config dir の解決順
// （CURSOR_CONFIG_DIR → XDG_CONFIG_HOME/cursor → ~/.cursor）は CLI 本体と揃える。
// CURSOR_CONFIG_DIR 未対応の古い CLI では無視され、従来の共有 config 動作になる
const realCursorConfigDirOf = (env: Env): string => {
  const configured = env.CURSOR_CONFIG_DIR ?? ''
  if (configured !== '') {
    return configured
  }
  const xdg = env.XDG_CONFIG_HOME ?? ''
  if (xdg !== '') {
    return path.join(xdg, 'cursor')
  }
  return path.join(env.HOME ?? '', '.cursor')
}

const isolateCursorConfig = (context: WrapperContext): string => {
  const isolated = path.join(context.workDir, 'cursor-config')
  mkdirSync(isolated, { recursive: true })
  const realConfig = path.join(realCursorConfigDirOf(context.env), 'cli-config.json')
  quietly(() => {
    if (hasFileContent(realConfig)) {
      copyFileSync(realConfig, path.join(isolated, 'cli-config.json'))
    }
  })
  return isolated
}

interface CursorMcp {
  source: 'injected' | 'none'
  servers: string[]
}

const setupCursorMcp = (context: WrapperContext, isolatedConfigDir: string): CursorMcp => {
  const canonical = mcpExtractCursorGlobal(
    path.join(realCursorConfigDirOf(context.env), 'mcp.json')
  )
  if (mcpHasServers(canonical)) {
    writeFileSync(path.join(isolatedConfigDir, 'mcp.json'), mcpRenderCursorMcpJson(canonical))
    return { source: 'injected', servers: Object.keys(canonical) }
  }
  return { source: 'none', servers: [] }
}

// cursor-agent の create-chat は起動途中で racy に停止し、stdin を /dev/null に
// 固定していても無応答の孤児プロセスとして残り得る。正常応答は 2〜5 秒で返るため、
// timeout で打ち切って最大 3 回まで再試行する
const createChatOnce = (
  context: WrapperContext,
  isolatedConfigDir: string,
  agentPath: string
): string => {
  const attempt = spawnSync('timeout', ['-k', '5', '45', agentPath, 'create-chat'], {
    encoding: 'utf8',
    env: {
      ...context.env,
      CURSOR_CONFIG_DIR: isolatedConfigDir,
      TMPDIR: path.join(context.workDir, 'tmp'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  quietly(() => {
    appendFileSync(path.join(context.workDir, 'cursor-create-chat.stderr'), attempt.stderr ?? '')
  })
  // 失敗時の stdout は診断出力の可能性があり chat id として信用できない
  if (attempt.status !== 0) {
    return ''
  }
  const lines = (attempt.stdout ?? '').trimEnd().split('\n')
  return lines[lines.length - 1].replaceAll('\r', '')
}

const createCursorChat = (
  context: WrapperContext,
  isolatedConfigDir: string,
  agentPath: string
): string => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const chatId = createChatOnce(context, isolatedConfigDir, agentPath)
    if (chatId !== '') {
      return chatId
    }
  }
  return ''
}

const setupCursorChat = (
  context: WrapperContext,
  isolatedConfigDir: string,
  agentPath: string
): string | CliResult => {
  const { sessionMode, resumeArg } = context.args
  if (sessionMode === 'followup') {
    return resumeArg
  }
  if (sessionMode !== 'resumable') {
    return ''
  }
  const chatId = createCursorChat(context, isolatedConfigDir, agentPath)
  if (chatId === '') {
    quietly(() => {
      resumeUnavailable(context.args.observeFile, context.workDir, {
        backend: context.backend,
        model: context.args.originalModel,
        reason: 'Cursor create-chat failed',
        homeDir: '',
      })
    })
    return finishWithoutChild(context, 5, 'ERROR: agent create-chat failed.')
  }
  return chatId
}

const cursorSessionModeFailure = (context: WrapperContext): CliResult | null => {
  const { sessionMode, resumeArg } = context.args
  if (sessionMode === 'followup' && resumeArg === '') {
    return finishWithoutChild(context, 5, 'ERROR: follow-up requires resume_id.')
  }
  if (sessionMode !== '' && sessionMode !== 'resumable' && sessionMode !== 'followup') {
    return finishWithoutChild(
      context,
      2,
      `ERROR: session_mode must be empty, resumable, or followup: ${sessionMode}`
    )
  }
  return null
}

// stream-json は最終 result イベントに実測 usage を含み、イベントが逐次流れるため
// stream 無変化ベースの stall 検出も機能する（text モードは応答完了まで無音）
const cursorCliArgs = (
  cursorCliModel: string,
  session: { mcpSource: string; chatId: string }
): string[] => {
  const args = ['-p', '--trust', '--force', '--model', cursorCliModel]
  args.push('--output-format', 'stream-json')
  if (session.mcpSource === 'injected') {
    args.push('--approve-mcps')
  }
  if (session.chatId !== '') {
    args.push('--resume', session.chatId)
  }
  return args
}

const recordCursorSessionOutcome = (
  context: WrapperContext,
  chatId: string,
  outcome: { childStatus: number; responseAllowsResume: boolean }
): void => {
  if (context.args.sessionMode === 'resumable') {
    recordResumableOutcome(context, {
      childStatus: outcome.childStatus,
      responseAllowsResume: outcome.responseAllowsResume,
      resumeId: chatId,
      resumeSource: 'cursor_create_chat',
      homeDir: '',
      failReason: 'Cursor run did not complete successfully',
      missingIdReason: 'Cursor run did not complete successfully',
    })
    return
  }
  if (context.args.sessionMode === 'followup') {
    recordFollowupOutcome(context, {
      childStatus: outcome.childStatus,
      responseAllowsResume: outcome.responseAllowsResume,
      resumeId: chatId,
      resumeSource: 'cursor_create_chat',
      homeDir: '',
      failReason: 'Cursor follow-up did not complete successfully',
    })
  }
}

interface CursorRun {
  agentPath: string
  cursorModel: string
  cursorCliModel: string
  isolatedConfigDir: string
  chatId: string
  reportFile: string
}

const finalizeCursorRun = (
  context: WrapperContext,
  run: CursorRun,
  wait: WaitResult
): CliResult => {
  completeResponse(
    context,
    {
      responderSessionId: responderSessionIdOf(context, run.cursorModel),
      reportMode: reportModeForBackend('cursor'),
      reportFile: run.reportFile,
    },
    wait
  )
  const outcome = finalizeResponse(context, wait.childStatus)
  recordUsageAndEffort(context, {
    usageSource: 'cursor_json',
    measuredUsage: () =>
      usageFromCapture(context.stdoutCapture, {
        model: context.args.originalModel,
        backend: context.backend,
        source: 'cursor_json',
      }),
    effortRequested: context.effort,
    effortEffective: () =>
      effortFromCursorConfig(run.cursorModel, path.join(run.isolatedConfigDir, 'cli-config.json')),
  })
  recordCursorSessionOutcome(context, run.chatId, {
    childStatus: wait.childStatus,
    responseAllowsResume: outcome.responseAllowsResume,
  })
  return wrapperResult(context, outcome)
}

const runCursorChild = async (
  context: WrapperContext,
  run: CursorRun,
  mcp: CursorMcp
): Promise<CliResult> => {
  const requestStep = requestPromptStep(context.args.requestFile, {
    scriptsDir: context.scriptsDir,
    env: context.env,
  })
  const prompt = workerPrompt(context, requestStep.step, {
    constraints: promptConstraints(context.args.taskType, run.reportFile),
    tailLines: reportMdTailLines(run.reportFile),
  })
  const promptFile = writePromptFile(context, prompt)
  quietly(() => {
    updateMcpConfig(context.args.observeFile, context.workDir, {
      source: mcp.source,
      servers: mcp.servers,
    })
  })
  const worker = spawnWorker({
    command: run.agentPath,
    args: cursorCliArgs(run.cursorCliModel, { mcpSource: mcp.source, chatId: run.chatId }),
    cwd: context.repoRoot,
    env: {
      ...context.env,
      CURSOR_CONFIG_DIR: run.isolatedConfigDir,
      TMPDIR: path.join(context.workDir, 'tmp'),
    },
    stdinFile: promptFile,
    stdoutCapture: context.stdoutCapture,
    stderrCapture: context.stderrCapture,
  })
  const wait = await waitWithHeartbeat({
    observeFile: context.args.observeFile,
    runDir: context.workDir,
    backend: context.backend,
    worker,
    stdoutCapture: context.stdoutCapture,
    stderrCapture: context.stderrCapture,
    responseFile: context.args.responseFile,
    env: context.env,
  })
  return finalizeCursorRun(context, run, wait)
}

interface CursorModels {
  cursorModel: string
  cursorCliModel: string
}

const cursorModelsOf = (context: WrapperContext): CursorModels | CliResult => {
  const cursorModel = stripCursorPrefix(context.baseModel)
  const cursorCliModel = cursorCliModelOf(context, cursorModel)
  if (typeof cursorCliModel !== 'string') {
    return cursorCliModel
  }
  return { cursorModel, cursorCliModel }
}

const cursorPreflight = (context: WrapperContext): CursorModels | CliResult => {
  const effortError = effortFailure(context)
  if (effortError !== null) {
    return effortError
  }
  const models = cursorModelsOf(context)
  if ('exitCode' in models) {
    return models
  }
  const modeFailure = cursorSessionModeFailure(context)
  if (modeFailure !== null) {
    return modeFailure
  }
  return models
}

const launchCursor = async (
  context: WrapperContext,
  models: CursorModels,
  agentPath: string
): Promise<CliResult> => {
  const isolatedConfigDir = isolateCursorConfig(context)
  const mcp = setupCursorMcp(context, isolatedConfigDir)
  const chatId = setupCursorChat(context, isolatedConfigDir, agentPath)
  if (typeof chatId !== 'string') {
    return chatId
  }
  return runCursorChild(
    context,
    {
      ...models,
      agentPath,
      isolatedConfigDir,
      chatId,
      reportFile: path.join(context.args.runDir, 'report.md'),
    },
    mcp
  )
}

const wrapperCursorWithContext = async (context: WrapperContext): Promise<CliResult> => {
  const models = cursorPreflight(context)
  if ('exitCode' in models) {
    return models
  }
  const agentPath = resolveCursorAgent(context.env)
  if (agentPath === null) {
    return finishWithoutChild(
      context,
      3,
      'ERROR: Cursor agent CLI が見つからない(PATH 上の `agent` は別 CLI の可能性があります)。'
    )
  }
  return launchCursor(context, models, agentPath)
}

export const runWrapperCursor = async (
  argv: readonly string[],
  env: Env,
  io: { scriptsDir: string }
): Promise<CliResult> => {
  const args = parseWrapperArgs(argv, 'delegate-cursor.sh')
  if ('exitCode' in args) {
    return args
  }
  const context = makeWrapperContext(args, { env, scriptsDir: io.scriptsDir })
  return wrapperCursorWithContext(context)
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  const { chmodSync } = await import('node:fs')
  const { createTestScratchDir } = await import('./test-scratch.ts')

  const makeResolverTestDir = (): string => createTestScratchDir('wrapper-cursor-resolver-test')

  const writeAgentScript = (dir: string, script: string): string => {
    mkdirSync(dir, { recursive: true })
    const agent = path.join(dir, 'agent')
    writeFileSync(agent, script)
    chmodSync(agent, 0o755)
    return agent
  }

  const writeAgent = (dir: string, version: string): string =>
    writeAgentScript(dir, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`)

  describe('resolveCursorAgent', () => {
    it('skips a different CLI and returns the first valid Cursor agent path', () => {
      const dir = makeResolverTestDir()
      const wrong = writeAgent(path.join(dir, 'wrong'), 'grok 0.2.73 (9ff14c43bb) [stable]')
      const valid = writeAgent(path.join(dir, 'valid'), '2026.07.16-899851b')
      expect(
        resolveCursorAgent({
          HOME: path.join(dir, 'home'),
          PATH: `${path.dirname(wrong)}:${path.dirname(valid)}`,
        })
      ).toBe(path.resolve(valid))
    })

    it('uses the known local install path when PATH has no valid candidate', () => {
      const dir = makeResolverTestDir()
      const home = path.join(dir, 'home')
      const valid = writeAgent(path.join(home, '.local', 'bin'), '2026.07.16-899851b')
      expect(resolveCursorAgent({ HOME: home, PATH: path.join(dir, 'empty') })).toBe(
        path.resolve(valid)
      )
    })

    it('rejects candidates whose version output is not a Cursor version', () => {
      const dir = makeResolverTestDir()
      const invalid = writeAgent(path.join(dir, 'invalid'), 'agent version 1.0')
      expect(resolveCursorAgent({ PATH: path.dirname(invalid) })).toBeNull()
    })

    it('rejects a SIGTERM-ignoring candidate within the timeout even if stdout looks valid', () => {
      const dir = makeResolverTestDir()
      const agent = writeAgentScript(
        path.join(dir, 'stubborn'),
        `#!/bin/sh\ntrap '' TERM\nprintf '%s\\n' '2026.07.16-899851b'\nsleep 60\n`
      )
      const startedAt = Date.now()
      expect(resolveCursorAgent({ PATH: path.dirname(agent) }, 500)).toBeNull()
      expect(Date.now() - startedAt).toBeLessThan(10_000)
    })
  })

  describe('cursorCliModelOf', () => {
    // 実フローと同じく stripCursorPrefix 済みの base model を渡して変換結果だけを見る
    const cliModelFor = (originalModel: string): string | CliResult => {
      const dir = makeResolverTestDir()
      const args = parseWrapperArgs(
        [
          originalModel,
          'implement',
          path.join(dir, 'delegate_implement_x_req.json'),
          path.join(dir, 'delegate_implement_x_res.json'),
          dir,
          path.join(dir, 'delegate_implement_x_observe.json'),
        ],
        'delegate-cursor.sh'
      )
      if ('exitCode' in args) {
        throw new Error('unexpected wrapper args failure')
      }
      const context = makeWrapperContext(args, { env: {}, scriptsDir: dir })
      return cursorCliModelOf(context, stripCursorPrefix(context.baseModel))
    }

    it('maps the grok effort suffix to the catalog slug', () => {
      for (const effort of ['low', 'medium', 'high']) {
        expect(cliModelFor(`cursor-grok-4.5@${effort}`)).toBe(`cursor-grok-4.5-${effort}`)
      }
    })

    it('keeps the glm bracket override and passes an effort-less grok through', () => {
      expect(cliModelFor('cursor-glm-5.2@high')).toBe('glm-5.2[reasoning=high]')
      expect(cliModelFor('cursor-grok-4.5')).toBe('grok-4.5')
    })

    it('fails closed with exit 6 for a base model missing from the mapping table', () => {
      const result = cliModelFor('composer-2.5@high')
      if (typeof result === 'string') {
        throw new Error('expected a fail-closed result')
      }
      expect(result.exitCode).toBe(6)
    })
  })
}
