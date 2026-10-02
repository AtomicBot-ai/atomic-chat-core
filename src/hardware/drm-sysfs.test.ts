import { describe, expect, it } from 'vitest'
import { PCI_VENDOR, isCardNode, parseHexId, sysfsGpuFromFiles, vendorName } from './drm-sysfs.js'

describe('vendorName', () => {
  it.each([
    [PCI_VENDOR.NVIDIA, 'NVIDIA'],
    [PCI_VENDOR.AMD, 'AMD'],
    [PCI_VENDOR.INTEL, 'Intel'],
    [PCI_VENDOR.QUALCOMM, 'Qualcomm'],
    [0x1af4, 'Unknown (vendor_id: 6900)'],
  ])('%s → %s', (id, expected) => expect(vendorName(id)).toBe(expected))
})

describe('parseHexId', () => {
  it.each([
    ['0x10de\n', 0x10de],
    ['0X744C', 0x744c],
    ['1002', 0x1002],
    ['', undefined],
    ['0x', undefined],
    ['nope', undefined],
    ['0x1234567890', undefined],
  ])('%j → %s', (text, expected) => expect(parseHexId(text)).toBe(expected))
})

describe('isCardNode', () => {
  it.each([
    ['card0', true],
    ['card12', true],
    ['card0-DP-1', false],
    ['renderD128', false],
    ['version', false],
  ])('%s → %s', (name, expected) => expect(isCardNode(name)).toBe(expected))
})

describe('sysfsGpuFromFiles', () => {
  it('reads an amdgpu card with VRAM, bus id and driver', () => {
    expect(
      sysfsGpuFromFiles({
        card: 'card1',
        vendor: '0x1002\n',
        device: '0x744c\n',
        vramTotal: '25753026560\n',
        bootVga: '1\n',
        deviceLink: '../../../0000:03:00.0',
        driverLink: '../../../../bus/pci/drivers/amdgpu',
      })
    ).toEqual({
      card: 'card1',
      busId: '0000:03:00.0',
      vendorId: 0x1002,
      deviceId: 0x744c,
      driver: 'amdgpu',
      vramTotalMiB: 24_560,
      bootVga: true,
    })
  })

  it('leaves out what the kernel does not expose (an NVIDIA card has no mem_info_vram_total)', () => {
    expect(
      sysfsGpuFromFiles({
        card: 'card0',
        vendor: '0x10de',
        device: '0x2684',
        bootVga: '0',
        deviceLink: '../../../0000:01:00.0',
        driverLink: '../../../../bus/pci/drivers/nvidia',
      })
    ).toEqual({
      card: 'card0',
      busId: '0000:01:00.0',
      vendorId: 0x10de,
      deviceId: 0x2684,
      driver: 'nvidia',
      bootVga: false,
    })
  })

  it('tolerates a non-PCI device link, an unbound driver and unreadable numbers', () => {
    expect(
      sysfsGpuFromFiles({
        card: 'card2',
        vendor: '0x1af4',
        device: '0x1050',
        vramTotal: 'n/a',
        bootVga: 'maybe',
        deviceLink: '../../../virtio0',
        driverLink: '',
      })
    ).toEqual({ card: 'card2', vendorId: 0x1af4, deviceId: 0x1050 })
    expect(sysfsGpuFromFiles({ card: 'card0', vendor: 'garbage', device: '0x1' })).toBeUndefined()
    expect(sysfsGpuFromFiles({ card: 'card0', vendor: '0x1002', device: '' })).toBeUndefined()
    expect(sysfsGpuFromFiles({ card: 'card0', vendor: '0x1002', device: '0x1', vramTotal: '0' })).toEqual({
      card: 'card0',
      vendorId: 0x1002,
      deviceId: 1,
    })
  })
})
