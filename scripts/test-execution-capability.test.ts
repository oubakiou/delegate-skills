import { describe, expect, it, vi } from 'vitest'
import {
  childExecutionProbeFailure,
  type ChildExecutionProbeObservation,
  runTestEnvironmentSetup,
  unsupportedTestEnvironmentMessage,
} from './test-execution-capability.ts'

const successfulObservation = (): ChildExecutionProbeObservation => ({
  errorCode: null,
  signal: null,
  status: 0,
  stderr: '',
  stdout: 'delegate-skills-test-execution-capability-ok',
})

describe('test execution capability preflight', () => {
  it('accepts a child that exits cleanly with the sentinel output', () => {
    expect(childExecutionProbeFailure('sync', successfulObservation())).toBeNull()
  })

  it('rejects an EPERM result even when its status is zero', () => {
    const observation = {
      ...successfulObservation(),
      errorCode: 'EPERM',
      stdout: '',
    }
    expect(childExecutionProbeFailure('sync', observation)).toBe('sync: error=EPERM, stdout=""')
  })

  it('rejects an empty async result that otherwise looks successful', () => {
    const observation = { ...successfulObservation(), stdout: '' }
    expect(childExecutionProbeFailure('async', observation)).toBe('async: stdout=""')
  })

  it('reports status, signal, and stderr without classifying the run as a test failure', () => {
    const observation: ChildExecutionProbeObservation = {
      errorCode: null,
      signal: 'SIGTERM',
      status: null,
      stderr: 'blocked',
      stdout: '',
    }
    const failure = childExecutionProbeFailure('async', observation)
    const message = unsupportedTestEnvironmentMessage(failure ?? 'missing failure')
    expect(message).toContain('TEST_ENVIRONMENT_UNSUPPORTED')
    expect(message).toContain('async: status=null, signal=SIGTERM, stdout="", stderr="blocked"')
    expect(message).toContain('The test suite was not started')
    expect(message).toContain('npm test')
  })
})

const probeSucceeds = async (): Promise<void> => {
  await Promise.resolve()
}

const probeFails = async (): Promise<void> => {
  await Promise.resolve()
  throw new Error(unsupportedTestEnvironmentMessage('sync: status=1'))
}

const sweepSucceeds = async (): Promise<void> => {
  await Promise.resolve()
}

const sweepFails = async (): Promise<void> => {
  await Promise.resolve()
  throw new Error('sweep exploded')
}

describe('runTestEnvironmentSetup', () => {
  it('sweeps test scratch after the probe succeeds', async () => {
    const sweep = vi.fn(sweepSucceeds)
    await runTestEnvironmentSetup({ assertCapability: probeSucceeds, sweep })
    expect(sweep).toHaveBeenCalledTimes(1)
  })

  it('does not sweep when the probe fails', async () => {
    const sweep = vi.fn(sweepSucceeds)
    await expect(runTestEnvironmentSetup({ assertCapability: probeFails, sweep })).rejects.toThrow(
      'TEST_ENVIRONMENT_UNSUPPORTED'
    )
    expect(sweep).not.toHaveBeenCalled()
  })

  it('degrades a sweep failure to a warning without failing the preflight', async () => {
    const warnings: string[] = []
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        warnings.push(String(chunk))
        return true
      })
    try {
      await runTestEnvironmentSetup({ assertCapability: probeSucceeds, sweep: sweepFails })
    } finally {
      write.mockRestore()
    }
    expect(warnings.join('')).toContain('test scratch sweep skipped: sweep exploded')
  })
})
