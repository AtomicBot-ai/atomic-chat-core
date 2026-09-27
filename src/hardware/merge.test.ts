import { describe, expect, it } from 'vitest'
import { readHardwareFixture } from '../../test/helpers/hardware-fixtures.js'
// The selectors are the consumers of what merge produces; asserted here so a change in either side
// shows up. Source in `hardware/` never imports `backend/` — only this test does.
import { getSupportedFeatures, getTurboquantSupportedFeatures, integratedGpuOnly } from '../backend/index.js'
import { isUnsupportedNoAvxCpu } from '../runtime/llamacpp/index.js'
import { assembleSystemInfo, mergeGpus } from './merge.js'
import type { MergeInput, NvidiaSmiGpu } from './merge.js'
import {
  NVIDIA_SMI_FIELDS,
  NVIDIA_SMI_FIELDS_LEGACY,
  nvidiaBusIdOf,
  nvidiaGpuFromRow,
  parseNvidiaSmiCsv,
} from './nvidia-smi.js'
import type { SysfsGpu } from './drm-sysfs.js'
import { parseVulkaninfoSummary } from './vulkan.js'
import { parseWindowsProbe, windowsGpus } from './windows-video.js'

const nvidiaRows = (fixture: string, fields = NVIDIA_SMI_FIELDS): NvidiaSmiGpu[] =>
  parseNvidiaSmiCsv(readHardwareFixture(fixture), fields).map((row) => {
    const busId = nvidiaBusIdOf(row)
    return busId ? { gpu: nvidiaGpuFromRow(row), busId } : { gpu: nvidiaGpuFromRow(row) }
  })

const linuxInput = (over: Partial<MergeInput> = {}): MergeInput => ({
  nvidia: [],
  pci: [],
  vulkan: [],
  icdVendors: new Set(),
  loaderPresent: true,
  ...over,
})

const sysfs = {
  rtx4090: {
    card: 'card0',
    busId: '0000:01:00.0',
    vendorId: 0x10de,
    deviceId: 0x2684,
    driver: 'nvidia',
    bootVga: true,
  },
  rtx3060: { card: 'card2', busId: '0000:05:00.0', vendorId: 0x10de, deviceId: 0x2503, driver: 'nvidia' },
  uhd770: { card: 'card1', busId: '0000:00:02.0', vendorId: 0x8086, deviceId: 0xa780, driver: 'i915' },
  rx7900xtx: {
    card: 'card1',
    busId: '0000:03:00.0',
    vendorId: 0x1002,
    deviceId: 0x744c,
    driver: 'amdgpu',
    vramTotalMiB: 24_560,
    bootVga: true,
  },
  vegaApu: {
    card: 'card0',
    busId: '0000:04:00.0',
    vendorId: 0x1002,
    deviceId: 0x164e,
    driver: 'amdgpu',
    vramTotalMiB: 512,
  },
} satisfies Record<string, SysfsGpu>

