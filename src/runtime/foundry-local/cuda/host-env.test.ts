import { describe, expect, it } from 'vitest'
import { withCudaRuntime } from './host-env.js'

describe('withCudaRuntime', () => {
  it('prepends the verified directory to the Windows host PATH without adding a second casing', () => {
    const original = { Path: 'C:\\Windows\\System32', Other: 'keep' }
    expect(withCudaRuntime(original, '/build/v2.4.0/win-x64', 'C:\\cache\\cuda')).toEqual({
      Path: 'C:\\cache\\cuda;C:\\Windows\\System32',
      ATOMIC_FOUNDRY_CUDA_CACHE_DIR: 'C:\\cache\\cuda',
      Other: 'keep',
    })
    expect(original.Path).toBe('C:\\Windows\\System32')
  })

  it('sets the Linux loader path on the host environment before spawn', () => {
    expect(
      withCudaRuntime({ LD_LIBRARY_PATH: '/usr/local/lib' }, '/build/v2.4.0/linux-x64', '/cache/cuda')
    ).toEqual({
      LD_LIBRARY_PATH: '/cache/cuda:/usr/local/lib',
    })
  })
})
