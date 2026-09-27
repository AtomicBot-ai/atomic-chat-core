import { describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { BackendVersion, GpuProbeInfo } from '../types.js'
import {
  checkTurboquantBackendForUpdates,
  detectIdealTurboquantBackendType,
  findLatestTurboquantVersionForBackend,
  isTurboquantGpuBackendId,
} from './turboquant-tiers.js'

const TAG = 'b10269-1.4.0'
const at = (ids: string[], version = TAG): BackendVersion[] =>
  ids.map((backend) => ({ version, backend, order: 0 }))
const WINDOWS = at([
  'windows-x64-cpu',
  'windows-x64-cuda-12.4',
  'windows-x64-cuda-13.3',
  'windows-x64-vulkan',
])
const LINUX = at([
  'linux-x64-cpu',
  'linux-x64-cuda-12.4',
  'linux-x64-cuda-13.3',
  'linux-x64-rocm',
  'linux-x64-vulkan',
])

// The canonical hosts of the advisor tests, as the core's probe describes them.
const rtx4090: GpuProbeInfo = {
  vendor: 'NVIDIA',
  driver_version: '581.42',
  total_memory: 24_576,
  nvidia_info: { compute_capability: '8.9' },
  vulkan_info: { device_type: 'DiscreteGpu', device_id: 0x2684 },
}
const gtx1080: GpuProbeInfo = {
  vendor: 'NVIDIA',
  driver_version: '560.94',
  total_memory: 8_192,
  nvidia_info: { compute_capability: '6.1' },
  vulkan_info: { device_type: 'DiscreteGpu', device_id: 0x1b80 },
}
const rx7900xtx: GpuProbeInfo = {
  vendor: 'AMD',
  driver_version: '32.0.12033.1030',
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
const smallAmd: GpuProbeInfo = { ...rx7900xtx, total_memory: 4_096 }

const detect = (
  osType: string,
  gpus: GpuProbeInfo[],
  catalog: BackendVersion[],
  extra: { arch?: string; rocm?: { gfxTargetVersions: number[]; hasRuntime: boolean } } = {}
) =>
  detectIdealTurboquantBackendType({
    osType,
    arch: extra.arch ?? 'x86_64',
    cpuExtensions: ['avx2'],
    gpus,
    ...(extra.rocm ? { rocm: extra.rocm } : {}),
    listAvailableBackends: async () => catalog,
  })

describe('isTurboquantGpuBackendId', () => {
  it.each([
    ['windows-x64-cuda-13.3', true],
    ['linux-x64-rocm', true],
    ['\uFEFFwindows-x64-vulkan', true],
    ['windows-x64-cpu', false],
    ['macos-arm64', false],
  ])('%s → %s', (id, expected) => {
    expect(isTurboquantGpuBackendId(id)).toBe(expected)
  })
})

describe('detectIdealTurboquantBackendType', () => {
  it.each([
    [
      'Windows RTX 4090 (581.42, cc 8.9)',
      'windows',
      [rtx4090],
      WINDOWS,
      { kind: 'gpu', backend: 'windows-x64-cuda-13.3' },
    ],
    [
      'Windows GTX 1080 (560, cc 6.1): CUDA 12 via the fork floor',
      'windows',
      [gtx1080],
      WINDOWS,
      { kind: 'gpu', backend: 'windows-x64-cuda-12.4' },
    ],
    [
      'Windows 7900 XTX: no fork ROCm on Windows, so Vulkan',
      'windows',
      [rx7900xtx],
      WINDOWS,
      { kind: 'gpu', backend: 'windows-x64-vulkan' },
    ],
    ['Windows Intel iGPU only', 'windows', [intelIgpu], WINDOWS, { kind: 'cpu-optimal' }],
    ['Windows no GPU', 'windows', [], WINDOWS, { kind: 'cpu-optimal' }],
    [
      'Windows RTX 4090 with a catalog missing CUDA falls through to Vulkan',
      'windows',
      [rtx4090],
      at(['windows-x64-cpu', 'windows-x64-vulkan']),
      { kind: 'gpu', backend: 'windows-x64-vulkan' },
    ],
    [
      'Windows RTX 4090 with a CPU-only catalog: detection failed',
      'windows',
      [rtx4090],
      at(['windows-x64-cpu']),
      { kind: 'detection-failed' },
    ],
    [
      'Windows RTX 4090 with an empty catalog: detection failed',
      'windows',
      [rtx4090],
      [],
      { kind: 'detection-failed' },
    ],
    ['Windows 4 GiB AMD: below the 6 GiB floor', 'windows', [smallAmd], WINDOWS, { kind: 'cpu-optimal' }],
    [
      'Linux RTX 4090: the fork ships Linux CUDA',
      'linux',
      [rtx4090],
      LINUX,
      { kind: 'gpu', backend: 'linux-x64-cuda-13.3' },
    ],
    ['Linux GTX 1080: CUDA 12', 'linux', [gtx1080], LINUX, { kind: 'gpu', backend: 'linux-x64-cuda-12.4' }],
    [
      'Linux 7900 XTX without a ROCm runtime: Vulkan',
      'linux',
      [rx7900xtx],
      LINUX,
      { kind: 'gpu', backend: 'linux-x64-vulkan' },
    ],
    ['Linux 4 GiB AMD: CPU', 'linux', [smallAmd], LINUX, { kind: 'cpu-optimal' }],
    ['Linux Intel iGPU only', 'linux', [intelIgpu], LINUX, { kind: 'cpu-optimal' }],
    ['Linux no GPU', 'linux', [], LINUX, { kind: 'cpu-optimal' }],
    [
      'Linux 7900 XTX with an empty catalog: detection failed',
      'linux',
      [rx7900xtx],
      [],
      { kind: 'detection-failed' },
    ],
    [
      'Linux RTX 4090 with a CPU-only catalog: detection failed',
      'linux',
      [rtx4090],
      at(['linux-x64-cpu']),
      { kind: 'detection-failed' },
    ],
  ] as const)('%s', async (_label, osType, gpus, catalog, expected) => {
    expect(await detect(osType, [...gpus], [...catalog])).toEqual(expected)
  })

  it('picks ROCm on Linux only when amdkfd and HIP both say so', async () => {
    const rocm = { gfxTargetVersions: [110000], hasRuntime: true }
    expect(await detect('linux', [rx7900xtx], LINUX, { rocm })).toEqual({
      kind: 'gpu',
      backend: 'linux-x64-rocm',
    })
    expect(await detect('linux', [rx7900xtx], LINUX, { rocm: { ...rocm, hasRuntime: false } })).toEqual({
      kind: 'gpu',
      backend: 'linux-x64-vulkan',
    })
    // ROCm shares Vulkan's VRAM guard.
    expect(await detect('linux', [smallAmd], LINUX, { rocm })).toEqual({ kind: 'cpu-optimal' })
  })

  it('never consults the catalog on macOS or arm64 Linux', async () => {
    const list = vi.fn(async () => LINUX)
    expect(
      await detectIdealTurboquantBackendType({
        osType: 'macos',
        arch: 'arm64',
        cpuExtensions: [],
        gpus: [],
        listAvailableBackends: list,
      })
    ).toEqual({ kind: 'cpu-optimal' })
    expect(await detect('linux', [rtx4090], LINUX, { arch: 'aarch64' })).toEqual({ kind: 'cpu-optimal' })
    expect(list).not.toHaveBeenCalled()
  })

  it('tolerates BOMs in catalog ids and matches a future CUDA minor', async () => {
    const catalog = at(['\uFEFFwindows-x64-cuda-13.4', 'windows-x64-cpu'])
    expect(await detect('windows', [rtx4090], catalog)).toEqual({
      kind: 'gpu',
      backend: 'windows-x64-cuda-13.4',
    })
  })

  it('maps a throwing catalog to detection-failed and warns', async () => {
    const warn = vi.fn()
    expect(
      await detectIdealTurboquantBackendType({
        osType: 'windows',
        arch: 'x86_64',
        cpuExtensions: [],
        gpus: [rtx4090],
        listAvailableBackends: async () => {
          throw new Error('offline')
        },
        onWarn: warn,
      })
    ).toEqual({ kind: 'detection-failed' })
    expect(warn).toHaveBeenCalledWith('detectIdealBackendType failed: offline')
  })
})

describe('findLatestTurboquantVersionForBackend / checkTurboquantBackendForUpdates', () => {
  const list: BackendVersion[] = [
    { version: 'b10018-1.3.0', backend: 'linux-x64-vulkan', order: 0 },
    { version: 'turboquant-linux-x64-vulkan-d86eb0b', backend: 'linux', order: 99 },
    { version: TAG, backend: 'linux-x64-vulkan', order: 0 },
    { version: TAG, backend: 'linux-x64-cuda-13.3', order: 0 },
    { version: 'b9000', backend: 'win-cuda-13.3-x64', order: 5 },
    { version: TAG, backend: 'windows-x64-cuda-13.3', order: 0 },
  ]

  it('ranks unified tags above legacy ones and matches legacy ids through the fork mapping', () => {
    expect(findLatestTurboquantVersionForBackend(list, 'linux-x64-vulkan')).toBe(`${TAG}/linux-x64-vulkan`)
    expect(findLatestTurboquantVersionForBackend(list, 'windows-x64-cuda-13.3')).toBe(
      `${TAG}/windows-x64-cuda-13.3`
    )
    expect(findLatestTurboquantVersionForBackend(list, 'linux-x64-rocm')).toBeNull()
    expect(findLatestTurboquantVersionForBackend([], 'linux-x64-vulkan')).toBeNull()
  })

  it('offers the newest build of the current type, also across the legacy naming', () => {
    expect(checkTurboquantBackendForUpdates('b10018-1.3.0/linux-x64-vulkan', list)).toEqual({
      update_needed: true,
      new_version: TAG,
      target_backend: `${TAG}/linux-x64-vulkan`,
    })
    expect(checkTurboquantBackendForUpdates('b9000/win-cuda-13.3-x64', list)).toEqual({
      update_needed: true,
      new_version: TAG,
      target_backend: `${TAG}/windows-x64-cuda-13.3`,
    })
    expect(checkTurboquantBackendForUpdates(`${TAG}/linux-x64-vulkan`, list)).toEqual({
      update_needed: false,
      new_version: '0',
      target_backend: null,
    })
    expect(checkTurboquantBackendForUpdates('b1-1.0.0/linux-x64-rocm', list)).toEqual({
      update_needed: false,
      new_version: '0',
      target_backend: null,
    })
  })

  it('rejects a current backend that is not <tag>/<id>', () => {
    expect(() => checkTurboquantBackendForUpdates('none', list)).toThrow(AtomicCoreError)
    expect(() => checkTurboquantBackendForUpdates('a/b/c', list)).toThrow(/Invalid current backend format/)
  })
})
