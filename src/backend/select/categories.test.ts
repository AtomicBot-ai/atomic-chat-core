import { describe, expect, it } from 'vitest'
import type { BackendVersion } from '../types.js'
import {
  backendCategoryToLabel,
  checkBackendForUpdates,
  determineBestBackend,
  findLatestVersionForBackend,
  getBackendCategory,
  GPU_BACKEND_MIN_VRAM_MIB,
  hasEnoughGpuMemory,
  prioritizeBackends,
} from './categories.js'

const b = (version: string, backend: string, order = 0): BackendVersion => ({ version, backend, order })

describe('getBackendCategory / backendCategoryToLabel', () => {
  it.each([
    ['win-rocm-7.14-x64', 'rocm'],
    ['win-cuda-13.3-x64', 'cuda-cu13'],
    ['win-cuda-13.1-x64', 'cuda-cu13'],
    ['win-cuda-12.4-x64', 'cuda-cu12.4'],
    ['win-cuda-13-common_cpus-x64', 'cuda-cu13.0'],
    ['linux-noavx-cuda-cu12.0-x64', 'cuda-cu12.0'],
    ['win-noavx-cuda-cu11.7-x64', 'cuda-cu11.7'],
    ['win-vulkan-x64', 'vulkan'],
    ['win-cpu-x64', 'cpu'],
    ['win-cpu-arm64', 'cpu'],
    ['linux-common_cpus-x64', 'common_cpus'],
    ['linux-avx512-x64', 'avx512'],
    ['linux-avx2-x64', 'avx2'],
    ['linux-avx-x64', 'avx'],
    // Rust tests `contains("avx")` before `noavx`, so `noavx` is unreachable for real ids.
    ['linux-noavx-x64', 'avx'],
    ['linux-noavx-cuda-cu12.0-x64', 'cuda-cu12.0'],
    ['macos-arm64', 'arm64'],
    ['linux-cpu-x64', 'x64'],
    ['something', null],
  ])('getBackendCategory(%j) = %j', (input, expected) => {
    expect(getBackendCategory(input)).toBe(expected)
  })
  it.each([
    ['cuda-cu13', 'CUDA 13'],
    ['cuda-cu13.0', 'CUDA 13'],
    ['cuda-cu12.4', 'CUDA 12'],
    ['cuda-cu12.0', 'CUDA 12'],
    ['cuda-cu11.7', 'CUDA 11'],
    ['vulkan', 'Vulkan'],
    ['rocm', 'rocm'],
    ['cpu', 'cpu'],
  ])('backendCategoryToLabel(%j) = %j', (input, expected) => {
    expect(backendCategoryToLabel(input)).toBe(expected)
  })
})

describe('prioritizeBackends (Rust test_prioritize_backends_*)', () => {
  it('prefers the newest CUDA 13 asset', () => {
    const r = prioritizeBackends(
      [
        b('b9900', 'win-cuda-13.1-x64', 10),
        b('b10205', 'win-cuda-13.3-x64', 1),
        b('b10205', 'win-cuda-12.4-x64', 1),
        b('b10205', 'win-vulkan-x64', 1),
      ],
      true
    )
    expect(r).toEqual({
      backend_string: 'b10205/win-cuda-13.3-x64',
      version: 'b10205',
      backend_type: 'win-cuda-13.3-x64',
    })
  })
  it('gates Linux Vulkan on GPU memory', () => {
    const available = [b('b10205', 'linux-cpu-x64', 1), b('b10205', 'linux-vulkan-x64', 1)]
    expect(prioritizeBackends(available, true).backend_type).toBe('linux-vulkan-x64')
    expect(prioritizeBackends(available, false).backend_type).toBe('linux-cpu-x64')
  })
  it('prefers ROCm over Vulkan, and CPU over both under the low-VRAM policy', () => {
    const available = [
      b('b10405', 'win-vulkan-x64', 1),
      b('b10405', 'win-rocm-7.14-x64', 1),
      b('b10405', 'win-cpu-x64', 1),
    ]
    expect(prioritizeBackends(available, true).backend_type).toBe('win-rocm-7.14-x64')
    expect(prioritizeBackends(available, false).backend_type).toBe('win-cpu-x64')
  })
  it('falls back to the first entry when nothing categorises, and rejects an empty catalog', () => {
    expect(prioritizeBackends([b('b1', 'weird'), b('b2', 'odd')], true).backend_string).toBe('b1/weird')
    expect(() => prioritizeBackends([], true)).toThrow('No backends available')
  })
})

