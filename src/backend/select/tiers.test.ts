import { describe, expect, it, vi } from 'vitest'
import type { BackendFeatures, BackendVersion, GpuProbeInfo, TierHealth } from '../types.js'
import { AMD_ROCM_WINDOWS_PCI_IDS } from './amd-rocm-pci-ids.js'
import {
  classifyTierProbe,
  detectIdealBackendType,
  hasCorroboratingGpu,
  hasDiscreteGpu,
  integratedGpuOnly,
  isGpuBackendId,
  pickFirstWorkingTier,
  tierEnumeratesDevices,
  windowsGpuTiers,
} from './tiers.js'

const b = (version: string, backend: string, order = 0): BackendVersion => ({ version, backend, order })
const features = (over: Partial<BackendFeatures> = {}): BackendFeatures => ({
  cuda11: false,
  cuda12: false,
  cuda13: false,
  vulkan: false,
  rocm: false,
  ...over,
})
const nvidia = (driver: string, cc = '8.9', extra: Partial<GpuProbeInfo> = {}): GpuProbeInfo => ({
  driver_version: driver,
  vendor: 'NVIDIA',
  nvidia_info: { compute_capability: cc },
  vulkan_info: null,
  ...extra,
})
const SUPPORTED_AMD_ID = AMD_ROCM_WINDOWS_PCI_IDS[0]![0]
const amd = (deviceId: number | null = SUPPORTED_AMD_ID): GpuProbeInfo => ({
  driver_version: '0.0',
  vendor: 'AMD',
  nvidia_info: null,
  vulkan_info: { api_version: '1.3', device_id: deviceId, device_type: 'DiscreteGpu' },
})

describe('GPU memory and corroboration helpers', () => {
  it('hasDiscreteGpu / integratedGpuOnly', () => {
    const igpu: GpuProbeInfo = { vulkan_info: { device_type: 'IntegratedGpu' }, total_memory: 8192 }
    expect(hasDiscreteGpu([igpu])).toBe(false)
    expect(hasDiscreteGpu([nvidia('581.42')])).toBe(true)
    expect(integratedGpuOnly([igpu])).toBe(true)
    expect(integratedGpuOnly([igpu, amd()])).toBe(false)
    expect(integratedGpuOnly([])).toBe(false)
  })
  it('hasCorroboratingGpu', () => {
    expect(hasCorroboratingGpu('win-cuda-13.3-x64', [nvidia('581.42')])).toBe(true)
    expect(hasCorroboratingGpu('win-cuda-13.3-x64', [amd()])).toBe(false)
    expect(hasCorroboratingGpu('win-vulkan-x64', [amd()])).toBe(true)
    expect(hasCorroboratingGpu('win-vulkan-x64', [])).toBe(false)
    expect(hasCorroboratingGpu('win-cpu-x64', [])).toBe(true)
  })
  it('isGpuBackendId', () => {
    expect(
      // The app's regex needs a `-` right after the first digit, so only Vulkan ids match in practice.
      ['win-vulkan-x64', 'linux-vulkan-x64', 'win-cuda-1-x64'].every(isGpuBackendId)
    ).toBe(true)
    expect(
      ['win-cuda-13.3-x64', 'win-rocm-10.0-x64', 'win-cpu-x64', 'win-cuda-13-x64', 'macos-arm64'].some(
        isGpuBackendId
      )
    ).toBe(false)
  })
})

