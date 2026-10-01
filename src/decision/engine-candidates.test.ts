import { describe, expect, it } from 'vitest'
import { backendPreference, engineInfoOf, orderEngineCandidates } from './engine-candidates.js'

const pack = (version: string, backend: string) => ({
  version,
  backend,
  path: `/b/${version}/${backend}/llama-server`,
})

describe('backendPreference', () => {
  it.each([
    ['linux-x64-cpu', 0],
    ['windows-x64-cpu', 0],
    ['macos-arm64', 1],
    ['linux-x64-vulkan', 2],
    ['windows-x64-cuda-13.3', 3],
    ['linux-x64-rocm', 3],
  ])('%s → %i', (backend, rank) => {
    expect(backendPreference(backend)).toBe(rank)
  })
})

describe('engineInfoOf', () => {
  it('describes a unified tag with its semver and gate', () => {
    expect(engineInfoOf(pack('b10269-1.7.0', 'macos-arm64'))).toEqual({
      path: '/b/b10269-1.7.0/macos-arm64/llama-server',
      version_backend: 'b10269-1.7.0/macos-arm64',
      fork_version: '1.7.0',
      version_gate: true,
    })
  })

  it('leaves the gate unknown for a legacy tag', () => {
    expect(engineInfoOf(pack('turboquant-macos-arm64-abc', 'macos-arm64'))).toMatchObject({
      fork_version: null,
      version_gate: null,
    })
  })
})

describe('orderEngineCandidates', () => {
  it('probes tags at or above 1.7.0 first, then tags without semver, then older ones (dev builds last)', () => {
    const order = orderEngineCandidates([
      pack('b10269-1.5.1', 'macos-arm64'),
      pack('turboquant-macos-arm64-abc', 'macos-arm64'),
      pack('b10269-1.7.0', 'macos-arm64'),
    ]).map((c) => c.version)
    expect(order).toEqual(['b10269-1.7.0', 'turboquant-macos-arm64-abc', 'b10269-1.5.1'])
  })

  it('prefers the newer build inside a group, and the CPU pack inside a version', () => {
    const order = orderEngineCandidates([
      pack('b10269-1.7.0', 'windows-x64-cuda-13.3'),
      pack('b10269-1.7.0', 'windows-x64-vulkan'),
      pack('b10300-1.8.0', 'windows-x64-cuda-13.3'),
      pack('b10269-1.7.0', 'windows-x64-cpu'),
    ]).map((c) => c.info.version_backend)
    expect(order).toEqual([
      'b10300-1.8.0/windows-x64-cuda-13.3',
      'b10269-1.7.0/windows-x64-cpu',
      'b10269-1.7.0/windows-x64-vulkan',
      'b10269-1.7.0/windows-x64-cuda-13.3',
    ])
  })

  it('is empty without packs', () => {
    expect(orderEngineCandidates([])).toEqual([])
  })
})