describe('findLatestVersionForBackend (Rust test_find_latest_version_*)', () => {
  it('returns the highest tag of the type', () => {
    expect(
      findLatestVersionForBackend(
        [b('b7523', 'linux-cpu-x64', 2), b('b7524', 'linux-cpu-x64', 3), b('b7522', 'linux-cpu-x64', 1)],
        'linux-cpu-x64'
      )
    ).toBe('b7524/linux-cpu-x64')
  })
  it('prefers a newer tag over install time and orders tags numerically', () => {
    expect(
      findLatestVersionForBackend(
        [b('b10205', 'macos-arm64', 1_800_000_000), b('b10344', 'macos-arm64', 0)],
        'macos-arm64'
      )
    ).toBe('b10344/macos-arm64')
    expect(
      findLatestVersionForBackend(
        [b('b9999', 'linux-vulkan-x64'), b('b10344', 'linux-vulkan-x64')],
        'linux-vulkan-x64'
      )
    ).toBe('b10344/linux-vulkan-x64')
    expect(
      findLatestVersionForBackend(
        [b('b7524', 'win-cuda-12.4-x64', 1_800_000_000), b('b7525', 'win-cuda-12.4-x64', 0)],
        'win-cuda-12.4-x64'
      )
    ).toBe('b7525/win-cuda-12.4-x64')
  })
  it('falls back to order for non-release tags and matches legacy ids through migration', () => {
    expect(
      findLatestVersionForBackend(
        [b('custom-build', 'macos-arm64', 1), b('another-build', 'macos-arm64', 2)],
        'macos-arm64'
      )
    ).toBe('another-build/macos-arm64')
    expect(
      findLatestVersionForBackend(
        [b('b7523', 'linux-avx2-x64', 1), b('b7524', 'linux-cpu-x64', 2)],
        'linux-cpu-x64'
      )
    ).toBe('b7524/linux-cpu-x64')
    expect(findLatestVersionForBackend([b('b7523', 'linux-avx2-x64', 1)], 'linux-cpu-x64')).toBe(
      'b7523/linux-avx2-x64'
    )
    expect(findLatestVersionForBackend([], 'macos-arm64')).toBeNull()
  })
})

describe('checkBackendForUpdates (Rust test_check_backend_for_updates_*)', () => {
  it('offers a newer macOS tag and a newer Windows tag regardless of install order', () => {
    expect(
      checkBackendForUpdates('b10205/macos-arm64', [
        b('b10205', 'macos-arm64', 1_800_000_000),
        b('b10344', 'macos-arm64', 0),
      ])
    ).toEqual({
      update_needed: true,
      new_version: 'b10344',
      target_backend: 'b10344/macos-arm64',
    })
    expect(
      checkBackendForUpdates('b7524/win-cuda-12.4-x64', [
        b('b7524', 'win-cuda-12.4-x64', 1_800_000_000),
        b('b7525', 'win-cuda-12.4-x64', 0),
      ])
    ).toEqual({
      update_needed: true,
      new_version: 'b7525',
      target_backend: 'b7525/win-cuda-12.4-x64',
    })
  })
  it('handles TurboQuant tags by install order', () => {
    const available = [
      b('turboquant-macos-arm64-e3dad20', 'macos-arm64', 1),
      b('turboquant-macos-arm64-18a8ef1', 'macos-arm64', 2),
    ]
    expect(checkBackendForUpdates('turboquant-macos-arm64-e3dad20/macos-arm64', available)).toEqual({
      update_needed: true,
      new_version: 'turboquant-macos-arm64-18a8ef1',
      target_backend: 'turboquant-macos-arm64-18a8ef1/macos-arm64',
    })
    expect(checkBackendForUpdates('turboquant-macos-arm64-18a8ef1/macos-arm64', available)).toEqual({
      update_needed: false,
      new_version: '0',
      target_backend: null,
    })
  })
  it('reports no update when the type is absent and rejects a malformed current string', () => {
    expect(checkBackendForUpdates('b1/win-cpu-x64', [])).toEqual({
      update_needed: false,
      new_version: '0',
      target_backend: null,
    })
    expect(() => checkBackendForUpdates('nope', [])).toThrow('Invalid current backend format: nope')
  })
})

describe('GPU memory and corroboration helpers', () => {
  it('hasEnoughGpuMemory / determineBestBackend', () => {
    expect(GPU_BACKEND_MIN_VRAM_MIB).toBe(2048)
    expect(hasEnoughGpuMemory([{ total_memory: 2048 }])).toBe(true)
    expect(hasEnoughGpuMemory([{ total_memory: 2047 }, {}])).toBe(false)
    const catalog = [b('b1', 'linux-cpu-x64'), b('b1', 'linux-vulkan-x64')]
    expect(determineBestBackend(catalog, [{ total_memory: 4096 }])).toBe('b1/linux-vulkan-x64')
    expect(determineBestBackend(catalog, [])).toBe('b1/linux-cpu-x64')
    expect(determineBestBackend([], [])).toBe('')
  })
})
