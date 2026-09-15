import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import { handleSettingUpdate, mapOldBackendToNew, shouldMigrateBackend } from './migrate.js'

describe('mapOldBackendToNew (Rust test_map_old_backend_to_new_*)', () => {
  it.each([
    // cuda
    ['linux-avx2-cuda-cu12.0-x64', 'linux-cpu-x64'],
    ['linux-cuda-12-common_cpus-x64', 'linux-cpu-x64'],
    ['linux-cuda-13-common_cpus-x64', 'linux-cpu-x64'],
    ['win-noavx-cuda-cu11.7-x64', 'win-cuda-12.4-x64'],
    ['win-cuda-12-common_cpus-x64', 'win-cuda-12.4-x64'],
    ['win-cuda-13-common_cpus-x64', 'win-cuda-13.3-x64'],
    ['win-cuda-12.4-x64', 'win-cuda-12.4-x64'],
    ['win-cuda-13.3-x64', 'win-cuda-13.3-x64'],
    ['win-cuda-13.1-x64', 'win-cuda-13.3-x64'],
    ['win-cuda-13-x64', 'win-cuda-13-x64'],
    // vulkan
    ['linux-vulkan-common_cpus-x64', 'linux-vulkan-x64'],
    ['linux-vulkan-x64', 'linux-vulkan-x64'],
    ['ubuntu-vulkan-x64', 'linux-vulkan-x64'],
    ['ubuntu-vulkan-arm64', 'linux-vulkan-arm64'],
    ['ubuntu-x64', 'linux-cpu-x64'],
    ['win-vulkan-common_cpus-x64', 'win-vulkan-x64'],
    ['win-vulkan-x64', 'win-vulkan-x64'],
    // cpu
    ['win-avx512-x64', 'win-cpu-x64'],
    ['win-common_cpus-x64', 'win-cpu-x64'],
    ['win-cpu-x64', 'win-cpu-x64'],
    ['linux-avx2-x64', 'linux-cpu-x64'],
    ['linux-avx512-x64', 'linux-cpu-x64'],
    ['linux-common_cpus-x64', 'linux-cpu-x64'],
    ['linux-cpu-x64', 'linux-cpu-x64'],
    // arch
    ['linux-arm64', 'linux-cpu-arm64'],
    ['linux-common_cpus-arm64', 'linux-cpu-arm64'],
    ['linux-cpu-arm64', 'linux-cpu-arm64'],
    // rocm family and concrete pass through
    ['win-rocm-x64', 'win-rocm-x64'],
    ['win-rocm-7.14-x64', 'win-rocm-7.14-x64'],
    // non-linux non-windows fall-through
    ['macos-arm64', 'macos-arm64'],
    ['macos-avx2-x64', 'common_cpus-x64'],
  ])('mapOldBackendToNew(%j) = %j', (input, expected) => {
    expect(mapOldBackendToNew(input)).toBe(expected)
  })
})

describe('shouldMigrateBackend (Rust test_should_migrate_backend_*)', () => {
  const available = [{ version: 'b7524', backend: 'linux-cpu-x64', order: 1 }]
  it('migrates a legacy id when the mapped type is available', () => {
    expect(shouldMigrateBackend('linux-avx2-x64', available)).toBe('linux-cpu-x64')
  })
  it('returns null when no migration is needed', () => {
    expect(shouldMigrateBackend('linux-cpu-x64', available)).toBeNull()
  })
  it('returns null when the mapped type is not available', () => {
    expect(shouldMigrateBackend('linux-vulkan-common_cpus-x64', available)).toBeNull()
  })
})

describe('handleSettingUpdate', () => {
  it('ignores keys other than version_backend', () => {
    expect(handleSettingUpdate('ctx_size', '4096', 'win-cpu-x64')).toEqual({
      backend_type_updated: false,
      effective_backend_type: null,
      needs_backend_installation: false,
      version: null,
      backend: null,
    })
  })
  it('normalises the backend id, strips the BOM and reports a type change', () => {
    expect(
      handleSettingUpdate('version_backend', '\uFEFFb7524/ win-cuda-12-common_cpus-x64 ', 'win-cpu-x64')
    ).toEqual({
      backend_type_updated: true,
      effective_backend_type: 'win-cuda-12.4-x64',
      needs_backend_installation: true,
      version: 'b7524',
      backend: 'win-cuda-12-common_cpus-x64',
    })
  })
  it('treats a missing stored type as updated and an equal one as unchanged', () => {
    expect(handleSettingUpdate('version_backend', 'b1/win-cpu-x64', null).backend_type_updated).toBe(true)
    expect(handleSettingUpdate('version_backend', 'b1/win-cpu-x64', 'win-cpu-x64').backend_type_updated).toBe(
      false
    )
  })
  it.each(['b7524', 'a/b/c', 'b7524/', '/x'])('rejects %j with INVALID_ARGUMENT', (value) => {
    expect(() => handleSettingUpdate('version_backend', value, null)).toThrow(AtomicCoreError)
    expect(() => handleSettingUpdate('version_backend', value, null)).toThrow(/Invalid backend format/)
  })
})