describe('mergeGpus on Linux', () => {
  it('lets nvidia-smi own the NVIDIA rows, picks the device id from sysfs and the type from vulkaninfo', () => {
    const { gpus, warnings } = mergeGpus(
      linuxInput({
        nvidia: nvidiaRows('nvidia-smi-rtx4090-rtx3060-modern.csv'),
        pci: [sysfs.rtx4090, sysfs.uhd770, sysfs.rtx3060],
        vulkan: parseVulkaninfoSummary(
          readHardwareFixture('vulkaninfo-summary-linux-rtx4090-intel-llvmpipe.txt')
        ),
        icdVendors: new Set(['NVIDIA', 'Intel']),
      })
    )
    expect(gpus.map((g) => g.name)).toEqual([
      'NVIDIA GeForce RTX 4090',
      'NVIDIA GeForce RTX 3060',
      'Intel(R) Graphics (RPL-S)',
    ])
    expect(gpus[0]).toEqual({
      name: 'NVIDIA GeForce RTX 4090',
      total_memory: 24_564,
      vendor: 'NVIDIA',
      uuid: '0b6f4f4e-6c1c-3a54-8f2d-1b0d2f4d6a11',
      driver_version: '581.42',
      nvidia_info: { index: 0, compute_capability: '8.9' },
      vulkan_info: { index: 0, device_type: 'DiscreteGpu', api_version: '1.3.277', device_id: 0x2684 },
    })
    // The 3060 is not in vulkaninfo's list: the ICD says NVIDIA has a driver, the vendor says discrete.
    expect(gpus[1]?.vulkan_info).toEqual({
      index: 1,
      device_type: 'DiscreteGpu',
      api_version: '',
      device_id: 0x2503,
    })
    expect(gpus[2]).toEqual({
      name: 'Intel(R) Graphics (RPL-S)',
      total_memory: 0,
      vendor: 'Intel',
      uuid: '0000:00:02.0',
      driver_version: '24.0.9',
      nvidia_info: null,
      vulkan_info: { index: 1, device_type: 'IntegratedGpu', api_version: '1.3.278', device_id: 0xa780 },
    })
    expect(warnings).toEqual([])
  })

  it('lists an AMD card from sysfs alone with a guessed type, and exact when vulkaninfo answers', () => {
    const guessed = mergeGpus(linuxInput({ pci: [sysfs.rx7900xtx], icdVendors: new Set(['AMD']) }))
    expect(guessed.gpus).toEqual([
      {
        name: 'AMD GPU 0x744c',
        total_memory: 24_560,
        vendor: 'AMD',
        uuid: '0000:03:00.0',
        driver_version: '',
        nvidia_info: null,
        vulkan_info: { index: 0, device_type: 'Unknown', api_version: '', device_id: 0x744c },
      },
    ])
    const exact = mergeGpus(
      linuxInput({
        pci: [sysfs.rx7900xtx],
        vulkan: parseVulkaninfoSummary(readHardwareFixture('vulkaninfo-summary-linux-rx7900xtx.txt')),
        icdVendors: new Set(['AMD']),
      })
    )
    expect(exact.gpus[0]).toMatchObject({
      name: 'AMD Radeon RX 7900 XTX (RADV NAVI31)',
      driver_version: '24.2.8',
      vulkan_info: { device_type: 'DiscreteGpu', api_version: '1.3.289', device_id: 0x744c },
    })
    expect(exact.gpus).toHaveLength(1)
  })

  it('gives no vulkan_info without an ICD for the vendor, and null nvidia_info for an NVIDIA card nvidia-smi missed', () => {
    const { gpus, warnings } = mergeGpus(
      linuxInput({ pci: [sysfs.rtx4090, sysfs.vegaApu], icdVendors: new Set(['AMD']) })
    )
    expect(gpus[0]).toMatchObject({
      vendor: 'NVIDIA',
      nvidia_info: null,
      vulkan_info: null,
      uuid: '0000:01:00.0',
      name: 'NVIDIA GPU 0x2684',
    })
    expect(gpus[1]?.vulkan_info).toEqual({
      index: 1,
      device_type: 'IntegratedGpu',
      api_version: '',
      device_id: 0x164e,
    })
    expect(warnings).toEqual([
      'NVIDIA GPU 0x2684: NVIDIA GPU without an nvidia-smi answer; driver version and compute capability unknown',
    ])
  })

  it('keeps an nvidia-smi GPU that sysfs does not list (WSL) and matches vulkaninfo by name', () => {
    const vulkan = parseVulkaninfoSummary(
      readHardwareFixture('vulkaninfo-summary-linux-rtx4090-intel-llvmpipe.txt')
    )
    const { gpus } = mergeGpus(
      linuxInput({ nvidia: nvidiaRows('nvidia-smi-gtx1080-legacy.csv', NVIDIA_SMI_FIELDS_LEGACY), vulkan })
    )
    expect(gpus).toHaveLength(3)
    expect(gpus[0]).toMatchObject({
      name: 'GeForce GTX 1080',
      nvidia_info: { compute_capability: '' },
      vulkan_info: null,
    })
    // The two vulkaninfo devices nobody claimed are still listed, once each.
    expect(gpus.slice(1).map((g) => [g.name, g.uuid])).toEqual([
      ['NVIDIA GeForce RTX 4090', 'vulkan-0'],
      ['Intel(R) Graphics (RPL-S)', 'vulkan-1'],
    ])
    const byName = mergeGpus(
      linuxInput({ nvidia: nvidiaRows('nvidia-smi-rtx4090-na.csv'), vulkan, icdVendors: new Set(['NVIDIA']) })
    )
    expect(byName.gpus[0]?.vulkan_info).toMatchObject({ device_type: 'DiscreteGpu', device_id: 0x2684 })
    expect(byName.gpus).toHaveLength(2)
  })

  it('fills an empty uuid from the PCI record and VRAM from sysfs when nvidia-smi had none', () => {
    const row = {
      gpu: nvidiaGpuFromRow({ name: 'NVIDIA GeForce RTX 4090', driver_version: '550.1' }),
      busId: '0000:01:00.0',
    }
    const { gpus } = mergeGpus(
      linuxInput({ nvidia: [row], pci: [{ ...sysfs.rtx4090, vramTotalMiB: 24_000 }] })
    )
    expect(gpus[0]).toMatchObject({ uuid: '0000:01:00.0', total_memory: 24_000, vulkan_info: null })
    const bare = mergeGpus(linuxInput({ nvidia: [{ gpu: nvidiaGpuFromRow({}) }] }))
    expect(bare.gpus[0]?.uuid).toBe('nvidia-0')
  })
})

