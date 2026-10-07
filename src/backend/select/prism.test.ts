import { describe, expect, it } from 'vitest'
import type { BackendVersion, GpuProbeInfo } from '../types.js'
import {
  checkPrismBackendForUpdates,
  comparePrismBackendsForSort,
  detectIdealPrismBackendType,
  determineBestPrismBackend,
  determinePrismSupportedBackends,
  filterPrismBackendsBySupport,
  findLatestPrismVersionForBackend,
  getPrismBackendCategory,
  getPrismSupportedFeatures,
  mergePrismBackends,
} from './prism.js'

const T1 = 'prism-b10754-2459f68'
const T2 = 'prism-b10800-aaaaaaa'

const rtx4090: GpuProbeInfo = {
  vendor: 'NVIDIA',
  driver_version: '581.42',
  total_memory: 24_576,
  nvidia_info: { compute_capability: '8.9' },
  vulkan_info: { device_type: 'DiscreteGpu', device_id: 0x2684 },
}
const gtx1080: GpuProbeInfo = {
  ...rtx4090,
  driver_version: '560.94',
  total_memory: 8_192,
  nvidia_info: { compute_capability: '6.1' },
}
const oldDriver: GpuProbeInfo = { ...rtx4090, driver_version: '470.00' }
const rx7900: GpuProbeInfo = {
  vendor: 'AMD',
  total_memory: 24_576,
  nvidia_info: null,
  vulkan_info: { device_type: 'DiscreteGpu', device_id: 0x744c },
}
const intelIgpu: GpuProbeInfo = {
  vendor: 'Intel',
  total_memory: 8_192,
  nvidia_info: null,
  vulkan_info: { device_type: 'IntegratedGpu', device_id: 0x46a6 },
}
const ROCM_OK = { gfxTargetVersions: [110000], hasRuntime: true }

const supportedOn = (
  os: string,
  arch: string,
  gpus: GpuProbeInfo[],
  rocm = undefined as typeof ROCM_OK | undefined
) => determinePrismSupportedBackends(os, arch, getPrismSupportedFeatures(os, ['avx2'], gpus, rocm))

describe('getPrismSupportedFeatures', () => {
  it('adds Linux ROCm from the host probe and never sets OpenCL', () => {
    expect(getPrismSupportedFeatures('linux', [], [rx7900], ROCM_OK).rocm).toBe(true)
    expect(getPrismSupportedFeatures('linux', [], [rx7900]).rocm).toBe(false)
    expect(
      getPrismSupportedFeatures('windows', [], [{ ...intelIgpu, vendor: 'Qualcomm' }]).opencl
    ).toBeUndefined()
  })
})

describe('determinePrismSupportedBackends', () => {
  it.each([
    ['macOS arm64', 'macos', 'aarch64', [], undefined, ['macos-arm64']],
    ['macOS x64', 'macos', 'x86_64', [], undefined, ['macos-x64']],
    [
      'Linux RTX 4090',
      'linux',
      'x86_64',
      [rtx4090],
      undefined,
      [
        'linux-cpu-x64',
        'linux-cuda-12.4-x64',
        'linux-cuda-12.8-x64',
        'linux-cuda-13.3-x64',
        'linux-vulkan-x64',
      ],
    ],
    [
      'Linux GTX 1080 (no CUDA 13)',
      'linux',
      'x86_64',
      [gtx1080],
      undefined,
      ['linux-cpu-x64', 'linux-cuda-12.4-x64', 'linux-cuda-12.8-x64', 'linux-vulkan-x64'],
    ],
    [
      'Linux NVIDIA with an old driver',
      'linux',
      'x86_64',
      [oldDriver],
      undefined,
      ['linux-cpu-x64', 'linux-vulkan-x64'],
    ],
    [
      'Linux AMD with ROCm',
      'linux',
      'x86_64',
      [rx7900],
      ROCM_OK,
      ['linux-cpu-x64', 'linux-rocm-7.2-x64', 'linux-vulkan-x64'],
    ],
    ['Linux without a GPU', 'linux', 'x86_64', [], undefined, ['linux-cpu-x64']],
    [
      'Windows RTX 4090',
      'windows',
      'x86_64',
      [rtx4090],
      undefined,
      ['win-cpu-x64', 'win-cuda-12.4-x64', 'win-cuda-13.3-x64', 'win-vulkan-x64'],
    ],
    [
      'Windows RX 7900',
      'windows',
      'x86_64',
      [rx7900],
      undefined,
      ['win-cpu-x64', 'win-hip-radeon-x64', 'win-vulkan-x64'],
    ],
    ['Windows arm64 (deferred)', 'windows', 'aarch64', [], undefined, []],
    ['Linux arm64 (deferred)', 'linux', 'aarch64', [rtx4090], undefined, []],
  ])('%s', (_label, os, arch, gpus, rocm, expected) => {
    expect(supportedOn(os, arch, gpus as GpuProbeInfo[], rocm)).toEqual(expected)
  })
  it('refuses an unknown OS', () => {
    expect(() =>
      determinePrismSupportedBackends('freebsd', 'x86_64', {
        cuda11: false,
        cuda12: false,
        cuda13: false,
        vulkan: false,
        rocm: false,
      })
    ).toThrow(/Unsupported system type/)
  })
})

