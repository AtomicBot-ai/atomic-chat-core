import { describe, expect, it } from 'vitest'
import { BOUND_GENIEX_ABI, GENIEX_CANCELLED, GENIEX_POWER_MODES, GeniexLibraryError } from './library.js'

describe('GeniexLibraryError', () => {
  it('names the C API call and keeps the library message and code', () => {
    const error = new GeniexLibraryError('llm_create', 'Model loading failed', -100201)
    expect(error.message).toBe('llm_create: Model loading failed')
    expect(error).toMatchObject({ name: 'GeniexLibraryError', operation: 'llm_create', code: -100201 })
    expect(new GeniexLibraryError('load', 'no dll').code).toBeNull()
  })

  it('binds ABI 1, the one the manifest of conf calls 1, and knows the power modes in enum order', () => {
    expect(BOUND_GENIEX_ABI).toBe(1)
    expect(GENIEX_CANCELLED).toBe(-100006)
    expect(GENIEX_POWER_MODES.indexOf('burst')).toBe(7)
    expect(GENIEX_POWER_MODES.indexOf('balanced')).toBe(4)
  })
})
