import { describe, expect, it } from 'vitest'
import {
  backendPreference,
  engineInfoOf,
  orderEngineCandidates,
  orderUpstreamCandidates,
  upstreamBackendPreference,
} from './engine-candidates.js'

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
      dialect: 'turboquant',
      provider: 'llamacpp',
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

describe('orderUpstreamCandidates', () => {
  it('keeps only builds at the floor or newer, newest first, GPU before CPU', () => {
    const packs = [
      pack('b11344', 'win-cuda-12.4-x64'),
      pack('b11436', 'win-cpu-x64'),
      pack('b11370', 'win-vulkan-x64'),
      pack('b11436', 'win-cuda-13.4-x64'),
      pack('b10269-1.7.0', 'win-cpu-x64'),
    ]
    const { eligible, tooOld } = orderUpstreamCandidates(packs, 11370)
    expect(eligible.map((c) => c.info.version_backend)).toEqual([
      'b11436/win-cuda-13.4-x64',
      'b11436/win-cpu-x64',
      'b11370/win-vulkan-x64',
    ])
    expect(eligible[0]!.info).toMatchObject({
      dialect: 'upstream',
      provider: 'llamacpp-upstream',
      version_gate: true,
      fork_version: null,
    })
    expect(tooOld.map((p) => p.version)).toEqual(['b11344', 'b10269-1.7.0'])
  })

  it.each([
    ['macos-arm64', 0],
    ['win-cuda-12.4-x64', 1],
    ['ubuntu-rocm-10.0-x64', 2],
    ['win-hip-radeon-x64', 2],
    ['ubuntu-vulkan-x64', 3],
    ['ubuntu-sycl-fp16-x64', 4],
    ['ubuntu-openvino-2026.4.1-x64', 4],
    ['ubuntu-x64', 5],
    ['win-cpu-x64', 5],
  ])('ranks %s at %i: the backends a big model runs best on first', (backend, rank) =>
    expect(upstreamBackendPreference(backend)).toBe(rank)
  )

  it('orders two packs of one build and one rank by their id', () => {
    const { eligible } = orderUpstreamCandidates(
      [pack('b11436', 'win-cuda-13.4-x64'), pack('b11436', 'win-cuda-12.4-x64')],
      11370
    )
    expect(eligible.map((c) => c.backend)).toEqual(['win-cuda-12.4-x64', 'win-cuda-13.4-x64'])
  })
})
