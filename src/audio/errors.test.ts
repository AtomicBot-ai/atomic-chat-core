import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import {
  audioError,
  audioErrorBody,
  audioInternalError,
  audioIoError,
  isAudioErrorCode,
  toAudioError,
} from './errors.js'

const enospc = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })

describe('audio errors', () => {
  it('builds core errors with audio codes', () => {
    expect(audioError('JOB_BUSY', 'busy', 'job 1').toJSON()).toEqual({
      code: 'JOB_BUSY',
      message: 'busy',
      details: 'job 1',
    })
    expect(audioInternalError('oops').code).toBe('INTERNAL')
  })

  it('tells a full disk from any other I/O failure, the cause kept', () => {
    const full = audioIoError('Could not write the clip.', enospc)
    expect(full.toJSON()).toEqual({
      code: 'DISK_FULL',
      message: '[disk_full] The disk is full.',
      details: 'Could not write the clip.: no space left on device',
    })
    expect(full.cause).toBe(enospc)
    const edquot = Object.assign(new Error('disk quota exceeded'), { code: 'EDQUOT' })
    expect(audioIoError('Could not write the clip.', edquot).code).toBe('DISK_FULL')
    expect(audioIoError('Could not write the clip.', edquot).message).toBe('[disk_full] The disk is full.')
    const denied = audioIoError('Could not write the clip.', 'EACCES')
    expect(denied.toJSON()).toEqual({
      code: 'INTERNAL',
      message: 'Could not write the clip.',
      details: 'EACCES',
    })
    expect(denied.cause).toBe('EACCES')
  })

  it('knows its own codes', () => {
    expect(isAudioErrorCode('REQUEST_REJECTED')).toBe(true)
    expect(isAudioErrorCode('INVALID_DIMENSIONS')).toBe(false)
    expect(isAudioErrorCode(1)).toBe(false)
  })

  it('carries any failure as an audio body, a foreign code kept in the details', () => {
    expect(audioErrorBody(audioError('CANCELLED', 'Generation was cancelled.'))).toEqual({
      code: 'CANCELLED',
      message: 'Generation was cancelled.',
    })
    expect(audioErrorBody(audioError('MODEL_MISSING', 'gone', 'kokoro.gguf'))).toEqual({
      code: 'MODEL_MISSING',
      message: 'gone',
      details: 'kokoro.gguf',
    })
    expect(audioErrorBody(new AtomicCoreError('IO_ERROR', 'read failed', 'EIO'))).toEqual({
      code: 'INTERNAL',
      message: 'read failed',
      details: 'IO_ERROR: EIO',
    })
    expect(audioErrorBody(new AtomicCoreError('IO_ERROR', 'read failed'))).toEqual({
      code: 'INTERNAL',
      message: 'read failed',
      details: 'IO_ERROR',
    })
    expect(audioErrorBody(new Error('boom'))).toEqual({ code: 'INTERNAL', message: 'boom' })
    expect(audioErrorBody('text')).toEqual({ code: 'INTERNAL', message: 'text' })
  })

  it('rethrows an audio error as is and converts anything else', () => {
    const own = audioError('JOB_NOT_FOUND', 'no such job')
    expect(toAudioError(own)).toBe(own)
    expect(toAudioError(new Error('boom')).toJSON()).toEqual({ code: 'INTERNAL', message: 'boom' })
  })
})
