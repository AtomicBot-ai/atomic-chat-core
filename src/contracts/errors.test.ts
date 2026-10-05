import { describe, expect, it } from 'vitest'
import { AtomicCoreError, DIFFUSION_ERROR_CODES, DISK_ERROR_TAGS, MANAGED_ERROR_CODES } from './errors.js'

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

  it("keeps the image-generation codes the web app's errors.ts matches on", () => {
    // `NativeDiffusionErrorCode` in web-app/src/services/diffusion/types.ts, `error.rs` at ec1fd3ea7.
    expect([...DIFFUSION_ERROR_CODES]).toEqual([
      'ENGINE_MISSING',
      'ENGINE_UPDATE_REQUIRED',
      'ENGINE_INSTALL_FAILED',
      'ENGINE_CRASHED',
      'MODEL_MISSING',
      'SIDE_FILE_MISSING',
      'MODEL_LOAD_FAILED',
      'MODEL_INCOMPATIBLE',
      'MODEL_NOT_LOADED',
      'OUT_OF_MEMORY',
      'UNSUPPORTED_BACKEND',
      'UNSUPPORTED_WORKFLOW',
      'INVALID_DIMENSIONS',
      'INVALID_REQUEST',
      'INVALID_OUTPUT',
      'JOB_BUSY',
      'JOB_NOT_FOUND',
      'QUEUE_FULL',
      'CANCELLED',
      'DISK_FULL',
      'BACKEND_IN_USE',
      'NOT_CONFIGURED',
      'INTERNAL',
    ])
  })

  it('keeps the managed text-runtime codes (environment.ts), including the ones shared with other surfaces', () => {
    expect([...MANAGED_ERROR_CODES]).toEqual([
      'MANAGED_OPERATION_CONFLICT',
      'MANAGED_OPERATION_NOT_FOUND',
      'MANAGED_REVISION_CONFLICT',
      'MANAGED_CONSENT_REQUIRED',
      'MANAGED_PLAN_CHANGED',
      'MANAGED_HOST_STEP_INVALID',
      'MANAGED_PREREQUISITE_BLOCKED',
      'MANAGED_ADAPTER_UNAVAILABLE',
      'MANAGED_IDENTITY_MISMATCH',
      'MANAGED_STOP_UNCONFIRMED',
      'MANAGED_RESOURCE_IN_USE',
      'MANAGED_METADATA_INVALID',
      'MANAGED_RECEIPT_CONFLICT',
      'MANAGED_ELEVATION_DECLINED',
      'MANAGED_RELOGIN_REQUIRED',
      'MANAGED_REBOOT_REQUIRED',
      'MODEL_INCOMPATIBLE',
      'GPU_BUSY',
      'SESSION_GENERATION_STALE',
    ])
    // MODEL_INCOMPATIBLE is reused from the image-generation codes above, not redeclared there.
    expect(new Set(DIFFUSION_ERROR_CODES).has('MODEL_INCOMPATIBLE')).toBe(true)
  })
})
