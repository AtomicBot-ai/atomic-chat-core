import { describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import { classifyFailure, diagnosticTags, failureObserver } from './diagnostics.js'

const context = { component: 'runtime', operation: 'load' } as const

describe('GenieX host load bounded diagnostics', () => {
  it('tags GenieX host load failures with finite diagnostic codes', () => {
    const libraryLoadError = new AtomicCoreError(
      'GENIEX_HOST_ERROR',
      'The GenieX library does not load on this computer.',
      '/private/fixture/geniex-host: exit code 3'
    )
    const libraryDiag = classifyFailure(libraryLoadError, context)
    const libraryTags = diagnosticTags(libraryLoadError, libraryDiag)
    expect(libraryTags).toMatchObject({
      diagnostic_version: 'core-v1',
      component: 'runtime',
      operation: 'load',
      failure_category: 'unknown',
      failure_reason: 'unknown',
      cause_code: 'GENIEX_HOST_ERROR',
      diagnostic_code: 'GENIEX_HOST_LIBRARY_LOAD_FAILED',
    })
    expect(libraryTags['diagnostic_cause_code']).toBeUndefined()
    expect(JSON.stringify(libraryTags)).not.toContain('/private')
    expect(libraryLoadError.toJSON()).toEqual({
      code: 'GENIEX_HOST_ERROR',
      message: 'The GenieX library does not load on this computer.',
      details: '/private/fixture/geniex-host: exit code 3',
    })

    const cause = Object.assign(new Error('/private/fixture/QnnHtp.dll missing'), { code: 'ENOENT' })
    const stoppedBeforeReadyError = new AtomicCoreError(
      'GENIEX_HOST_ERROR',
      'The GenieX host stopped before the model was ready.',
      '/private/fixture/model: exit code 4',
      { cause }
    )
    const stoppedDiag = classifyFailure(stoppedBeforeReadyError, context)
    const stoppedTags = diagnosticTags(stoppedBeforeReadyError, stoppedDiag)
    expect(stoppedTags).toMatchObject({
      diagnostic_version: 'core-v1',
      component: 'runtime',
      operation: 'load',
      failure_category: 'unknown',
      failure_reason: 'unknown',
      cause_code: 'ENOENT',
      diagnostic_code: 'GENIEX_HOST_STOPPED_BEFORE_READY',
      diagnostic_cause_code: 'ENOENT',
    })
    expect(JSON.stringify(stoppedTags)).not.toContain('/private')
    expect(JSON.stringify(stoppedTags)).not.toContain('QnnHtp')
  })

  it('preserves privacy, cyclic-cause safety, and original reporting behavior', () => {
    const cycleA = Object.assign(new Error('/private/fixture/cycle-a'), { code: 'PRIVATE_CODE' })
    const cycleB = new Error('/private/fixture/cycle-b', { cause: cycleA })
    cycleA.cause = cycleB

    const diag = classifyFailure(cycleA, context)
    const tags = diagnosticTags(cycleA, diag)
    expect(tags['diagnostic_code']).toBeUndefined()
    expect(tags['diagnostic_cause_code']).toBeUndefined()
    expect(JSON.stringify(tags)).not.toContain('/private')
    expect(JSON.stringify(tags)).not.toContain('PRIVATE_CODE')

    const capture = vi.fn()
    const observe = failureObserver({ capture })
    const hostError = new AtomicCoreError(
      'GENIEX_HOST_ERROR',
      'The GenieX host stopped before the model was ready.'
    )
    observe(hostError, context)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'operation',
        error: hostError,
        level: 'error',
      })
    )
  })
})