describe('getPrismBackendCategory', () => {
  it.each([
    ['linux-cuda-13.3-x64', 'cuda-cu13.0'],
    ['win-cuda-12.4-x64', 'cuda-cu12.0'],
    ['linux-cuda-12.8-x64', 'cuda-cu12.0'],
    ['linux-rocm-7.2-x64', 'rocm'],
    ['win-hip-radeon-x64', 'rocm'],
    ['win-vulkan-x64', 'vulkan'],
    ['linux-cpu-x64', 'common_cpus'],
    ['macos-arm64', 'arm64'],
    ['macos-x64', 'x64'],
    ['something-else', null],
  ])('%s → %s', (id, category) => {
    expect(getPrismBackendCategory(id)).toBe(category)
  })
})

describe('sorting, merging, filtering', () => {
  it('sorts the newest build first, then the newer CUDA minor', () => {
    const list: BackendVersion[] = [
      { version: T1, backend: 'linux-cuda-12.8-x64' },
      { version: T2, backend: 'linux-cuda-12.4-x64' },
      { version: T2, backend: 'linux-cuda-12.8-x64' },
    ]
    expect([...list].sort(comparePrismBackendsForSort)).toEqual([
      { version: T2, backend: 'linux-cuda-12.8-x64' },
      { version: T2, backend: 'linux-cuda-12.4-x64' },
      { version: T1, backend: 'linux-cuda-12.8-x64' },
    ])
  })
  it('merges remote and installed without duplicates, keeping the installed order', () => {
    const merged = mergePrismBackends(
      [
        { version: T2, backend: 'macos-arm64' },
        { version: T1, backend: 'macos-arm64' },
      ],
      [{ version: T1, backend: 'macos-arm64', order: 5 }]
    )
    expect(merged).toEqual([
      { version: T2, backend: 'macos-arm64' },
      { version: T1, backend: 'macos-arm64', order: 5 },
    ])
  })
  it('filters by the supported ids', () => {
    expect(
      filterPrismBackendsBySupport(
        [
          { version: T1, backend: 'macos-arm64' },
          { version: T1, backend: 'linux-cpu-x64' },
        ],
        ['linux-cpu-x64']
      )
    ).toEqual([{ version: T1, backend: 'linux-cpu-x64' }])
  })
})

describe('determineBestPrismBackend', () => {
  const all: BackendVersion[] = [
    { version: T1, backend: 'linux-cpu-x64' },
    { version: T1, backend: 'linux-vulkan-x64' },
    { version: T1, backend: 'linux-cuda-12.4-x64' },
    { version: T2, backend: 'linux-cuda-12.4-x64' },
  ]
  it.each([
    ['CUDA wins and the newest build of it', all, [rtx4090], `${T2}/linux-cuda-12.4-x64`],
    ['Vulkan beats CPU with enough VRAM', all.slice(0, 2), [rx7900], `${T1}/linux-vulkan-x64`],
    ['CPU beats Vulkan on an integrated GPU', all.slice(0, 2), [intelIgpu], `${T1}/linux-cpu-x64`],
    ['empty catalog', [], [rtx4090], ''],
  ])('%s', (_label, list, gpus, expected) => {
    expect(determineBestPrismBackend(list as BackendVersion[], gpus as GpuProbeInfo[])).toBe(expected)
  })
})

