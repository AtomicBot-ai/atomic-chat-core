import { describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import { AMD_ROCM_WINDOWS_PCI_IDS } from './amd-rocm-pci-ids.js'
import {
  backendCategoryToLabel,
  checkBackendForUpdates,
  classifyTierProbe,
  CUDA_DRIVER_FLOORS,
  detectIdealBackendType,
  determineBestBackend,
  determineSupportedBackends,
  filterBackendsBySupport,
  findLatestVersionForBackend,
  getBackendCategory,
  getSupportedFeatures,
  GPU_BACKEND_MIN_VRAM_MIB,
  gpuMeetsCuda13ArchFloor,
  hasCorroboratingGpu,
  hasDiscreteGpu,
  hasEnoughGpuMemory,
  integratedGpuOnly,
  isAmdGpu,
  isBundledNewerSameType,
  isGpuBackendId,
  isPersistedVersionBackendMissing,
  latestBackendOptions,
  listSupportedBackends,
  MIN_CUDA13_COMPUTE_CAPABILITY,
  normalizeFeatures,
  parseComputeCapability,
  pickFirstWorkingTier,
  prioritizeBackends,
  recoverVersionBackendFromDisk,
  rocmSupportedWindows,
  sameTypeUpgradeCandidate,
  savedBackendVanished,
  shouldApplyBundledBackend,
  staticLatestVariants,
  tierEnumeratesDevices,
  windowsGpuTiers,
} from './select.js'
import type { BackendFeatures, BackendVersion, GpuProbeInfo, TierHealth } from './types.js'

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

describe('parseComputeCapability / gpuMeetsCuda13ArchFloor (Rust test_parse_compute_capability)', () => {
  it.each([
    ['7.0', [7, 0]],
    ['7.5', [7, 5]],
    [' 12.0 ', [12, 0]],
    ['8', [8, 0]],
    ['7.x', [7, 0]],
    ['', undefined],
    ['unknown', undefined],
  ])('parseComputeCapability(%j) = %j', (input, expected) => {
    expect(parseComputeCapability(input)).toEqual(expected)
  })
  it('gates on the Turing floor with tuple comparison', () => {
    expect(MIN_CUDA13_COMPUTE_CAPABILITY).toEqual([7, 5])
    expect(gpuMeetsCuda13ArchFloor('7.5')).toBe(true)
    expect(gpuMeetsCuda13ArchFloor('7.0')).toBe(false)
    expect(gpuMeetsCuda13ArchFloor('10.0')).toBe(true)
    expect(gpuMeetsCuda13ArchFloor('')).toBe(true)
    expect(gpuMeetsCuda13ArchFloor(undefined)).toBe(true)
  })
})

describe('getSupportedFeatures (Rust test_get_supported_features_* and driver-floor tests)', () => {
  it('reports CPU extensions only for a host without GPUs', () => {
    const r = getSupportedFeatures('linux', ['avx', 'avx2'], [])
    expect(r).toEqual({
      avx: true,
      avx2: true,
      avx512: false,
      cuda11: false,
      cuda12: false,
      cuda13: false,
      vulkan: false,
      rocm: false,
    })
  })
  it('applies the Linux driver floors', () => {
    const r = getSupportedFeatures('linux', [], [nvidia('530.00', '8.0')])
    expect([r.cuda11, r.cuda12, r.cuda13]).toEqual([true, true, false])
    expect(CUDA_DRIVER_FLOORS.linux.cuda13).toBe('580')
  })
  it('sets vulkan from vulkan_info and never on macOS', () => {
    const gpu: GpuProbeInfo = { driver_version: '0.0', vulkan_info: { api_version: '1.3' } }
    expect(getSupportedFeatures('windows', [], [gpu])).toMatchObject({ vulkan: true, cuda11: false })
    expect(getSupportedFeatures('macos', [], [gpu])).toMatchObject({ vulkan: false })
  })
  it.each([
    ['581.14', true, false],
    ['581.15', true, true],
    ['581.42', true, true],
    ['551.61', true, false],
    ['550.00', false, false],
  ])('Windows driver %s → cuda12=%s cuda13=%s', (driver, cuda12, cuda13) => {
    expect(getSupportedFeatures('windows', [], [nvidia(driver)])).toMatchObject({ cuda12, cuda13 })
  })
  it('vetoes CUDA 13 for Volta / Pascal / Maxwell despite a new driver, keeps CUDA 12.4', () => {
    for (const cc of ['7.0', '6.1', '5.2']) {
      expect(getSupportedFeatures('windows', [], [nvidia('581.42', cc)])).toMatchObject({
        cuda12: true,
        cuda13: false,
      })
    }
  })
  it('lets Turing, Blackwell and an unknown capability through', () => {
    for (const cc of ['7.5', '10.0', '12.0', '']) {
      expect(getSupportedFeatures('windows', [], [nvidia('581.42', cc)]).cuda13).toBe(true)
    }
    expect(getSupportedFeatures('windows', [], [{ driver_version: '581.42', nvidia_info: {} }]).cuda13).toBe(
      true
    )
  })
  it('lets one old GPU veto CUDA 13 for the whole host', () => {
    const r = getSupportedFeatures('windows', [], [nvidia('581.42', '8.9'), nvidia('581.42', '7.0')])
    expect(r).toMatchObject({ cuda12: true, cuda13: false })
  })
  it('enables ROCm on Windows only, from the PCI table', () => {
    expect(getSupportedFeatures('windows', [], [amd()])).toMatchObject({ rocm: true, vulkan: true })
    expect(getSupportedFeatures('linux', [], [amd()])).toMatchObject({ rocm: false, vulkan: true })
    expect(getSupportedFeatures('windows', [], [amd(0x687f)])).toMatchObject({ rocm: false })
    expect(getSupportedFeatures('windows', [], [amd(null)])).toMatchObject({ rocm: false })
  })
  it('rocmSupportedWindows / isAmdGpu', () => {
    expect(rocmSupportedWindows(true, [SUPPORTED_AMD_ID])).toBe(true)
    expect(rocmSupportedWindows(false, [SUPPORTED_AMD_ID])).toBe(false)
    expect(rocmSupportedWindows(true, [0x687f])).toBe(false)
    expect(rocmSupportedWindows(true, [])).toBe(false)
    expect(rocmSupportedWindows(true, [0x687f, SUPPORTED_AMD_ID])).toBe(true)
    expect(isAmdGpu({ vendor: 'amd' })).toBe(true)
    expect(isAmdGpu({ vendor: 'NVIDIA' })).toBe(false)
    expect(isAmdGpu({})).toBe(false)
  })
  it('normalizeFeatures fills missing flags', () => {
    expect(normalizeFeatures({ cuda12: true })).toEqual(features({ cuda12: true }))
    expect(normalizeFeatures(undefined)).toEqual(features())
  })
})

describe('determineSupportedBackends (Rust test_determine_supported_backends_*)', () => {
  it('windows: cpu, cuda 12.4, vulkan; no cuda 11; cuda 13 only as the family id', () => {
    const r = determineSupportedBackends(
      'windows',
      'x86_64',
      features({ cuda11: true, cuda12: true, vulkan: true })
    )
    expect(r).toEqual(['win-cpu-x64', 'win-cuda-12.4-x64', 'win-vulkan-x64'])
    const withCuda13 = determineSupportedBackends(
      'windows',
      'x86_64',
      features({ cuda12: true, cuda13: true })
    )
    expect(withCuda13).toContain('win-cuda-13-x64')
    expect(withCuda13.some((x) => x.includes('cuda-13.'))).toBe(false)
  })
  it('windows: ROCm as the version-less family id, never displacing Vulkan', () => {
    const r = determineSupportedBackends('windows', 'x86_64', features({ vulkan: true, rocm: true }))
    expect(r).toEqual(['win-cpu-x64', 'win-rocm-x64', 'win-vulkan-x64'])
  })
  it.each([
    [features(), ['linux-cpu-x64']],
    [features({ vulkan: true }), ['linux-cpu-x64', 'linux-vulkan-x64']],
    [features({ cuda11: true, cuda12: true, cuda13: true }), ['linux-cpu-x64']],
    [features({ cuda11: true, cuda12: true, vulkan: true }), ['linux-cpu-x64', 'linux-vulkan-x64']],
    [features({ vulkan: true, rocm: true }), ['linux-cpu-x64', 'linux-vulkan-x64']],
  ])('linux x86_64 with %o → %o', (f, expected) => {
    expect(determineSupportedBackends('linux', 'x86_64', f)).toEqual(expected)
  })
  it('arm and macOS placeholders, unsupported system throws', () => {
    expect(determineSupportedBackends('linux', 'aarch64', features())).toEqual(['linux-cpu-arm64'])
    expect(determineSupportedBackends('windows', 'arm64', features())).toEqual(['win-cpu-arm64'])
    expect(determineSupportedBackends('macos', 'arm64', features())).toEqual(['macos-arm64'])
    expect(determineSupportedBackends('macos', 'x86_64', features())).toEqual(['macos-x64'])
    expect(() => determineSupportedBackends('freebsd', 'x86_64', features())).toThrow(AtomicCoreError)
    expect(() => determineSupportedBackends('freebsd', 'x86_64', features())).toThrow(
      'Unsupported system type: freebsd-x86_64'
    )
  })
})

describe('listSupportedBackends (Rust test_list_supported_backends_sorting_and_dedup)', () => {
  it('merges remote and local, sorted by tag desc then backend asc', () => {
    const remote = [b('b7523', 'backend-a', 1), b('b7523', 'backend-b', 1)]
    const local = [b('b7523', 'backend-a', 0), b('b7524', 'backend-c', 2)]
    const r = listSupportedBackends(remote, local)
    expect(r.map((x) => `${x.version}/${x.backend}`)).toEqual([
      'b7524/backend-c',
      'b7523/backend-a',
      'b7523/backend-b',
    ])
  })
  it('lets a local entry replace the remote one only when its order is greater', () => {
    expect(listSupportedBackends([b('b1', 'x', 5)], [b('b1', 'x', 9)])).toEqual([b('b1', 'x', 9)])
    expect(listSupportedBackends([b('b1', 'x', 5)], [b('b1', 'x', 5)])).toEqual([b('b1', 'x', 5)])
    expect(listSupportedBackends([b('b1', 'x', 5)], [{ version: 'b1', backend: 'x' }])).toEqual([
      b('b1', 'x', 5),
    ])
  })
})

describe('filterBackendsBySupport (Windows family-aware filter from backend.ts)', () => {
  const merged = [
    b('b10809', 'win-cuda-13.4-x64'),
    b('b10809', 'win-rocm-10.0-x64'),
    b('b10809', 'win-cuda-12.4-x64'),
    b('b10809', 'win-vulkan-x64'),
    b('b9000', 'win-cuda-12-common_cpus-x64'),
    b('b10809', 'win-cpu-x64'),
    b('b10809', '\uFEFFwin-cpu-x64'),
  ]
  it('accepts concrete CUDA-13 / ROCm assets through their family ids and legacy ids through normalisation', () => {
    const r = filterBackendsBySupport(
      merged,
      ['win-cpu-x64', 'win-cuda-13-x64', 'win-rocm-x64', 'win-cuda-12.4-x64'],
      'windows'
    )
    expect(r.map((x) => x.backend)).toEqual([
      'win-cuda-13.4-x64',
      'win-rocm-10.0-x64',
      'win-cuda-12.4-x64',
      'win-cuda-12-common_cpus-x64',
      'win-cpu-x64',
    ])
  })
  // A BOM-carrying id is normalised raw (as in the app), so it never matches the supported set.
  it('drops everything the host cannot run and passes other OSes through', () => {
    expect(filterBackendsBySupport(merged, ['win-cpu-x64'], 'windows').map((x) => x.backend)).toEqual([
      'win-cpu-x64',
    ])
    expect(filterBackendsBySupport(merged, [], 'macos')).toEqual(merged)
  })
})

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