describe('tier probing', () => {
  const device = { id: 'CUDA0', name: 'RTX 4090', mem: 24576, free: 24000 }
  it.each([
    [{ installed: false, devices: null, corroborated: false }, 'unverified'],
    [{ installed: true, devices: [device], corroborated: false }, 'works'],
    [{ installed: true, devices: [], corroborated: true }, 'unverified'],
    [{ installed: true, devices: null, corroborated: true }, 'unverified'],
    [{ installed: true, devices: [], corroborated: false }, 'broken'],
  ])('classifyTierProbe(%o) = %s', (input, expected) => {
    expect(classifyTierProbe(input)).toBe(expected)
  })
  it('tierEnumeratesDevices walks the decision with injected probes', async () => {
    const installed = [b('b10809', 'win-cuda-13.3-x64', 7)]
    const log: string[] = []
    const run = (
      gpus: GpuProbeInfo[],
      list: () => Promise<BackendVersion[]>,
      devices: () => Promise<(typeof device)[]>
    ) =>
      tierEnumeratesDevices('win-cuda-13.3-x64', gpus, { listInstalled: list, listDevices: devices }, (m) =>
        log.push(m)
      )
    expect(
      await run(
        [],
        async () => [],
        async () => [device]
      )
    ).toBe('unverified')
    expect(
      await run(
        [],
        async () => {
          throw new Error('scan failed')
        },
        async () => [device]
      )
    ).toBe('unverified')
    const seen: BackendVersion[] = []
    expect(
      await run(
        [],
        async () => installed,
        async (entry: BackendVersion = installed[0]!) => {
          seen.push(entry)
          return [device]
        }
      )
    ).toBe('works')
    expect(
      await run(
        [nvidia('581.42')],
        async () => installed,
        async () => []
      )
    ).toBe('unverified')
    expect(
      await run(
        [],
        async () => installed,
        async () => {
          throw new Error('cuInit failed')
        }
      )
    ).toBe('broken')
    expect(log.some((m) => m.includes('scan failed'))).toBe(true)
    expect(log.some((m) => m.includes('corroborates a matching GPU'))).toBe(true)
    expect(log.some((m) => m.includes('cuInit failed') && m.includes('is broken'))).toBe(true)
  })
  it('pickFirstWorkingTier skips broken tiers', async () => {
    const verdicts: Record<string, TierHealth> = { a: 'broken', b: 'unverified', c: 'works' }
    expect(await pickFirstWorkingTier(['a', 'b', 'c'], async (t) => verdicts[t]!)).toBe('b')
    expect(await pickFirstWorkingTier(['a'], async () => 'broken')).toBeNull()
    expect(await pickFirstWorkingTier([], async () => 'works')).toBeNull()
  })
  it('windowsGpuTiers orders CUDA 13, CUDA 12, ROCm, Vulkan with the VRAM and iGPU gates', () => {
    const catalog = [
      b('b10809', 'win-cuda-13.3-x64'),
      b('b10000', 'win-cuda-13.1-x64'),
      b('b10809', 'win-cuda-12.4-x64'),
      b('b10809', 'win-rocm-10.0-x64'),
      b('b10809', 'win-vulkan-x64'),
    ]
    const all = features({ cuda12: true, cuda13: true, rocm: true, vulkan: true })
    expect(windowsGpuTiers(all, catalog, 'x64', [amd(), { total_memory: 8192 }])).toEqual([
      'win-cuda-13.3-x64',
      'win-cuda-12.4-x64',
      'win-rocm-10.0-x64',
      'win-vulkan-x64',
    ])
    expect(windowsGpuTiers(all, catalog, 'x64', [{ total_memory: 1024 }])).toEqual([
      'win-cuda-13.3-x64',
      'win-cuda-12.4-x64',
    ])
    const igpu: GpuProbeInfo = { vulkan_info: { device_type: 'IntegratedGpu' }, total_memory: 8192 }
    expect(windowsGpuTiers(features({ vulkan: true }), catalog, 'x64', [igpu])).toEqual([])
    expect(windowsGpuTiers(all, catalog, 'arm64', [amd()])).toEqual([])
  })
})

