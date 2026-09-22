import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import {
  cancelledError,
  diffusionError,
  errorBody,
  internalError,
  ioError,
  isDiffusionErrorCode,
  isDiskFull,
  modelNotLoadedError,
  notConfiguredError,
  toDiffusionError,
} from './errors.js'

const errno = (code: string, message: string) => Object.assign(new Error(message), { code })

describe('the named failures', () => {
  // Messages are `error.rs` and `jobs.rs` verbatim (app commit 767ff6350): the web app shows them.
  it('carry the plugin codes and messages', () => {
    expect(notConfiguredError().toJSON()).toEqual({
      code: 'NOT_CONFIGURED',
      message: 'Image generation has not been configured yet.',
    })
    expect(modelNotLoadedError().toJSON()).toEqual({
      code: 'MODEL_NOT_LOADED',
      message: 'Load an image model first.',
    })
    expect(cancelledError().toJSON()).toEqual({ code: 'CANCELLED', message: 'Generation was cancelled.' })
    expect(internalError('Job state is poisoned.').toJSON()).toEqual({
      code: 'INTERNAL',
      message: 'Job state is poisoned.',
    })
    expect(diffusionError('JOB_BUSY', 'An image is already being generated.', 'abc').details).toBe('abc')
  })
})

describe('ioError', () => {
  it('makes a full disk actionable and everything else internal', () => {
    const full = ioError(
      'Could not write the image.',
      errno('ENOSPC', 'ENOSPC: no space left on device, write')
    )
    expect(full.toJSON()).toEqual({
      code: 'DISK_FULL',
      message: 'The disk is full.',
      details: 'Could not write the image.: ENOSPC: no space left on device, write',
    })
    const denied = ioError(
      'Could not create the output folder.',
      errno('EACCES', 'EACCES: permission denied')
    )
    expect(denied.toJSON()).toEqual({
      code: 'INTERNAL',
      message: 'Could not create the output folder.',
      details: 'EACCES: permission denied',
    })
    expect(ioError('context', 'a string').details).toBe('a string')
  })

  it('recognises a full disk only by its errno code', () => {
    expect(isDiskFull(errno('ENOSPC', 'x'))).toBe(true)
    expect(isDiskFull(errno('EIO', 'x'))).toBe(false)
    expect(isDiskFull(new Error('no space left on device'))).toBe(false)
    expect(isDiskFull(undefined)).toBe(false)
  })
})

describe('errorBody', () => {
  it('keeps a diffusion error as it is, details only when there are any', () => {
    expect(errorBody(diffusionError('QUEUE_FULL', 'full'))).toEqual({ code: 'QUEUE_FULL', message: 'full' })
    expect(errorBody(diffusionError('OUT_OF_MEMORY', 'oom', 'tail'))).toEqual({
      code: 'OUT_OF_MEMORY',
      message: 'oom',
      details: 'tail',
    })
  })

  it('turns a code from outside this surface into INTERNAL and keeps the original in the details', () => {
    expect(errorBody(new AtomicCoreError('IO_ERROR', 'An input/output error occurred.', 'ENOENT'))).toEqual({
      code: 'INTERNAL',
      message: 'An input/output error occurred.',
      details: 'IO_ERROR: ENOENT',
    })
    expect(errorBody(new AtomicCoreError('CORE_NOT_RUNNING', 'stopping'))).toEqual({
      code: 'INTERNAL',
      message: 'stopping',
      details: 'CORE_NOT_RUNNING',
    })
    expect(errorBody(new Error('boom'))).toEqual({ code: 'INTERNAL', message: 'boom' })
    expect(errorBody('plain')).toEqual({ code: 'INTERNAL', message: 'plain' })
  })

  it('has a thrown form that leaves a diffusion error untouched', () => {
    const original = diffusionError('ENGINE_CRASHED', 'died')
    expect(toDiffusionError(original)).toBe(original)
    const mapped = toDiffusionError(new AtomicCoreError('IO_ERROR', 'io', 'why'))
    expect(mapped).toBeInstanceOf(AtomicCoreError)
    expect(mapped.toJSON()).toEqual({ code: 'INTERNAL', message: 'io', details: 'IO_ERROR: why' })
  })

  it('tells its own codes from the rest', () => {
    expect(isDiffusionErrorCode('CANCELLED')).toBe(true)
    expect(isDiffusionErrorCode('MODEL_LOAD_FAILED')).toBe(true)
    expect(isDiffusionErrorCode('MODEL_LOAD_CANCELLED')).toBe(false)
    expect(isDiffusionErrorCode(7)).toBe(false)
  })
})
