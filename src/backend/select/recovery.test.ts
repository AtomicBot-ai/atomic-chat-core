import { describe, expect, it } from 'vitest'
import type { BackendVersion } from '../types.js'
import {
  isBundledNewerSameType,
  isPersistedVersionBackendMissing,
  latestBackendOptions,
  recoverVersionBackendFromDisk,
  sameTypeUpgradeCandidate,
  savedBackendVanished,
  shouldApplyBundledBackend,
  staticLatestVariants,
} from './recovery.js'

const b = (version: string, backend: string, order = 0): BackendVersion => ({ version, backend, order })

describe('configureBackends startup decisions', () => {
  it('isPersistedVersionBackendMissing / shouldApplyBundledBackend', () => {
    expect(isPersistedVersionBackendMissing('')).toBe(true)
    expect(isPersistedVersionBackendMissing('none')).toBe(true)
    expect(isPersistedVersionBackendMissing('b1')).toBe(true)
    expect(isPersistedVersionBackendMissing('latest/win-cpu-x64')).toBe(false)
    expect(isPersistedVersionBackendMissing(null)).toBe(true)
    expect(shouldApplyBundledBackend('latest/win-cpu-x64')).toBe(true)
    expect(shouldApplyBundledBackend('b1/win-cpu-x64')).toBe(false)
    expect(shouldApplyBundledBackend(undefined)).toBe(true)
  })
  it('recoverVersionBackendFromDisk picks the best installed build or nothing', () => {
    expect(
      recoverVersionBackendFromDisk([b('b10809', 'win-cpu-x64', 1), b('b10809', 'win-cuda-13.3-x64', 2)], [])
    ).toBe('b10809/win-cuda-13.3-x64')
    expect(recoverVersionBackendFromDisk([], [])).toBeNull()
  })
  it('staticLatestVariants / latestBackendOptions', () => {
    expect(staticLatestVariants('windows')).toEqual([
      'win-cpu-x64',
      'win-cuda-12-x64',
      'win-cuda-13-x64',
      'win-rocm-x64',
      'win-vulkan-x64',
    ])
    expect(staticLatestVariants('linux')).toEqual(['linux-cpu-x64', 'linux-vulkan-x64'])
    expect(staticLatestVariants('macos', 'b10809/macos-arm64')).toEqual(['macos-arm64'])
    expect(staticLatestVariants('macos', 'b10809/macos-x64')).toEqual([])
    expect(staticLatestVariants('macos')).toEqual([])
    expect(staticLatestVariants('android')).toEqual([])
    expect(latestBackendOptions(['win-cuda-13-x64', 'win-rocm-x64'])).toEqual([
      { value: 'latest/win-cuda-13-x64', name: 'Latest CUDA 13' },
      { value: 'latest/win-rocm-x64', name: 'Latest ROCm (~1 GB)' },
    ])
  })
  it('isBundledNewerSameType compares build numbers of the same type only', () => {
    expect(isBundledNewerSameType('b10809/macos-arm64', 'b10405/macos-arm64')).toBe(true)
    expect(isBundledNewerSameType('b10405/macos-arm64', 'b10809/macos-arm64')).toBe(false)
    expect(isBundledNewerSameType('b10809/macos-arm64', 'b10809/macos-arm64')).toBe(false)
    expect(isBundledNewerSameType('b10809/win-cpu-x64', 'b10405/win-cuda-13.3-x64')).toBe(false)
    expect(isBundledNewerSameType('b10809/macos-arm64', 'custom/macos-arm64')).toBe(false)
    expect(isBundledNewerSameType(null, 'b1/x')).toBe(false)
    expect(isBundledNewerSameType('b2/x', 'none')).toBe(false)
  })
  it('sameTypeUpgradeCandidate', () => {
    expect(sameTypeUpgradeCandidate('b10405/win-cuda-13.3-x64', 'b10809/win-cuda-13.3-x64')).toBe(
      'b10809/win-cuda-13.3-x64'
    )
    expect(sameTypeUpgradeCandidate('b10405/win-cuda-13.3-x64', 'b10809/win-cpu-x64')).toBeNull()
    expect(sameTypeUpgradeCandidate('b10809/x', 'b10809/x')).toBeNull()
    expect(sameTypeUpgradeCandidate('none', 'b10809/x')).toBeNull()
    expect(sameTypeUpgradeCandidate('b1/x', '')).toBeNull()
  })
  it('savedBackendVanished keeps an installed build that dropped out of the catalog', () => {
    const catalog = [b('b10809', 'win-cpu-x64')]
    expect(savedBackendVanished('', catalog, false)).toBe(true)
    expect(savedBackendVanished('none', catalog, true)).toBe(true)
    expect(savedBackendVanished('b1', catalog, true)).toBe(true)
    expect(savedBackendVanished('b10405/win-cuda-13.3-x64', catalog, false)).toBe(true)
    expect(savedBackendVanished('b10405/win-cuda-13.3-x64', catalog, true)).toBe(false)
    expect(savedBackendVanished('b10809/win-cpu-x64', catalog, false)).toBe(false)
  })
})