describe('mergeGpus on Windows', () => {
  const hybrid = windowsGpus(
    parseWindowsProbe(readHardwareFixture('windows-probe-hybrid-rtx4090-uhd770.json'))
  )

  it('matches the nvidia-smi row to the adapter by name and reads the Intel iGPU from the class key', () => {
    const { gpus, warnings } = mergeGpus({
      nvidia: nvidiaRows('nvidia-smi-rtx4090-na.csv'),
      pci: hybrid.adapters,
      vulkan: [],
      icdVendors: hybrid.icdVendors,
      loaderPresent: true,
    })
    expect(gpus).toEqual([
      {
        name: 'NVIDIA GeForce RTX 4090',
        total_memory: 24_564,
        vendor: 'NVIDIA',
        uuid: '0b6f4f4e-6c1c-3a54-8f2d-1b0d2f4d6a11',
        driver_version: '581.42',
        nvidia_info: { index: 0, compute_capability: '' },
        vulkan_info: { index: 0, device_type: 'DiscreteGpu', api_version: '', device_id: 0x2684 },
      },
      {
        name: 'Intel(R) UHD Graphics 770',
        total_memory: 128,
        vendor: 'Intel',
        uuid: 'PCI\\VEN_8086&DEV_4680&SUBSYS_88941043&REV_0C\\3&11583659&0&10',
        driver_version: '32.0.101.6083',
        nvidia_info: null,
        vulkan_info: { index: 1, device_type: 'IntegratedGpu', api_version: '', device_id: 0x4680 },
      },
    ])
    expect(warnings).toEqual([])
  })

  it('answers no vulkan_info when the loader dll is missing, whatever the ICDs say', () => {
    const { gpus } = mergeGpus({
      nvidia: [],
      pci: hybrid.adapters,
      vulkan: [],
      icdVendors: hybrid.icdVendors,
      loaderPresent: false,
    })
    expect(gpus.map((g) => g.vulkan_info)).toEqual([null, null])
    expect(gpus[0]).toMatchObject({
      vendor: 'NVIDIA',
      nvidia_info: null,
      uuid: hybrid.adapters[0]?.pnpDeviceId,
    })
  })

  it('uses the adapter’s own ICD registration when the Khronos list is empty', () => {
    const amd = windowsGpus(parseWindowsProbe(readHardwareFixture('windows-probe-rx7900xtx-ps51.json')))
    const { gpus } = mergeGpus({
      nvidia: [],
      pci: amd.adapters,
      vulkan: [],
      icdVendors: new Set(),
      loaderPresent: true,
    })
    expect(gpus[0]).toMatchObject({
      vendor: 'AMD',
      total_memory: 24_560,
      driver_version: '32.0.12033.1030',
      vulkan_info: { device_type: 'Unknown', device_id: 0x744c },
    })
  })
})

