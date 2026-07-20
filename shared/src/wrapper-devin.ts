import path from 'node:path'
import type { Env } from './build-request.ts'
import type { CliResult } from './cli-result.ts'
import { getPath, readFileOrEmpty, stringOf } from './jq-compat.ts'
import { updateMcpConfig } from './observe-store.ts'
import { usageFromCapture, usageFromDevinExport } from './observe-usage.ts'
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
  commandAvailable,
  spawnWorker,
  waitWithHeartbeat,
  type WaitResult,
} from './wrapper-wait.ts'

// bash 版 delegate-devin.sh と同一契約の swe-* / devin-* モデル向け Devin CLI
// 子プロセス起動ラッパ。stdout: response_file のパスのみ（本文は親 context に入れない）

// devin-* プレフィックスは剥離して devin CLI に渡す（devin-glm-5.2 → glm-5.2）
// swe-* は devin CLI がそのまま受理するので剥離しない
const devinCliModelOf = (originalModel: string): string => {
  if (originalModel.startsWith('devin-')) {
    return originalModel.slice('devin-'.length)
  }
  return originalModel
}

const devinExportFileOf = (context: WrapperContext): string =>
  path.join(context.workDir, 'devin-export.json')

const extractDevinSessionId = (exportFile: string): string => {
  try {
    const parsed: unknown = JSON.parse(readFileOrEmpty(exportFile))
    const sessionId = stringOf(
      getPath(parsed, ['session_id']) ?? getPath(parsed, ['session', 'id'])
    )
    return sessionId
  } catch {
    return ''
  }
}

const devinSessionModeFailure = (context: WrapperContext): CliResult | null => {
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

// --permission-mode dangerous は claude --dangerously-skip-permissions と同等
// （非対話のため permission prompt に応答できない）。AGENTS.md は devin が自動で
// 読む（無効化不可）ため --ignore-rules 相当は不要。prompt は argv ではなく
// --prompt-file で渡す（ARG_MAX 非依存。ps からも見えない）
const devinCliArgs = (
  context: WrapperContext,
  files: { promptFile: string; exportFile: string; model: string }
): string[] => {
  const args = [
    '-p',
    '--prompt-file',
    files.promptFile,
    '--model',
    files.model,
    '--permission-mode',
    'dangerous',
    '--export',
    files.exportFile,
  ]
  if (context.args.sessionMode === 'followup') {
    args.push('--resume', context.args.resumeArg)
  }
  return args
}

const recordDevinSessionOutcome = (
  context: WrapperContext,
  exportFile: string,
  outcome: { childStatus: number; responseAllowsResume: boolean }
): void => {
  if (context.args.sessionMode === 'resumable') {
    recordResumableOutcome(context, {
      childStatus: outcome.childStatus,
      responseAllowsResume: outcome.responseAllowsResume,
      resumeId: extractDevinSessionId(exportFile),
      resumeSource: 'devin_atif_export',
      homeDir: '',
      failReason: 'Devin run did not complete successfully',
      missingIdReason: 'Devin export session_id was not found',
    })
    return
  }
  if (context.args.sessionMode === 'followup') {
    recordFollowupOutcome(context, {
      childStatus: outcome.childStatus,
      responseAllowsResume: outcome.responseAllowsResume,
      resumeId: context.args.resumeArg,
      resumeSource: 'devin_atif_export',
      homeDir: '',
      failReason: 'Devin follow-up did not complete successfully',
    })
  }
}

interface DevinRun {
  model: string
  exportFile: string
  reportFile: string
}

const finalizeDevinRun = (context: WrapperContext, run: DevinRun, wait: WaitResult): CliResult => {
  completeResponse(
    context,
    {
      responderSessionId: responderSessionIdOf(context, run.model),
      reportMode: reportModeForBackend(context.backend),
      reportFile: run.reportFile,
      devinExport: run.exportFile,
    },
    wait
  )
  const outcome = finalizeResponse(context, wait.childStatus)
  recordUsageAndEffort(context, {
    usageSource: 'devin_atif_export',
    measuredUsage: () =>
      usageFromDevinExport(run.exportFile, {
        model: context.args.originalModel,
        backend: context.backend,
      }) ??
      usageFromCapture(context.stdoutCapture, {
        model: context.args.originalModel,
        backend: context.backend,
        source: 'devin_json',
      }),
    effortRequested: '',
  })
  recordDevinSessionOutcome(context, run.exportFile, {
    childStatus: wait.childStatus,
    responseAllowsResume: outcome.responseAllowsResume,
  })
  return wrapperResult(context, outcome)
}

const runDevinChild = async (context: WrapperContext, run: DevinRun): Promise<CliResult> => {
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
    updateMcpConfig(context.args.observeFile, context.workDir, { source: 'shared', servers: [] })
  })
  const worker = spawnWorker({
    command: 'devin',
    args: devinCliArgs(context, { promptFile, exportFile: run.exportFile, model: run.model }),
    cwd: context.repoRoot,
    env: { ...context.env, TMPDIR: path.join(context.workDir, 'tmp') },
    stdinFile: null,
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
  return finalizeDevinRun(context, run, wait)
}

const wrapperDevinWithContext = async (context: WrapperContext): Promise<CliResult> => {
  // effort suffix は devin backend に指定手段がないため、CLI 起動前に fail-closed にする
  const effortError = effortFailure(context)
  if (effortError !== null) {
    return effortError
  }
  const modeFailure = devinSessionModeFailure(context)
  if (modeFailure !== null) {
    return modeFailure
  }
  if (!commandAvailable('devin', context.env)) {
    return finishWithoutChild(context, 3, 'ERROR: devin CLI が見つかりません。')
  }
  return runDevinChild(context, {
    model: devinCliModelOf(context.args.originalModel),
    exportFile: devinExportFileOf(context),
    reportFile: path.join(context.args.runDir, 'report.md'),
  })
}

export const runWrapperDevin = async (
  argv: readonly string[],
  env: Env,
  io: { scriptsDir: string }
): Promise<CliResult> => {
  const args = parseWrapperArgs(argv, 'delegate-devin.sh')
  if ('exitCode' in args) {
    return args
  }
  const context = makeWrapperContext(args, { env, scriptsDir: io.scriptsDir })
  return wrapperDevinWithContext(context)
}
