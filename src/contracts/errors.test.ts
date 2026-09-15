import { describe, expect, it } from 'vitest'
import { AtomicCoreError, DISK_ERROR_TAGS } from './errors.js'

describe('AtomicCoreError', () => {
  it('serialises to the {code, message, details?} wire shape and omits details when absent', () => {
    expect(new AtomicCoreError('OUT_OF_MEMORY', 'boom').toJSON()).toEqual({
      code: 'OUT_OF_MEMORY',
      message: 'boom',
    })
    expect(new AtomicCoreError('IO_ERROR', 'x', 'y').toJSON()).toEqual({
      code: 'IO_ERROR',
      message: 'x',
      details: 'y',
    })
  })

  it('round-trips through fromBody', () => {
    const err = AtomicCoreError.fromBody({ code: 'MODEL_FILE_CORRUPT', message: 'bad', details: 'd' })
    expect(err).toBeInstanceOf(AtomicCoreError)
    expect(err.code).toBe('MODEL_FILE_CORRUPT')
    expect(err.details).toBe('d')
  })

  it('keeps the six disk tags the app telemetry parses', () => {
    expect([...DISK_ERROR_TAGS]).toEqual([
      'disk_full',
      'disk_permission',
      'disk_file_locked',
      'disk_path_too_long',
      'disk_device_lost',
      'disk_io',
    ])
  })
})