describe('what the selectors make of merged GPUs', () => {
  it('hybrid NVIDIA + Intel on Windows: CUDA 12 and 13 and Vulkan, no ROCm', () => {
    const hybrid = windowsGpus(
      parseWindowsProbe(readHardwareFixture('windows-probe-hybrid-rtx4090-uhd770.json'))
    )
    const { gpus } = mergeGpus({
      nvidia: nvidiaRows('nvidia-smi-rtx4090-rtx3060-modern.csv').slice(0, 1),
      pci: hybrid.adapters,
      vulkan: [],
      icdVendors: hybrid.icdVendors,
      loaderPresent: true,
    })
    expect(getSupportedFeatures('windows', ['avx', 'avx2'], gpus)).toMatchObject({
      cuda12: true,
      cuda13: true,
      vulkan: true,
      rocm: false,
      avx2: true,
    })
    expect(getTurboquantSupportedFeatures('windows', ['avx2'], gpus)).toMatchObject({
      cuda12: true,
      cuda13: true,
      vulkan: true,
    })
    expect(integratedGpuOnly(gpus)).toBe(false)
  })

  it('AMD 7900 XTX on Windows: ROCm from the PCI device id, even with only a guessed device type', () => {
    const amd = windowsGpus(parseWindowsProbe(readHardwareFixture('windows-probe-rx7900xtx-ps51.json')))
    const { gpus } = mergeGpus({
      nvidia: [],
      pci: amd.adapters,
      vulkan: [],
      icdVendors: amd.icdVendors,
      loaderPresent: true,
    })
    expect(getSupportedFeatures('windows', [], gpus)).toMatchObject({
      rocm: true,
      vulkan: true,
      cuda12: false,
    })
    // `Unknown` is not proven integrated, so the Vulkan build stays a candidate for the optimal pick.
    expect(integratedGpuOnly(gpus)).toBe(false)
  })

  it('a Linux Intel iGPU alone, exact from vulkaninfo, is integrated-only', () => {
    const vulkan = parseVulkaninfoSummary(
      readHardwareFixture('vulkaninfo-summary-linux-rtx4090-intel-llvmpipe.txt')
    ).filter((d) => d.vendorId === 0x8086)
    const { gpus } = mergeGpus(linuxInput({ pci: [sysfs.uhd770], vulkan, icdVendors: new Set(['Intel']) }))
    expect(integratedGpuOnly(gpus)).toBe(true)
    expect(getSupportedFeatures('linux', [], gpus)).toMatchObject({ vulkan: true, cuda12: false })
  })

  it('a legacy driver without compute_cap still passes the CUDA-13 architecture check (unknown is not sub-7.5)', () => {
    const { gpus } = mergeGpus(
      linuxInput({
        nvidia: [{ gpu: nvidiaGpuFromRow({ name: 'x', driver_version: '581.42' }), busId: '0000:01:00.0' }],
        pci: [sysfs.rtx4090],
      })
    )
    expect(getSupportedFeatures('linux', [], gpus)).toMatchObject({
      cuda12: true,
      cuda13: true,
      vulkan: false,
    })
  })

  it('the no-AVX preflight stays silent when the flags are unknown', () => {
    const info = assembleSystemInfo({
      cpu: { name: 'x', coreCount: 4, arch: 'x86_64', extensions: undefined },
      osType: 'windows',
      osName: 'Windows',
      totalMemoryMiB: 1,
      gpus: [],
    })
    expect(info.cpu).toEqual({
      name: 'x',
      core_count: 4,
      arch: 'x86_64',
      extensions: [],
      extensions_known: false,
    })
    const extensions = info.cpu.extensions_known ? info.cpu.extensions : undefined
    expect(isUnsupportedNoAvxCpu(info.cpu.arch, 'win-cpu-x64', extensions)).toBe(false)
    expect(isUnsupportedNoAvxCpu('x86_64', 'win-cpu-x64', ['fpu', 'sse2'])).toBe(true)
  })
})

describe('assembleSystemInfo', () => {
  it('copies the flags and marks them known', () => {
    const gpus = mergeGpus(linuxInput({ pci: [sysfs.rx7900xtx] })).gpus
    const info = assembleSystemInfo({
      cpu: {
        name: 'AMD Ryzen 9 7950X 16-Core Processor',
        coreCount: 16,
        arch: 'x86_64',
        extensions: ['fpu', 'avx', 'avx2'],
      },
      osType: 'linux',
      osName: 'Ubuntu 24.04.1 LTS',
      totalMemoryMiB: 64_000,
      gpus,
    })
    expect(info).toEqual({
      cpu: {
        name: 'AMD Ryzen 9 7950X 16-Core Processor',
        core_count: 16,
        arch: 'x86_64',
        extensions: ['fpu', 'avx', 'avx2'],
        extensions_known: true,
      },
      os_type: 'linux',
      os_name: 'Ubuntu 24.04.1 LTS',
      total_memory: 64_000,
      gpus,
    })
  })
})
