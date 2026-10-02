import { describe, expect, it } from 'vitest'
import { readHardwareFixture } from '../../test/helpers/hardware-fixtures.js'
import {
  guessDeviceType,
  icdVendorOf,
  linuxIcdDirs,
  mapVulkanDeviceType,
  parseVulkaninfoSummary,
} from './vulkan.js'

describe('linuxIcdDirs', () => {
  it('lists the system directories, then the user ones, then XDG_DATA_DIRS, each once', () => {
    expect(
      linuxIcdDirs({
        HOME: '/home/u',
        XDG_DATA_DIRS: '/usr/local/share:/usr/share::/var/lib/flatpak/exports/share',
      })
    ).toEqual([
      '/usr/share/vulkan/icd.d',
      '/etc/vulkan/icd.d',
      '/usr/local/share/vulkan/icd.d',
      '/usr/local/etc/vulkan/icd.d',
      '/home/u/.local/share/vulkan/icd.d',
      '/home/u/.config/vulkan/icd.d',
      '/var/lib/flatpak/exports/share/vulkan/icd.d',
    ])
  })

  it('honours XDG_DATA_HOME / XDG_CONFIG_HOME and skips the user dirs without a home', () => {
    expect(linuxIcdDirs({ XDG_DATA_HOME: '/d', XDG_CONFIG_HOME: '/c' })).toEqual([
      '/usr/share/vulkan/icd.d',
      '/etc/vulkan/icd.d',
      '/usr/local/share/vulkan/icd.d',
      '/usr/local/etc/vulkan/icd.d',
      '/d/vulkan/icd.d',
      '/c/vulkan/icd.d',
    ])
    expect(linuxIcdDirs({})).toHaveLength(4)
  })
})

describe('icdVendorOf', () => {
  it.each([
    ['nvidia_icd.json', 'NVIDIA'],
    ['/usr/share/vulkan/icd.d/nvidia_icd.json', 'NVIDIA'],
    ['C:\\Windows\\System32\\DriverStore\\FileRepository\\nv_dispi.inf_amd64_1\\nv-vk64.json', 'NVIDIA'],
    ['radeon_icd.x86_64.json', 'AMD'],
    ['amd_icd64.json', 'AMD'],
    ['amd-vulkan64.json', 'AMD'],
    ['amd_pro_icd64.json', 'AMD'],
    ['intel_icd.x86_64.json', 'Intel'],
    ['intel_hasvk_icd.x86_64.json', 'Intel'],
    ['igvk64.json', 'Intel'],
    ['qcvk_icd_arm64x.json', 'Qualcomm'],
    ['freedreno_icd.aarch64.json', 'Qualcomm'],
    ['lvp_icd.x86_64.json', undefined],
    ['virtio_icd.x86_64.json', undefined],
    ['dzn_icd.x86_64.json', undefined],
    ['', undefined],
  ])('%s → %s', (name, expected) => expect(icdVendorOf(name)).toBe(expected))
})

describe('mapVulkanDeviceType', () => {
  it.each([
    ['PHYSICAL_DEVICE_TYPE_DISCRETE_GPU', 'DiscreteGpu'],
    ['PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU', 'IntegratedGpu'],
    ['PHYSICAL_DEVICE_TYPE_VIRTUAL_GPU', 'VirtualGpu'],
    ['PHYSICAL_DEVICE_TYPE_CPU', 'Cpu'],
    ['PHYSICAL_DEVICE_TYPE_OTHER', 'Other'],
    ['something new', 'Unknown'],
  ])('%s → %s', (raw, expected) => expect(mapVulkanDeviceType(raw)).toBe(expected))
})

