import { expect, it } from 'vitest'
import type { SystemInfo } from '../contracts/index.js'
import { strataHostFacts } from './strata.js'
const mac = (): SystemInfo => ({
  os_type: 'macos',
  os_name: 'macOS 26.6.2',
  total_memory: 32768,
  cpu: { name: 'Apple M4', arch: 'arm64', core_count: 10, extensions: [], extensions_known: true },
  gpus: [],
})
it('describes Apple unified memory once using the hardware service measurement', () => {
  expect(strataHostFacts(mac())).toMatchObject({
    osVersion: '26.6.2',
    ramBytes: 32768 * 2 ** 20,
    devices: [{ id: 'apple:0', architecture: 'apple-gpu', unified: true, memoryBytes: 32768 * 2 ** 20 }],
  })
  const intel = mac()
  intel.cpu.arch = 'x86_64'
  expect(strataHostFacts(intel).devices).toEqual([])
})
it('uses measured NVIDIA capability and driver rather than inferring them from the name', () => {
  const info = mac()
  info.os_type = 'windows'
  info.os_name = 'Windows 11'
  info.cpu.arch = 'x86_64'
  info.gpus = [
    {
      name: 'RTX',
      uuid: 'uuid',
      vendor: 'NVIDIA',
      total_memory: 24576,
      driver_version: '581.10',
      nvidia_info: { index: 0, compute_capability: '8.9' },
      vulkan_info: null,
    },
  ]
  expect(strataHostFacts(info, { osVersion: '10.0.26100' })).toMatchObject({
    arch: 'x64',
    devices: [{ id: 'uuid', architecture: 'sm_89', driverVersion: '581.10', unified: false }],
  })
  info.gpus[0]!.nvidia_info = null
  expect(strataHostFacts(info).devices[0]!.architecture).toBeUndefined()
})
it('distinguishes R9700 and Strix Halo from other AMD devices using reviewed PCI IDs', () => {
  const info = mac()
  info.os_type = 'linux'
  info.cpu.arch = 'x86_64'
  info.gpus = [0x7551, 0x1586, 0x7550].map((pci, i) => ({
    name: 'AMD',
    uuid: 'pci:' + i,
    vendor: 'AMD',
    total_memory: 16384,
    ...(pci === 0x1586 ? { shared_memory: 24576 } : {}),
    driver_version: '',
    nvidia_info: null,
    vulkan_info: { index: i, api_version: '', device_type: 'Unknown', device_id: pci },
  }))
  const devices = strataHostFacts(info).devices
  expect(devices.map((d) => d.family)).toEqual(['radeon-ai-pro-r9700', 'strix-halo', undefined])
  expect(devices[1]).toMatchObject({ unified: true, memoryBytes: 24576 * 2 ** 20 })
})

it('uses the same NVIDIA residency identity as managed runtimes and preserves the measured index', () => {
  const info = mac()
  info.gpus = [
    {
      name: 'RTX',
      uuid: '0b6f4f4e-6c1c-3a54-8f2d-1b0d2f4d6a11',
      vendor: 'NVIDIA',
      total_memory: 24576,
      driver_version: '581.10',
      nvidia_info: { index: 2, compute_capability: '8.9' },
      vulkan_info: null,
    },
  ]
  expect(strataHostFacts(info).devices).toContainEqual(
    expect.objectContaining({
      id: 'GPU-0b6f4f4e-6c1c-3a54-8f2d-1b0d2f4d6a11',
      ordinal: 2,
    })
  )
})
