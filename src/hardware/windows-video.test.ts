import { describe, expect, it } from 'vitest'
import { readHardwareFixture } from '../../test/helpers/hardware-fixtures.js'
import {
  WINDOWS_PROBE_SCRIPT,
  coreCount,
  osName,
  parsePnpDeviceId,
  parseWindowsProbe,
  windowsGpus,
  windowsProbeArgs,
} from './windows-video.js'

describe('WINDOWS_PROBE_SCRIPT / windowsProbeArgs', () => {
  it('is one line without double quotes, reading every source the probe needs', () => {
    expect(WINDOWS_PROBE_SCRIPT).not.toContain('\n')
    expect(WINDOWS_PROBE_SCRIPT).not.toContain('"')
    for (const needle of [
      "$ErrorActionPreference = 'SilentlyContinue'",
      'Win32_VideoController',
      '{4d36e968-e325-11ce-bfc1-08002be10318}',
      'MatchingDeviceId',
      "'HardwareInformation.qwMemorySize'",
      'VulkanDriverName',
      'Win32_Processor',
      'Win32_OperatingSystem',
      'vulkan-1.dll',
      'HKLM:\\SOFTWARE\\Khronos\\Vulkan\\Drivers',
      'IsProcessorFeaturePresent',
      '3,6,10,13,36,37,38,39,40,41',
      '[Environment]::OSVersion.Version.Build',
      'ConvertTo-Json -Depth 5 -Compress',
    ])
      expect(WINDOWS_PROBE_SCRIPT).toContain(needle)
    // Every list is wrapped so a one-element result stays a list on PowerShell 5.1.
    expect(WINDOWS_PROBE_SCRIPT).toMatch(/\$video = @\(/)
    expect(WINDOWS_PROBE_SCRIPT).toMatch(/\$classKeys = @\(/)
    expect(WINDOWS_PROBE_SCRIPT).toMatch(/\$cpu = @\(/)
    expect(WINDOWS_PROBE_SCRIPT).toMatch(/\$drivers = @\(/)
    expect(WINDOWS_PROBE_SCRIPT).toMatch(/try \{ Add-Type .* \} catch \{ \$pf = \$null \}/)
    expect(windowsProbeArgs()).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      WINDOWS_PROBE_SCRIPT,
    ])
  })
})

describe('parseWindowsProbe', () => {
  it('reads the hybrid RTX 4090 + UHD 770 document', () => {
    const probe = parseWindowsProbe(readHardwareFixture('windows-probe-hybrid-rtx4090-uhd770.json'))
    expect(probe.video).toHaveLength(4)
    expect(probe.video[0]).toEqual({
      Name: 'NVIDIA GeForce RTX 4090',
      AdapterRAM: 4_293_918_720,
      PNPDeviceID: 'PCI\\VEN_10DE&DEV_2684&SUBSYS_889D1043&REV_A1\\4&2283F625&0&0019',
      DriverVersion: '32.0.15.8142',
    })
    // `AdapterRAM: null` is dropped, not kept as null.
    expect(probe.video[2]).not.toHaveProperty('AdapterRAM')
    expect(probe.classKeys.map((k) => k.key)).toEqual(['0000', '0001', '0002'])
    expect(probe.classKeys[1]).toMatchObject({
      qwMemorySize: 25_769_803_776,
      VulkanDriverName: [expect.stringMatching(/nv-vk64\.json$/)],
    })
    expect(probe.classKeys[2]).not.toHaveProperty('qwMemorySize')
    expect(probe.cpu).toEqual([{ Name: '13th Gen Intel(R) Core(TM) i9-13900K', NumberOfCores: 24 }])
    expect(probe.os).toEqual({
      Caption: 'Microsoft Windows 11 Pro',
      Version: '10.0.26100',
      BuildNumber: '26100',
    })
    expect(probe.vulkan.dll).toBe(true)
    expect(probe.vulkan.drivers).toHaveLength(2)
    expect(probe.pf).toEqual({
      '3': true,
      '6': true,
      '10': true,
      '13': true,
      '36': true,
      '37': true,
      '38': true,
      '39': true,
      '40': true,
      '41': false,
    })
    expect(probe.build).toBe(26100)
  })

  it('strips the BOM and un-collapses the single-element objects PowerShell 5.1 emits', () => {
    const text = readHardwareFixture('windows-probe-rx7900xtx-ps51.json')
    expect(text.charCodeAt(0)).toBe(0xfeff)
    const probe = parseWindowsProbe(text)
    expect(probe.video).toHaveLength(1)
    expect(probe.classKeys).toHaveLength(1)
    expect(probe.classKeys[0]?.VulkanDriverName).toEqual([expect.stringMatching(/amd-vulkan64\.json$/)])
    expect(probe.cpu).toEqual([{ Name: 'AMD Ryzen 7 7800X3D 8-Core Processor', NumberOfCores: 8 }])
    expect(probe.vulkan.drivers).toHaveLength(1)
    expect(probe.build).toBe(19045)
  })

  it('reads a headless server: no class keys, no loader, no P/Invoke', () => {
    const probe = parseWindowsProbe(readHardwareFixture('windows-probe-no-gpu-server2022.json'))
    expect(probe.classKeys).toEqual([])
    expect(probe.vulkan).toEqual({ dll: false, drivers: [] })
    expect(probe.pf).toBeNull()
    expect(probe.build).toBe(20348)
  })

  it('falls back to the OS build number and tolerates missing sections', () => {
    const probe = parseWindowsProbe('{"os":{"BuildNumber":"22631"},"pf":{"39":"yes","40":true}}')
    expect(probe).toEqual({
      video: [],
      classKeys: [],
      cpu: [],
      os: { BuildNumber: '22631' },
      vulkan: { dll: false, drivers: [] },
      pf: { '39': false, '40': true },
      build: 22631,
    })
    expect(parseWindowsProbe('{}').build).toBe(0)
    expect(
      parseWindowsProbe('{"classKeys":[{"MatchingDeviceId":"x"}, 5], "video":[1], "cpu":["a"]}')
    ).toMatchObject({
      classKeys: [],
      video: [],
      cpu: [],
    })
  })

  it('throws for anything that is not the document', () => {
    expect(() => parseWindowsProbe('[]')).toThrow(/JSON object/)
    expect(() => parseWindowsProbe('not json')).toThrow()
  })
})

describe('parsePnpDeviceId', () => {
  it.each([
    [
      'PCI\\VEN_10DE&DEV_2684&SUBSYS_889D1043&REV_A1\\4&2283F625&0&0019',
      { vendorId: 0x10de, deviceId: 0x2684 },
    ],
    ['pci\\ven_1002&dev_744c', { vendorId: 0x1002, deviceId: 0x744c }],
    ['ROOT\\BASICDISPLAY\\0000', undefined],
    ['SWD\\REMOTEDISPLAYENUM\\RDPIDD', undefined],
    ['', undefined],
  ])('%s', (id, expected) => expect(parsePnpDeviceId(id)).toEqual(expected))
})

describe('windowsGpus', () => {
  it('keeps the PCI adapters with the class-key VRAM and their ICDs, and skips software adapters', () => {
    const probe = parseWindowsProbe(readHardwareFixture('windows-probe-hybrid-rtx4090-uhd770.json'))
    const result = windowsGpus(probe)
    expect(result.adapters).toEqual([
      {
        name: 'NVIDIA GeForce RTX 4090',
        vendorId: 0x10de,
        deviceId: 0x2684,
        pnpDeviceId: 'PCI\\VEN_10DE&DEV_2684&SUBSYS_889D1043&REV_A1\\4&2283F625&0&0019',
        driverVersion: '32.0.15.8142',
        vramTotalMiB: 24_576,
        vulkanDriver: true,
      },
      {
        name: 'Intel(R) UHD Graphics 770',
        vendorId: 0x8086,
        deviceId: 0x4680,
        pnpDeviceId: 'PCI\\VEN_8086&DEV_4680&SUBSYS_88941043&REV_0C\\3&11583659&0&10',
        driverVersion: '32.0.101.6083',
        vramTotalMiB: 128,
        vulkanDriver: true,
      },
    ])
    expect([...result.icdVendors].sort()).toEqual(['Intel', 'NVIDIA'])
    expect(result.warnings).toEqual([])
  })

  it('reads the AMD card through the collapsed document and its ICD from the class key alone', () => {
    const probe = parseWindowsProbe(readHardwareFixture('windows-probe-rx7900xtx-ps51.json'))
    probe.vulkan.drivers = []
    const result = windowsGpus(probe)
    expect(result.adapters).toEqual([
      expect.objectContaining({
        name: 'AMD Radeon RX 7900 XTX',
        vendorId: 0x1002,
        deviceId: 0x744c,
        vramTotalMiB: 24_560,
        vulkanDriver: true,
      }),
    ])
    expect([...result.icdVendors]).toEqual(['AMD'])
  })

  it('falls back to AdapterRAM with a warning when no class key carries the size', () => {
    const probe = parseWindowsProbe(readHardwareFixture('windows-probe-hybrid-rtx4090-uhd770.json'))
    probe.classKeys = probe.classKeys.map(({ qwMemorySize: _dropped, ...key }) => key)
    const result = windowsGpus(probe)
    expect(result.adapters[0]?.vramTotalMiB).toBe(4095)
    expect(result.adapters[1]?.vramTotalMiB).toBe(1024)
    expect(result.warnings).toEqual([
      'NVIDIA GeForce RTX 4090: VRAM read from Win32_VideoController.AdapterRAM, which caps at 4 GiB',
      'Intel(R) UHD Graphics 770: VRAM read from Win32_VideoController.AdapterRAM, which caps at 4 GiB',
    ])
  })

  it('answers no adapters for a headless server, and names a nameless adapter by its instance id', () => {
    expect(
      windowsGpus(parseWindowsProbe(readHardwareFixture('windows-probe-no-gpu-server2022.json')))
    ).toEqual({
      adapters: [],
      icdVendors: new Set(),
      warnings: [],
    })
    const nameless = windowsGpus(
      parseWindowsProbe('{"video":[{"PNPDeviceID":"PCI\\\\VEN_1002&DEV_164E&SUBSYS_1"}],"classKeys":[]}')
    )
    expect(nameless.adapters[0]).toEqual({
      name: 'GPU PCI\\VEN_1002&DEV_164E&SUBSYS_1',
      vendorId: 0x1002,
      deviceId: 0x164e,
      pnpDeviceId: 'PCI\\VEN_1002&DEV_164E&SUBSYS_1',
      driverVersion: '',
      vulkanDriver: false,
    })
  })
})

describe('coreCount / osName', () => {
  it('sums cores across sockets and reads the caption', () => {
    const server = parseWindowsProbe(readHardwareFixture('windows-probe-no-gpu-server2022.json'))
    expect(coreCount(server)).toBe(4)
    expect(osName(server)).toBe('Microsoft Windows Server 2022 Datacenter')
    const empty = parseWindowsProbe('{"cpu":[{"NumberOfCores":0}],"os":{"Caption":"  "}}')
    expect(coreCount(empty)).toBeUndefined()
    expect(osName(empty)).toBeUndefined()
    expect(osName(parseWindowsProbe('{}'))).toBeUndefined()
  })
})
