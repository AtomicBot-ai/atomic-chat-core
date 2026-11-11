import { describe, expect, it } from 'vitest'
import { FoundryLibraryError, selectFoundryApi } from './library.js'

describe('FoundryLibraryError', () => {
  it('names the C API call and keeps the library code', () => {
    const error = new FoundryLibraryError('Model_Load', 3, 'unknown execution provider for local model')
    expect(error.message).toBe('Model_Load: unknown execution provider for local model')
    expect(error).toMatchObject({ name: 'FoundryLibraryError', operation: 'Model_Load', libraryCode: 3 })
  })
})

describe('selectFoundryApi', () => {
  it.each([3, 2])('reports the maximum supported C API %s, trying 3 before 2', (maximum) => {
    const calls: number[] = []
    const selected = selectFoundryApi('2.4.0', (version) => {
      calls.push(version)
      return version <= maximum ? 123 : null
    })
    expect(selected).toEqual({ api: 123, cApiVersion: maximum })
    expect(calls).toEqual(maximum === 3 ? [3] : [3, 2])
  })
  it('rejects a library with neither supported table, naming its version', () => {
    expect(() => selectFoundryApi('9.0.0', () => null)).toThrow(/9.0.0.*3.*2/)
  })
})
