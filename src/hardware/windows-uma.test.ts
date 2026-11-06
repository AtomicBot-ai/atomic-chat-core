import { expect, it } from 'vitest'
import { parseWindowsProbe, windowsGpus } from './windows-video.js'
import { mergeGpus } from './merge.js'

const mib = 2 ** 20
const apu = {
  VendorId: 0x1002,
  DeviceId: 0x1114,
  SubSysId: 0x513717aa,
  DedicatedVideoMemory: 512 * mib,
  SharedSystemMemory: 15945 * mib,
  uma: true,
}
const discrete = {
  VendorId: 0x1002,
  DeviceId: 0x744c,
  SubSysId: 0x12341002,
  DedicatedVideoMemory: 24 * 1024 * mib,
  SharedSystemMemory: 15945 * mib,
  uma: false,
}
function read(dxgi: unknown, devices = [apu, discrete]) {
  const probe = parseWindowsProbe(
    JSON.stringify({
      video: devices.map((d) => ({
        Name: `AMD ${d.DeviceId}`,
        AdapterRAM: 512 * mib,
        PNPDeviceID: `PCI\\VEN_1002&DEV_${d.DeviceId.toString(16)}&SUBSYS_${d.SubSysId.toString(16)}\\0`,
      })),
      dxgi,
      vulkan: { dll: true, drivers: ['amd-vulkan64.json'] },
    })
  )
  const { adapters, icdVendors } = windowsGpus(probe)
  return mergeGpus({ nvidia: [], pci: adapters, icdVendors, vulkan: [], loaderPresent: true }).gpus
}
it('keeps Ryzen UMA and discrete Radeon capacities separate, independent of enumeration order', () => {
  const [integrated, card] = read([discrete, apu])
  expect(integrated).toMatchObject({
    total_memory: 512,
    shared_memory: 15945,
    vulkan_info: { device_type: 'IntegratedGpu' },
  })
  expect(card).toMatchObject({ total_memory: 24576, vulkan_info: { device_type: 'DiscreteGpu' } })
  expect(card).not.toHaveProperty('shared_memory')
})
it.each([
  undefined,
  [],
  { ...apu, uma: null },
  { ...apu, uma: false },
  { ...apu, SharedSystemMemory: -1 },
  { ...apu, SharedSystemMemory: 'unknown' },
  { ...apu, SubSysId: 1 },
  [apu, apu],
])('does not invent shared capacity from absent, failed or ambiguous facts (%j)', (dxgi) => {
  expect(read(dxgi, [apu])[0]).not.toHaveProperty('shared_memory')
})
it('accepts the PowerShell single-adapter object', () => {
  expect(read(apu, [apu])[0]).toMatchObject({ shared_memory: 15945 })
})
