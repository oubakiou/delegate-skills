import type { Env } from './build-request.ts'
import type { CliResult } from './cli-result.ts'
import { hasFileContent } from './jq-compat.ts'
import {
  appendDispatchMetrics,
  dispatchEnd,
  dispatchStart,
  heartbeat,
  importStreams,
  responseMissing,
} from './observe-store.ts'
import { writeFailedResponse } from './observe-followup.ts'
import { elapsedMs, monotonicMs } from './observe-timing.ts'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  makeWrapperContext,
  quietly,
  type WrapperArgs,
  type WrapperContext,
} from './wrapper-common.ts'
import { writeCompanionFromResponse } from './wrapper-report.ts'

// 専用 wrapper（delegate-imagegen-codex / delegate-x-research-grok）の共通部。
// 共通 dispatch.sh を経由しないため、dispatch lifecycle（start / end / metrics）を
// wrapper 自身が記録する（bash 版と同一。二重記録は発生しない）。

export interface DedicatedArgs {
  model: string
  requestFile: string
  responseFile: string
  runDir: string
  observeFile: string
}

const argOrDefault = (value: string | undefined, fallback: string): string => {
  if (typeof value === 'string' && value !== '') {
    return value
  }
  return fallback
}

export const parseDedicatedArgs = (
  argv: readonly string[],
  usageName: string
): DedicatedArgs | CliResult => {
  if (argv.length < 3) {
    return {
      exitCode: 2,
      stderr: `Usage: ${usageName} <model> <request_file> <response_file> [run_dir] [observe_file]\n`,
      stdout: '',
    }
  }
  const [model, requestFile, responseFile] = argv
  const runBase = responseFile.replace(/_res\.json$/, '')
  return {
    model,
    requestFile,
    responseFile,
    runDir: argOrDefault(argv[3], runBase),
    observeFile: argOrDefault(argv[4], `${runBase}_observe.json`),
  }
}

export const makeDedicatedContext = (
  parsed: DedicatedArgs,
  fixed: { taskType: string; backend: string },
  io: { env: Env; scriptsDir: string }
): WrapperContext => {
  const args: WrapperArgs = {
    originalModel: parsed.model,
    taskType: fixed.taskType,
    requestFile: parsed.requestFile,
    responseFile: parsed.responseFile,
    runDir: parsed.runDir,
    observeFile: parsed.observeFile,
    sessionMode: '',
    resumeArg: '',
    sessionHome: '',
  }
  return makeWrapperContext(args, {
    env: io.env,
    scriptsDir: io.scriptsDir,
    backend: fixed.backend,
  })
}

export interface DedicatedLifecycle {
  startMs: number | null
}

export const startDedicatedDispatch = (context: WrapperContext): DedicatedLifecycle => {
  const startMs = monotonicMs()
  dispatchStart(context.args.observeFile, context.workDir, {
    backend: context.backend,
    dispatcherPid: process.pid,
  })
  return { startMs }
}

// write_failed_response 後に response が存在し得るため、present 判定はその後に行う
// （bash 版と同じく failed response が書けた場合 dispatch_end は response_present=true）
const responsePresence = (context: WrapperContext): boolean => {
  if (hasFileContent(context.args.responseFile)) {
    return true
  }
  responseMissing(context.args.observeFile, context.workDir)
  return false
}

export interface EndDedicatedInput {
  lifecycle: DedicatedLifecycle
  exitCode: number
  // grok fallback 等で実効 model が要求 model と異なる場合に metrics へ渡す実効値。
  // 省略時は originalModel（bash 版 delegate-x-research-grok は fallback 後の $MODEL を記録）
  effectiveModel?: string
}

