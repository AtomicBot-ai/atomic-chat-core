import { describe, expect, it } from 'vitest'
import { readHardwareFixture } from '../../test/helpers/hardware-fixtures.js'
import {
  DISPLAY_CLASS_REG_KEY,
  isDisplayDriverKey,
  parseRegQuery,
  regExePath,
  regNumber,
  regQueryArgs,
  regStrings,
  registryDisplayKeys,
  registryGpus,
  vulkanDriverPaths,
} from './windows-registry.js'
import type { RegistryDisplayKey } from './windows-registry.js'

const CLASS =
  'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'
const amdBox = () => readHardwareFixture('windows-reg-display-class-rx7900xtx-uhd770.txt')

describe('regExePath / regQueryArgs', () => {
  it('runs System32 reg.exe on one key, never recursively', () => {
    expect(regExePath({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\reg.exe')
    expect(regExePath({ SYSTEMROOT: 'E:\\W' })).toBe('E:\\W\\System32\\reg.exe')
    expect(regExePath({})).toBe('C:\\Windows\\System32\\reg.exe')
    expect(regQueryArgs(DISPLAY_CLASS_REG_KEY)).toEqual([
      'query',
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}',
    ])
  })
})

describe('parseRegQuery', () => {
  it('reads every key of a recursive dump, its values and the bare subkey lines, skipping error lines', () => {
    const keys = parseRegQuery(amdBox())
    expect(keys.map((k) => k.path.slice(CLASS.length))).toEqual([
      '',
      '\\0000',
      '\\0000\\UMD',
      '\\0000\\Settings',
      '\\0001',
      '\\0001\\Settings',
      '\\0002',
      '\\Configuration',
      '\\Properties',
    ])
    expect(keys[0]?.values).toContainEqual({ name: '(Default)', type: 'REG_SZ', data: 'Display adapters' })
    expect(keys[1]?.values).toContainEqual({
      name: 'HardwareInformation.qwMemorySize',
      type: 'REG_QWORD',
      data: '0x5ff000000',
    })
    expect(keys.at(-1)?.values).toEqual([])
  })

  it('reads CRLF, a BOM, UTF-16 read as bytes, empty data and value names with spaces', () => {
    const text = `\uFEFF\r\n${CLASS}\\0000\r\n    Driver Desc    REG_SZ    A B\r\n    Empty    REG_SZ    \r\n    Bare    REG_SZ\r\n`
    const utf16AsBytes = `\uFFFD\uFFFD${[...`\r\n${CLASS}\\0001\r\n    X    REG_DWORD    0x1\r\n`].map((c) => `${c}\u0000`).join('')}`
    expect(parseRegQuery(text)).toEqual([
      {
        path: `${CLASS}\\0000`,
        values: [
          { name: 'Driver Desc', type: 'REG_SZ', data: 'A B' },
          { name: 'Empty', type: 'REG_SZ', data: '' },
          { name: 'Bare', type: 'REG_SZ', data: '' },
        ],
      },
    ])
    expect(parseRegQuery(utf16AsBytes)).toEqual([
      { path: `${CLASS}\\0001`, values: [{ name: 'X', type: 'REG_DWORD', data: '0x1' }] },
    ])
    expect(parseRegQuery('    Orphan    REG_SZ    x\nERROR: Access is denied.\n')).toEqual([])
  })
})

describe('isDisplayDriverKey', () => {
  it.each([
    [`${CLASS}\\0000`, true],
    [`${CLASS}\\0012`, true],
    [`${CLASS.toUpperCase()}\\0003`, true],
    [`${CLASS}\\0000\\UMD`, false],
    [`${CLASS}\\Properties`, false],
    [CLASS, false],
    [
      'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e972-e325-11ce-bfc1-08002be10318}\\0000',
      false,
    ],
  ])('%s → %s', (path, expected) => expect(isDisplayDriverKey(path)).toBe(expected))
})

describe('regNumber / regStrings', () => {
  it.each([
    [{ name: 'q', type: 'REG_QWORD', data: '0x600000000' }, 25_769_803_776],
    [{ name: 'd', type: 'REG_DWORD', data: '0x8000000' }, 134_217_728],
    [{ name: 'd', type: 'REG_DWORD', data: 'garbage' }, undefined],
    [{ name: 'b', type: 'REG_BINARY', data: '00000008' }, 134_217_728],
    [{ name: 'b', type: 'REG_BINARY', data: '0000F0FF' }, 4_293_918_720],
    [{ name: 'b', type: 'REG_BINARY', data: '' }, undefined],
    [{ name: 'b', type: 'REG_BINARY', data: '000' }, undefined],
    [{ name: 'b', type: 'REG_BINARY', data: 'zz00' }, undefined],
    [{ name: 'b', type: 'REG_BINARY', data: '00'.repeat(9) }, undefined],
    [{ name: 's', type: 'REG_SZ', data: '12' }, undefined],
    [undefined, undefined],
  ])('%o → %s', (value, expected) => expect(regNumber(value)).toBe(expected))

  it('splits a multi-string on the \\0 reg.exe prints and drops empty strings', () => {
    expect(regStrings({ name: 'm', type: 'REG_MULTI_SZ', data: 'C:\\a.json\\0C:\\b.json\\0' })).toEqual([
      'C:\\a.json',
      'C:\\b.json',
    ])
    expect(regStrings({ name: 's', type: 'REG_SZ', data: 'C:\\a.json' })).toEqual(['C:\\a.json'])
    expect(regStrings({ name: 'm', type: 'REG_MULTI_SZ', data: '' })).toEqual([])
    expect(regStrings({ name: 'd', type: 'REG_DWORD', data: '0x1' })).toEqual([])
    expect(regStrings(undefined)).toEqual([])
  })
})

describe('registryDisplayKeys', () => {
  it('reads the driver instances only, never a value of their private subkeys', () => {
    expect(registryDisplayKeys(parseRegQuery(amdBox()))).toEqual([
      {
        key: '0000',
        MatchingDeviceId: 'pci\\ven_1002&dev_744c&rev_c8',
        DriverDesc: 'AMD Radeon RX 7900 XTX',
        ProviderName: 'Advanced Micro Devices, Inc.',
        DriverVersion: '32.0.12033.1030',
        qwMemorySize: 25_753_026_560,
        memorySize: 4_293_918_720,
        VulkanDriverName: [
          'C:\\Windows\\System32\\DriverStore\\FileRepository\\u0405208.inf_amd64_3a1b2c3d4e5f6a7b\\B405148\\amd-vulkan64.json',
        ],
      },
      {
        key: '0001',
        MatchingDeviceId: 'pci\\ven_8086&dev_4680',
        DriverDesc: 'Intel(R) UHD Graphics 770',
        ProviderName: 'Intel Corporation',
        DriverVersion: '32.0.101.6083',
        memorySize: 134_217_728,
        VulkanDriverName: [
          'C:\\Windows\\System32\\DriverStore\\FileRepository\\iigd_dch.inf_amd64_5b8fe1d2f2b1a0c4\\igvk64.json',
        ],
      },
      {
        key: '0002',
        MatchingDeviceId: 'pci\\cc_0300',
        DriverDesc: 'Microsoft Basic Display Adapter',
        ProviderName: 'Microsoft',
        DriverVersion: '10.0.26100.1',
        VulkanDriverName: [],
      },
    ])
  })
})

describe('vulkanDriverPaths', () => {
  it('takes the manifest paths the Khronos key names its values by', () => {
    const text = `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Khronos\\Vulkan\\Drivers\r\n    C:\\Program Files\\Vendor X\\x-vk64.json    REG_DWORD    0x0\r\n    C:\\Windows\\System32\\igvk64.json    REG_DWORD    0x0\r\n    (Default)    REG_SZ    \r\n`
    expect(vulkanDriverPaths(parseRegQuery(text))).toEqual([
      'C:\\Program Files\\Vendor X\\x-vk64.json',
      'C:\\Windows\\System32\\igvk64.json',
    ])
  })
})

describe('registryGpus', () => {
  const key = (over: Partial<RegistryDisplayKey> & { key: string }): RegistryDisplayKey => ({
    VulkanDriverName: [],
    ...over,
  })

  it('lists the PCI GPUs of the AMD box with the registry VRAM figure, skipping the basic display adapter', () => {
    const { adapters, icdVendors, warnings } = registryGpus(
      registryDisplayKeys(parseRegQuery(amdBox())),
      [],
      []
    )
    expect(adapters).toEqual([
      {
        name: 'AMD Radeon RX 7900 XTX',
        vendorId: 0x1002,
        deviceId: 0x744c,
        pnpDeviceId: '{4d36e968-e325-11ce-bfc1-08002be10318}\\0000',
        driverVersion: '32.0.12033.1030',
        vramTotalMiB: 24_560,
        vulkanDriver: true,
      },
      {
        name: 'Intel(R) UHD Graphics 770',
        vendorId: 0x8086,
        deviceId: 0x4680,
        pnpDeviceId: '{4d36e968-e325-11ce-bfc1-08002be10318}\\0001',
        driverVersion: '32.0.101.6083',
        vramTotalMiB: 128,
        vulkanDriver: true,
      },
    ])
    expect([...icdVendors].sort()).toEqual(['AMD', 'Intel'])
    expect(warnings).toEqual([
      'Intel(R) UHD Graphics 770: VRAM read from HardwareInformation.MemorySize, which caps at 4 GiB',
    ])
  })

  it('keeps an NVIDIA key only as often as nvidia-smi reports a GPU of that name', () => {
    const keys = registryDisplayKeys(
      parseRegQuery(readHardwareFixture('windows-reg-display-class-rtx4090-uhd770-stale-gtx1080.txt'))
    )
    const withSmi = registryGpus(keys, ['C:\\x\\nv-vk64.json'], ['NVIDIA GeForce RTX 4090'])
    expect(withSmi.adapters.map((a) => [a.name, a.pnpDeviceId.slice(-4)])).toEqual([
      ['Intel(R) UHD Graphics 770', '0000'],
      ['NVIDIA GeForce RTX 4090', '0001'],
    ])
    expect([...withSmi.icdVendors].sort()).toEqual(['Intel', 'NVIDIA'])
    // Without nvidia-smi nothing tells the stale card from the present one: both device ids stay.
    const withoutSmi = registryGpus(keys, [], [])
    expect(withoutSmi.adapters.map((a) => a.name)).toEqual([
      'Intel(R) UHD Graphics 770',
      'NVIDIA GeForce RTX 4090',
      'NVIDIA GeForce GTX 1080',
    ])
  })

  it('lists a device id once, from the key with a VRAM figure, and names an unnamed adapter by its id', () => {
    const { adapters, warnings } = registryGpus(
      [
        key({ key: '0000', MatchingDeviceId: 'pci\\ven_1002&dev_744c' }),
        key({ key: '0001', MatchingDeviceId: 'pci\\ven_1002&dev_744c', qwMemorySize: 2 ** 34 }),
        key({ key: '0002', MatchingDeviceId: 'acpi\\ven_qcom&dev_0c36', memorySize: 0, qwMemorySize: 0 }),
        key({ key: '0003', MatchingDeviceId: 'root\\basicrender' }),
        key({ key: '0004' }),
      ],
      [],
      []
    )
    expect(adapters).toEqual([
      {
        name: 'GPU pci\\ven_1002&dev_744c',
        vendorId: 0x1002,
        deviceId: 0x744c,
        pnpDeviceId: '{4d36e968-e325-11ce-bfc1-08002be10318}\\0001',
        driverVersion: '',
        vramTotalMiB: 16_384,
        vulkanDriver: false,
      },
      {
        name: 'GPU acpi\\ven_qcom&dev_0c36',
        vendorId: 0x5143,
        deviceId: 0x0c36,
        pnpDeviceId: '{4d36e968-e325-11ce-bfc1-08002be10318}\\0002',
        driverVersion: '',
        vulkanDriver: false,
      },
    ])
    expect(warnings).toEqual([])
  })
})