describe('detectIdealBackendType', () => {
  const catalog = [
    b('b10809', 'win-cuda-13.3-x64'),
    b('b10809', 'win-cuda-12.4-x64'),
    b('b10809', 'win-vulkan-x64'),
    b('b10809', 'win-cpu-x64'),
  ]
  const windows = (
    gpus: GpuProbeInfo[],
    available: BackendVersion[] = catalog,
    verdict: (t: string) => TierHealth = () => 'works'
  ) =>
    detectIdealBackendType({
      osType: 'windows',
      arch: 'x86_64',
      cpuExtensions: [],
      gpus,
      listAvailableBackends: async () => available,
      probeTier: async (t) => verdict(t),
    })

  it('windows: picks the first surviving tier', async () => {
    expect(await windows([nvidia('581.42', '8.9', { total_memory: 24576 })])).toEqual({
      kind: 'gpu',
      backend: 'win-cuda-13.3-x64',
    })
    expect(
      await windows([nvidia('581.42', '8.9', { total_memory: 24576 })], catalog, (t) =>
        t.includes('13.3') ? 'broken' : 'works'
      )
    ).toEqual({
      kind: 'gpu',
      backend: 'win-cuda-12.4-x64',
    })
  })
  it('windows: GPU-capable host with an empty catalog is detection-failed; no GPU is cpu-optimal', async () => {
    expect(
      await windows([nvidia('581.42', '8.9', { total_memory: 24576 })], [b('b10809', 'win-cpu-x64')])
    ).toEqual({ kind: 'detection-failed' })
    expect(await windows([])).toEqual({ kind: 'cpu-optimal' })
    const igpu: GpuProbeInfo = {
      driver_version: '0',
      vulkan_info: { api_version: '1.3', device_type: 'IntegratedGpu' },
      total_memory: 8192,
    }
    expect(await windows([igpu])).toEqual({ kind: 'cpu-optimal' })
  })
  it('windows: every tier broken degrades to cpu-optimal when the catalog has GPU builds', async () => {
    expect(
      await windows([nvidia('581.42', '8.9', { total_memory: 24576 })], catalog, () => 'broken')
    ).toEqual({ kind: 'cpu-optimal' })
  })
  it('windows: a throwing catalog is detection-failed', async () => {
    const warn = vi.fn()
    const r = await detectIdealBackendType({
      osType: 'windows',
      arch: 'x86_64',
      cpuExtensions: [],
      gpus: [],
      listAvailableBackends: async () => {
        throw new Error('offline')
      },
      probeTier: async () => 'works',
      onWarn: warn,
    })
    expect(r).toEqual({ kind: 'detection-failed' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('offline'))
  })
  it('linux: vulkan with a visible ≥2 GiB device, detection-failed when the loader cannot see the GPU, else cpu', async () => {
    const linux = (gpus: GpuProbeInfo[], arch = 'x86_64') =>
      detectIdealBackendType({
        osType: 'linux',
        arch,
        cpuExtensions: [],
        gpus,
        listAvailableBackends: async () => [],
        probeTier: async () => 'works',
      })
    expect(await linux([{ vulkan_info: { api_version: '1.3' }, total_memory: 4096 }])).toEqual({
      kind: 'gpu',
      backend: 'linux-vulkan-x64',
    })
    expect(await linux([{ vulkan_info: { api_version: '1.3' }, total_memory: 1024 }])).toEqual({
      kind: 'cpu-optimal',
    })
    expect(await linux([nvidia('581.42', '8.9', { total_memory: 8192 })])).toEqual({
      kind: 'detection-failed',
    })
    expect(await linux([])).toEqual({ kind: 'cpu-optimal' })
    expect(await linux([{ vulkan_info: { api_version: '1.3' }, total_memory: 4096 }], 'aarch64')).toEqual({
      kind: 'cpu-optimal',
    })
  })
  it('macos: always cpu-optimal', async () => {
    expect(
      await detectIdealBackendType({
        osType: 'macos',
        arch: 'arm64',
        cpuExtensions: [],
        gpus: [],
        listAvailableBackends: async () => [],
        probeTier: async () => 'works',
      })
    ).toEqual({ kind: 'cpu-optimal' })
  })
})
