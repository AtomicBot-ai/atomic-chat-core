import { describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import type { ErrorCode } from '../contracts/index.js'
import {
  classifyFailure,
  diagnosticFingerprint,
  diagnosticTags,
  errorChain,
  failureObserver,
  reportDiagnostic,
} from './diagnostics.js'

const context = { component: 'runtime', operation: 'load' } as const
const failure = (code: string) =>
  new AtomicCoreError(code as ErrorCode, 'User text must not be a grouping key')

describe('classifyFailure', () => {
  it('keeps only finite operation details, outside the public error body', () => {
    const error = new AtomicCoreError('DEVICE_LIST_PARSE_FAILED', 'probe failed', undefined, {
      diagnostic: { ...context, operationDetail: 'device_probe_timeout' } as never,
    })
    const diagnostic = classifyFailure(error, context)
    expect(diagnosticTags(error, diagnostic)).toMatchObject({ operation_detail: 'device_probe_timeout' })
    expect(error.toJSON()).toEqual({ code: 'DEVICE_LIST_PARSE_FAILED', message: 'probe failed' })
    const privateValue = new AtomicCoreError('DEVICE_LIST_PARSE_FAILED', 'probe failed', undefined, {
      diagnostic: { ...context, operationDetail: '/private/customer/model' } as never,
    })
    expect(
      JSON.stringify(diagnosticTags(privateValue, classifyFailure(privateValue, context)))
    ).not.toContain('/private')
  })

  it.each([
    ['INVALID_ARGUMENT', 'expected', 'invalid_request'],
    ['CANCELLED', 'expected', 'cancelled'],
    ['OUT_OF_MEMORY', 'operational', 'out_of_memory'],
    ['INTERNAL_ERROR', 'defect', 'internal'],
    ['IO_ERROR', 'unknown', 'unknown'],
    ['MODEL_LOAD_FAILED', 'unknown', 'unknown'],
    ['UPSTREAM_ERROR', 'operational', 'upstream'],
    ['DISK_FULL', 'operational', 'disk_full'],
  ])('%s has a category and a finite reason', (code, category, reason) => {
    expect(classifyFailure(failure(code), context)).toMatchObject({ ...context, category, reason })
  })
  it('preserves a native I/O cause without inferring it from user text', () => {
    const cause = Object.assign(new Error('disk details'), { code: 'ENOSPC' })
    const error = new AtomicCoreError('IO_ERROR', 'failed', undefined, { cause })
    expect(classifyFailure(error, context)).toMatchObject({ category: 'operational', reason: 'disk_full' })
    expect(classifyFailure(new Error('out of memory'), context).category).toBe('unknown')
  })
  it('keeps only the build number of an installed version/backend pair', () => {
    expect(
      classifyFailure(new Error(), { ...context, engineVersion: 'b11463-2.1.0/private-dir' }).engineVersion
    ).toBe('b11463-2.1.0')
  })
  it('validates metadata supplied by untyped callers', () => {
    const error = new AtomicCoreError('IO_ERROR', 'x', undefined, {
      diagnostic: {
        ...context,
        category: 'a prompt',
        reason: '/private/path',
        signal: 'SIGPRIVATENAME',
        engineVersion: 'private/customer-folder',
        exitCode: NaN,
      } as never,
    })
    expect(classifyFailure(error, context)).toEqual({ ...context, category: 'unknown', reason: 'unknown' })
  })
})

describe('errorChain', () => {
  it('bounds nested causes, breaks cycles, and never serializes objects', () => {
    const leaf = new Error('leaf')
    const parent = new Error('parent', { cause: leaf })
    leaf.cause = parent
    expect(errorChain(parent)).toEqual([parent, leaf])
    let error = new Error('leaf')
    for (let n = 0; n < 10; n++) error = new Error('wrapper', { cause: error })
    expect(errorChain(error)).toHaveLength(5)
    expect(errorChain({ prompt: 'private' })).toEqual([])
  })
})

describe('diagnosticTags / diagnosticFingerprint', () => {
  it('groups by known cause, but separates unknown failures by their original source position', () => {
    const a = failure('OUT_OF_MEMORY')
    const b = failure('OUT_OF_MEMORY')
    b.message = 'another model'
    expect(diagnosticFingerprint(a, classifyFailure(a, context))).toEqual(
      diagnosticFingerprint(b, classifyFailure(b, context))
    )
    const x = new Error('private')
    x.stack = 'Error\n at load (/Users/private/src/runtime/foo.ts:3:4)'
    const y = new Error('private')
    y.stack = 'Error\n at load (/Users/private/src/runtime/foo.ts:5:4)'
    expect(diagnosticFingerprint(x, context)).not.toEqual(diagnosticFingerprint(y, context))
    expect(JSON.stringify(diagnosticTags(x, classifyFailure(x, context)))).not.toContain('private')
    expect(diagnosticTags(a, classifyFailure(a, context))).toMatchObject({
      diagnostic_version: 'core-v1',
      cause_code: 'OUT_OF_MEMORY',
    })
  })
})

describe('failureObserver', () => {
  it('keeps wrapped cancellations quiet and retains the five-minute observer cooldown', () => {
    const capture = vi.fn()
    const observe = failureObserver({ capture })
    observe(
      new AtomicCoreError('INTERNAL_ERROR', 'wrapper', undefined, {
        cause: new DOMException('cancelled', 'AbortError'),
        diagnostic: { ...context, category: 'defect', reason: 'internal' },
      }),
      context
    )
    expect(capture).not.toHaveBeenCalled()
    observe(new Error('failure'), context)
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ throttle: expect.objectContaining({ windowMs: 300_000 }) })
    )
  })
  it('ignores expected outcomes, reports operational/unknown ones and cannot break the caller', () => {
    const capture = vi.fn()
    const observe = failureObserver({ capture })
    observe(failure('CANCELLED'), context)
    expect(capture).not.toHaveBeenCalled()
    observe(failure('OUT_OF_MEMORY'), context)
    expect(capture).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'warning' }))
    observe(new Error('unknown'), context)
    expect(capture).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'error' }))
    expect(() =>
      failureObserver({
        capture: () => {
          throw new Error('sink failed')
        },
      })(new Error(), context)
    ).not.toThrow()
    expect(() => failureObserver(undefined)(new Error(), context)).not.toThrow()
  })
})

describe('reportDiagnostic', () => {
  it.each([
    ['audio_load', 'load'],
    ['audio_job', 'job'],
  ] as const)('identifies the audio boundary of %s', (source, operation) => {
    expect(reportDiagnostic({ source, level: 'error' })).toMatchObject({ component: 'audio', operation })
  })

  it('normalizes legacy process and compute reports', () => {
    expect(
      reportDiagnostic({ source: 'inference', level: 'warning', tags: { failure_kind: 'oom' } })
    ).toMatchObject({ component: 'runtime', reason: 'out_of_memory', category: 'operational' })
    expect(
      reportDiagnostic({
        source: 'backend_crash',
        level: 'error',
        tags: { crash_kind: 'sigsegv', signal: 'SIGSEGV', exit_code: 1 },
      })
    ).toMatchObject({ nativeFailure: 'sigsegv', exitCode: 1, signal: 'SIGSEGV' })
  })
})
