import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { BackendFeatures, BackendVersion, GpuProbeInfo } from '../types.js'
import { AMD_ROCM_WINDOWS_PCI_IDS } from './amd-rocm-pci-ids.js'
import {
  CUDA_DRIVER_FLOORS,
  determineSupportedBackends,
  filterBackendsBySupport,
  getSupportedFeatures,
  gpuMeetsCuda13ArchFloor,
  isAmdGpu,
  listSupportedBackends,
  MIN_CUDA13_COMPUTE_CAPABILITY,
  normalizeFeatures,
  parseComputeCapability,
  rocmSupportedWindows,
} from './features.js'

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
