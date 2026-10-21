import { describe, expect, it } from 'vitest'
import { BOUND_LITERT_LM_ABI, LiteRtLibraryError } from './library.js'

describe('LiteRtLibraryError', () => {
  it('names the C API call and keeps the library message', () => {
    const error = new LiteRtLibraryError('engine_create', 'INTERNAL: Failed to create Metal device')
    expect(error.message).toBe('engine_create: INTERNAL: Failed to create Metal device')
    expect(error).toMatchObject({ name: 'LiteRtLibraryError', operation: 'engine_create' })
  })

  it('binds ABI 1, the one the manifest of conf calls 1', () => {
    expect(BOUND_LITERT_LM_ABI).toBe(1)
  })
})
