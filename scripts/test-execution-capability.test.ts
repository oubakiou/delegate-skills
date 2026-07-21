import { describe, expect, it } from 'vitest'
import {
  childExecutionProbeFailure,
  type ChildExecutionProbeObservation,
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
