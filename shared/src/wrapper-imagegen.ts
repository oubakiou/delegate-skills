import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Env } from './build-request.ts'
import type { CliResult } from './cli-result.ts'
import { effortFromCodexSessions } from './observe-effort.ts'
import { recordEffort } from './observe-store.ts'
import {
  completeResponse,
  envOrDefault,
  finalizeResponse,
  quietly,
  responderSessionIdOf,
  writePromptFile,
  type WrapperContext,
} from './wrapper-common.ts'
import { runWithCodexAuth } from './wrapper-codex.ts'
import {
  endDedicatedDispatch,
  finishDedicated,
  makeDedicatedContext,
  parseDedicatedArgs,
  startDedicatedDispatch,
  type DedicatedLifecycle,
} from './wrapper-dedicated.ts'
import {
  codexHomePrune,
  requestPromptStep,
  structuredFromLastMessage,
  REPORT_SCHEMA_JSON,
} from './wrapper-report.ts'
import {
  commandAvailable,
  spawnWorker,
  waitWithHeartbeat,
  type WaitResult,
} from './wrapper-wait.ts'

// bash 版 delegate-imagegen-codex.sh と同一契約の delegate-imagegen 専用
// Codex 子プロセス起動ラッパ。stdout: response_file のパスのみ

const argNonEmpty = (value: string | undefined): string | null => {
  if (typeof value === 'string' && value !== '') {
    return value
  }
  return null
}

const outputDirOf = (env: Env): string =>
  argNonEmpty(env.DELEGATE_IMAGEGEN_OUTPUT_DIR) ?? 'delegate-imagegen-output'

const outputPathOf = (context: WrapperContext, outputDir: string): string => {
  if (outputDir.startsWith('/')) {
    return outputDir
  }
  return path.join(context.repoRoot, outputDir)
}

const imagegenPrompt = (parts: { requestStep: string; outputDir: string }): string =>
  [
    'あなたは delegate-skills の画像生成ワーカー（task_type=imagegen）です。protocol v1 に従ってください。',
    '',
    parts.requestStep,
    '2. リクエストの指示に従い、利用可能な画像生成・画像編集 capability を使って成果物を生成する。AGENTS.md / CLAUDE.md の規約に従うこと。',
    `3. 出力先がリクエストで明示されていない場合は、リポジトリ root からの相対パス \`${parts.outputDir}/\` 配下に保存する。`,
    '4. 生成できない場合も、原因、試したパラメータ、必要な追加入力を report_markdown に残して failed または needs_input を返す。',
    '5. 作業完了後、最終応答として構造化出力 {status, report_markdown} だけを返す。status は completed | partial | failed | needs_input のいずれか。report_markdown は見出し',
    '   Summary / Generated files / Parameters / Verification / Blockers の Markdown。',
    '   report は簡潔に書く: Summary は 5 行以内。試行錯誤ログや生ログは貼らず、Parameters は最終採用値と重要な生成条件のみ。該当が無い見出しは省く。',
    '   report をファイルに書いたり md2idx / jq でレスポンスを生成したりしない（レスポンス生成は wrapper が行う）。リポジトリ root に report.md を作らない。',
  ].join('\n')

const imagegenCodexArgs = (
  context: WrapperContext,
  files: { lastMsg: string; schemaFile: string }
): string[] => [
  'exec',
  '-m',
  context.args.originalModel,
  '--skip-git-repo-check',
  '--ephemeral',
  '--ignore-user-config',
  '--sandbox',
  envOrDefault(context.env, 'CODEX_DELEGATE_SANDBOX', 'danger-full-access'),
  '--output-last-message',
  files.lastMsg,
  '--output-schema',
  files.schemaFile,
  '-C',
  context.repoRoot,
  '-',
]

const effectiveCodexEffort = (codexHome: string): Record<string, unknown> | null => {
  try {
    const effective = effortFromCodexSessions(codexHome)
    if (effective === null) {
      return null
    }
    return { ...effective }
  } catch {
    return null
  }
}