describe('parseVulkaninfoSummary', () => {
  it('reads the GPU blocks and drops the llvmpipe CPU device', () => {
    const devices = parseVulkaninfoSummary(
      readHardwareFixture('vulkaninfo-summary-linux-rtx4090-intel-llvmpipe.txt')
    )
    expect(devices).toEqual([
      {
        index: 0,
        apiVersion: '1.3.277',
        driverVersion: '550.120.0.0',
        vendorId: 0x10de,
        deviceId: 0x2684,
        deviceType: 'DiscreteGpu',
        deviceName: 'NVIDIA GeForce RTX 4090',
      },
      {
        index: 1,
        apiVersion: '1.3.278',
        driverVersion: '24.0.9',
        vendorId: 0x8086,
        deviceId: 0xa780,
        deviceType: 'IntegratedGpu',
        deviceName: 'Intel(R) Graphics (RPL-S)',
      },
    ])
  })

  it('reads a single RADV device', () => {
    expect(parseVulkaninfoSummary(readHardwareFixture('vulkaninfo-summary-linux-rx7900xtx.txt'))).toEqual([
      {
        index: 0,
        apiVersion: '1.3.289',
        driverVersion: '24.2.8',
        vendorId: 0x1002,
        deviceId: 0x744c,
        deviceType: 'DiscreteGpu',
        deviceName: 'AMD Radeon RX 7900 XTX (RADV NAVI31)',
      },
    ])
  })

  it('answers nothing for output without devices and skips blocks without ids', () => {
    expect(parseVulkaninfoSummary('')).toEqual([])
    expect(
      parseVulkaninfoSummary('ERROR: [Loader Message] Code 0 : vkCreateInstance: Found no drivers!')
    ).toEqual([])
    expect(
      parseVulkaninfoSummary('GPU0:\n\tdeviceName = x\nGPU1:\n\tvendorID = 0x1002\n\tdeviceID = zz\n')
    ).toEqual([])
    expect(
      parseVulkaninfoSummary(
        'GPU0:\n\tvendorID = 0x1002\n\tdeviceID = 0x1\nTrailing:\n\tapiVersion = 9.9.9\n'
      )
    ).toEqual([
      {
        index: 0,
        apiVersion: '',
        driverVersion: '',
        vendorId: 0x1002,
        deviceId: 1,
        deviceType: 'Unknown',
        deviceName: '',
      },
    ])
  })

  it('keeps the numeric part of an apiVersion that carries a variant suffix', () => {
    expect(
      parseVulkaninfoSummary(
        'GPU0:\n\tapiVersion = 1.3.277 (4206869)\n\tvendorID = 0x10de\n\tdeviceID = 0x2684\n'
      )[0]?.apiVersion
    ).toBe('1.3.277')
  })
})

describe('guessDeviceType', () => {
  it.each<[string, { vendor: string; deviceId: number; vramTotalMiB?: number }, string]>([
    ['NVIDIA is discrete', { vendor: 'NVIDIA', deviceId: 0x2684 }, 'DiscreteGpu'],
    ['Intel Arc A770 (Alchemist)', { vendor: 'Intel', deviceId: 0x56a0 }, 'DiscreteGpu'],
    ['Intel Arc B580 (Battlemage)', { vendor: 'Intel', deviceId: 0xe20b }, 'DiscreteGpu'],
    ['Intel UHD 770', { vendor: 'Intel', deviceId: 0x4680 }, 'IntegratedGpu'],
    [
      'AMD APU with 512 MiB carve-out',
      { vendor: 'AMD', deviceId: 0x164e, vramTotalMiB: 512 },
      'IntegratedGpu',
    ],
    [
      'AMD with real VRAM stays unproven',
      { vendor: 'AMD', deviceId: 0x744c, vramTotalMiB: 24_560 },
      'Unknown',
    ],
    ['AMD without a VRAM reading stays unproven', { vendor: 'AMD', deviceId: 0x744c }, 'Unknown'],
    ['Qualcomm Adreno is part of the SoC', { vendor: 'Qualcomm', deviceId: 0x0c36 }, 'IntegratedGpu'],
    ['anyone else', { vendor: 'Unknown (vendor_id: 6900)', deviceId: 1 }, 'Unknown'],
  ])('%s', (_name, gpu, expected) => expect(guessDeviceType(gpu)).toBe(expected))
})
