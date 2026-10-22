import { describe, expect, it } from 'vitest'
import { BOUND_LITERT_LM_ABI, LiteRtLibraryError, samplerSettings } from './library.js'

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

describe('samplerSettings', () => {
  it('sets no sampler when the request names nothing, so the file keeps its own sampling', () => {
    expect(samplerSettings({})).toBeNull()
  })

  it('fills what the request leaves out, with a fresh seed unless one is given', () => {
    expect(samplerSettings({ temperature: 0.2 }, () => 0.5)).toEqual({
      topK: 64,
      topP: 0.95,
      temperature: 0.2,
      seed: 1073741823,
    })
    expect(samplerSettings({ topK: 1, topP: 0.5, temperature: 0, seed: 7 })).toEqual({
      topK: 1,
      topP: 0.5,
      temperature: 0,
      seed: 7,
    })
  })
})