const finalizeImagegenRun = (
  context: WrapperContext,
  run: { codexHome: string; lastMsg: string; lifecycle: DedicatedLifecycle },
  wait: WaitResult
): CliResult => {
  completeResponse(
    context,
    {
      responderSessionId: responderSessionIdOf(context, context.args.originalModel),
      reportMode: 'structured',
      collectStructured: () => structuredFromLastMessage(run.lastMsg),
    },
    wait
  )
  const outcome = finalizeResponse(context, wait.childStatus)
  quietly(() => {
    recordEffort(context.args.observeFile, context.workDir, {
      requested: '',
      effective: effectiveCodexEffort(run.codexHome),
    })
  })
  endDedicatedDispatch(context, { lifecycle: run.lifecycle, exitCode: outcome.responseStatus })
  // protocol status が failed の response は exit 0 でも失敗扱いとし、調査のため prune しない
  if (outcome.responseStatus === 0 && outcome.responseAllowsResume) {
    codexHomePrune(run.codexHome, context.env)
  }
  return {
    exitCode: outcome.responseStatus,
    stdout: `${context.args.responseFile}\n`,
    stderr: outcome.stderrTail,
  }
}

interface ImagegenLaunch {
  codexHome: string
  lastMsg: string
  schemaFile: string
  promptFile: string
}

const prepareImagegenLaunch = (context: WrapperContext): ImagegenLaunch => {
  const outputDir = outputDirOf(context.env)
  mkdirSync(outputPathOf(context, outputDir), { recursive: true })
  const codexHome = path.join(context.workDir, 'codex-home')
  const schemaFile = path.join(context.workDir, 'report-schema.json')
  writeFileSync(schemaFile, REPORT_SCHEMA_JSON)
  const requestStep = requestPromptStep(context.args.requestFile, {
    scriptsDir: context.scriptsDir,
    env: context.env,
  })
  const promptFile = writePromptFile(
    context,
    imagegenPrompt({ requestStep: requestStep.step, outputDir })
  )
  return {
    codexHome,
    lastMsg: path.join(context.workDir, 'codex-last-message.txt'),
    schemaFile,
    promptFile,
  }
}

const runImagegenChild = async (
  context: WrapperContext,
  lifecycle: DedicatedLifecycle
): Promise<CliResult> => {
  const codexHome = path.join(context.workDir, 'codex-home')
  return runWithCodexAuth({
    context,
    codexHome,
    operation: async () => {
      const launch = prepareImagegenLaunch(context)
      const files = { lastMsg: launch.lastMsg, schemaFile: launch.schemaFile }
      const worker = spawnWorker({
        command: 'codex',
        args: imagegenCodexArgs(context, files),
        cwd: process.cwd(),
        env: {
          ...context.env,
          CODEX_HOME: launch.codexHome,
          TMPDIR: path.join(context.workDir, 'tmp'),
        },
        stdinFile: launch.promptFile,
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
      return { lastMsg: launch.lastMsg, wait }
    },
    finalize: ({ lastMsg, wait }) =>
      finalizeImagegenRun(context, { codexHome, lastMsg, lifecycle }, wait),
    onFailure: (phase) =>
      finishDedicated(context, lifecycle, {
        exitCode: 1,
        message: `ERROR: Codex credential ${phase} failed safely.`,
      }),
  })
}

export const runWrapperImagegen = async (
  argv: readonly string[],
  env: Env,
  io: { scriptsDir: string }
): Promise<CliResult> => {
  const parsed = parseDedicatedArgs(argv, 'delegate-imagegen-codex.sh')
  if ('exitCode' in parsed) {
    return parsed
  }
  const context = makeDedicatedContext(
    parsed,
    { taskType: 'imagegen', backend: 'codex' },
    {
      env,
      scriptsDir: io.scriptsDir,
    }
  )
  const lifecycle = startDedicatedDispatch(context)
  if (!context.args.originalModel.startsWith('gpt')) {
    return finishDedicated(context, lifecycle, {
      exitCode: 2,
      message: `ERROR: delegate-imagegen requires a gpt-* model for Codex execution: ${context.args.originalModel}`,
    })
  }
  if (!commandAvailable('codex', env)) {
    return finishDedicated(context, lifecycle, {
      exitCode: 3,
      message: 'ERROR: codex CLI が見つかりません。',
    })
  }
  return runImagegenChild(context, lifecycle)
}