describe('findLatestPrismVersionForBackend / checkPrismBackendForUpdates', () => {
  const list: BackendVersion[] = [
    { version: T1, backend: 'macos-arm64' },
    { version: T2, backend: 'macos-arm64' },
    { version: T2, backend: 'linux-cpu-x64' },
  ]
  it('finds the newest build of one id', () => {
    expect(findLatestPrismVersionForBackend(list, 'macos-arm64')).toBe(`${T2}/macos-arm64`)
    expect(findLatestPrismVersionForBackend(list, 'win-cpu-x64')).toBeNull()
  })
  it.each([
    [
      'an older build',
      `${T1}/macos-arm64`,
      { update_needed: true, new_version: T2, target_backend: `${T2}/macos-arm64` },
    ],
    [
      'the newest build',
      `${T2}/macos-arm64`,
      { update_needed: false, new_version: '0', target_backend: null },
    ],
    [
      'a backend not listed',
      `${T1}/win-cpu-x64`,
      { update_needed: false, new_version: '0', target_backend: null },
    ],
    [
      'a build newer than the catalog',
      'prism-b99999-bbbbbbb/macos-arm64',
      { update_needed: false, new_version: '0', target_backend: null },
    ],
  ])('%s', (_label, current, expected) => {
    expect(checkPrismBackendForUpdates(current, list)).toEqual(expected)
  })
  it('refuses a malformed current', () => {
    expect(() => checkPrismBackendForUpdates('macos-arm64', list)).toThrow(/Invalid current backend/)
  })
})

describe('detectIdealPrismBackendType', () => {
  const catalog = (ids: string[]) => async () => ids.map((backend) => ({ version: T1, backend }))
  it.each([
    ['macOS', 'macos', [], [], { kind: 'cpu-optimal' }],
    [
      'Windows CUDA 13',
      'windows',
      [rtx4090],
      ['win-cpu-x64', 'win-cuda-12.4-x64', 'win-cuda-13.3-x64'],
      { kind: 'gpu', backend: 'win-cuda-13.3-x64' },
    ],
    [
      'Linux prefers CUDA 12.8 over 12.4',
      'linux',
      [gtx1080],
      ['linux-cuda-12.4-x64', 'linux-cuda-12.8-x64'],
      { kind: 'gpu', backend: 'linux-cuda-12.8-x64' },
    ],
    [
      'Windows AMD HIP',
      'windows',
      [rx7900],
      ['win-cpu-x64', 'win-hip-radeon-x64', 'win-vulkan-x64'],
      { kind: 'gpu', backend: 'win-hip-radeon-x64' },
    ],
    [
      'Vulkan when no CUDA build is offered',
      'linux',
      [rtx4090],
      ['linux-cpu-x64', 'linux-vulkan-x64'],
      { kind: 'gpu', backend: 'linux-vulkan-x64' },
    ],
    ['nothing approved for the GPU yet', 'windows', [rtx4090], ['win-cpu-x64'], { kind: 'cpu-optimal' }],
    [
      'integrated GPU only',
      'linux',
      [intelIgpu],
      ['linux-cpu-x64', 'linux-vulkan-x64'],
      { kind: 'cpu-optimal' },
    ],
  ])('%s', async (_label, osType, gpus, ids, expected) => {
    const result = await detectIdealPrismBackendType({
      osType,
      arch: 'x86_64',
      cpuExtensions: ['avx2'],
      gpus: gpus as GpuProbeInfo[],
      listAvailableBackends: catalog(ids as string[]),
    })
    expect(result).toEqual(expected)
  })
  it('is a detection failure when the catalog throws', async () => {
    const warnings: string[] = []
    const result = await detectIdealPrismBackendType({
      osType: 'linux',
      arch: 'x86_64',
      cpuExtensions: [],
      gpus: [rtx4090],
      listAvailableBackends: () => Promise.reject(new Error('boom')),
      onWarn: (m) => warnings.push(m),
    })
    expect(result).toEqual({ kind: 'detection-failed' })
    expect(warnings[0]).toMatch(/boom/)
  })
})
