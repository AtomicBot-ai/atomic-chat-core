import { describe, expect, it } from 'vitest'
import { FoundryLibraryError } from './library.js'

describe('FoundryLibraryError', () => {
  it('names the C API call and keeps the library code', () => {
    const error = new FoundryLibraryError('Model_Load', 3, 'unknown execution provider for local model')
    expect(error.message).toBe('Model_Load: unknown execution provider for local model')
    expect(error).toMatchObject({ name: 'FoundryLibraryError', operation: 'Model_Load', libraryCode: 3 })
  })
})