export const endDedicatedDispatch = (
  context: WrapperContext,
  input: EndDedicatedInput
): boolean => {
  const responsePresent = responsePresence(context)
  dispatchEnd(context.args.observeFile, context.workDir, {
    backend: context.backend,
    dispatcherPid: process.pid,
    exitCode: input.exitCode,
    responsePresent,
  })
  quietly(() => {
    appendDispatchMetrics(
      {
        observeFile: context.args.observeFile,
        taskType: context.args.taskType,
        model: input.effectiveModel ?? context.args.originalModel,
        backend: context.backend,
        durationMs: elapsedMs(input.lifecycle.startMs),
        exitCode: input.exitCode,
        responsePresent,
        responseFile: context.args.responseFile,
      },
      context.env
    )
  })
  return responsePresent
}

// 子を起動できない失敗の専用終端。共通 finish_without_child に加えて companion md と
// dispatch lifecycle の記録まで行う（bash 版 finish_without_child と同一）
export const finishDedicated = (
  context: WrapperContext,
  lifecycle: DedicatedLifecycle,
  failure: { exitCode: number; message: string }
): CliResult => {
  writeFileSync(context.stderrCapture, `${failure.message}\n`)
  quietly(() => {
    writeFailedResponse(
      {
        observeFile: context.args.observeFile,
        runDir: context.workDir,
        backend: context.backend,
        responseFile: context.args.responseFile,
        exitCode: failure.exitCode,
      },
      context.env
    )
  })
  if (hasFileContent(context.args.responseFile)) {
    writeCompanionFromResponse(context.args.responseFile)
  }
  heartbeat(context.args.observeFile, context.workDir, {
    backend: context.backend,
    childPid: process.pid,
    stdoutCapture: context.stdoutCapture,
    stderrCapture: context.stderrCapture,
  })
  importStreams(context.args.observeFile, context.workDir, {
    stdoutCapture: context.stdoutCapture,
    stderrCapture: context.stderrCapture,
    env: context.env,
  })
  endDedicatedDispatch(context, { lifecycle, exitCode: failure.exitCode })
  return { exitCode: failure.exitCode, stdout: `${context.args.responseFile}\n`, stderr: '' }
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  const { mkdirSync, readFileSync } = await import('node:fs')

  const makeDedicatedTestContext = (): WrapperContext => {
    mkdirSync('.temp', { recursive: true })
    const dir = `.temp/wrapper-dedicated-test-${Math.random().toString(36).slice(2)}`
    mkdirSync(dir)
    return makeDedicatedContext(
      {
        model: 'gpt-5',
        requestFile: path.join(dir, 'delegate_imagegen_x_req.json'),
        responseFile: path.join(dir, 'delegate_imagegen_x_res.json'),
        runDir: dir,
        observeFile: path.join(dir, 'delegate_imagegen_x_observe.json'),
      },
      { taskType: 'imagegen', backend: 'codex' },
      { env: {}, scriptsDir: dir }
    )
  }

  describe('parseDedicatedArgs', () => {
    it('fails closed with exit 2 and derives run_dir / observe_file defaults', () => {
      const usage = parseDedicatedArgs(['gpt-5'], 'delegate-imagegen-codex.sh')
      expect('exitCode' in usage && usage.exitCode).toBe(2)
      const parsed = parseDedicatedArgs(['gpt-5', 'req.json', '/w/run_res.json'], 'x')
      expect(parsed).toMatchObject({ runDir: '/w/run', observeFile: '/w/run_observe.json' })
    })
  })

  describe('finishDedicated', () => {
    it('records the full dispatch lifecycle with a failed response present', () => {
      const context = makeDedicatedTestContext()
      const lifecycle = startDedicatedDispatch(context)
      const result = finishDedicated(context, lifecycle, {
        exitCode: 3,
        message: 'ERROR: codex CLI が見つかりません。',
      })
      expect(result.exitCode).toBe(3)
      expect(result.stdout).toBe(`${context.args.responseFile}\n`)
      const observe: unknown = JSON.parse(readFileSync(context.args.observeFile, 'utf8'))
      expect(observe).toMatchObject({
        run: { backend: 'codex', task_type: 'imagegen' },
        state: { phase: 'ended', exit_code: 3, response_present: true },
      })
      expect(JSON.stringify(observe)).toContain('dispatch_end')
    })
  })
}
