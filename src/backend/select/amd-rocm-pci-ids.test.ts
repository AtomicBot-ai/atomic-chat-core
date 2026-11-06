import { describe, expect, it } from 'vitest'
import { AMD_ROCM_WINDOWS_PCI_IDS, isRocmSupportedPciId } from './amd-rocm-pci-ids.js'

describe('AMD_ROCM_WINDOWS_PCI_IDS', () => {
  it('contains unique PCI IDs and valid gfx targets', () => {
    expect(new Set(AMD_ROCM_WINDOWS_PCI_IDS.map(([id]) => id)).size).toBe(AMD_ROCM_WINDOWS_PCI_IDS.length)
    expect(AMD_ROCM_WINDOWS_PCI_IDS.every(([id, gfx]) => Number.isInteger(id) && /^gfx\d+$/.test(gfx))).toBe(
      true
    )
  })
  it('maps Radeon 860M and 840M to the shipped gfx1152 target', () => {
    expect(AMD_ROCM_WINDOWS_PCI_IDS).toContainEqual([0x1114, 'gfx1152'])
    expect(isRocmSupportedPciId(0x1114)).toBe(true)
  })
  it.each([
    [0x731f, 'gfx1010'],
    [0x7360, 'gfx1011'],
    [0x7340, 'gfx1012'],
    [0x73bf, 'gfx1030'],
    [0x73df, 'gfx1031'],
    [0x73ff, 'gfx1032'],
    [0x163f, 'gfx1033'],
    [0x743f, 'gfx1034'],
    [0x1681, 'gfx1035'],
    [0x164e, 'gfx1036'],
    [0x744c, 'gfx1100'],
    [0x747e, 'gfx1101'],
    [0x7480, 'gfx1102'],
    [0x15bf, 'gfx1103'],
    [0x150e, 'gfx1150'],
    [0x1586, 'gfx1151'],
    [0x1114, 'gfx1152'],
    [0x1902, 'gfx1153'],
    [0x7590, 'gfx1200'],
    [0x7550, 'gfx1201'],
  ])('covers shipped Radeon target %s -> %s', (id, target) => {
    expect(AMD_ROCM_WINDOWS_PCI_IDS).toContainEqual([id, target])
    expect(isRocmSupportedPciId(id as number)).toBe(true)
  })
  it.each([0x7314, 0x73a4, 0x7446, 0xab30, 0x1478, 0x687f, 0x13e9, 0xffff])(
    'excludes non-GPU functions, unshipped and unknown silicon: %s',
    (id) => {
      expect(isRocmSupportedPciId(id)).toBe(false)
    }
  )
  it('includes the Navi 22 virtual-function PCI ID with its silicon suffix', () => {
    expect(AMD_ROCM_WINDOWS_PCI_IDS).toContainEqual([0x73ce, 'gfx1031'])
  })
  it('answers membership', () => {
    expect(isRocmSupportedPciId(0x744c)).toBe(true)
    expect(isRocmSupportedPciId(0x687f)).toBe(false)
    expect(isRocmSupportedPciId(0xffff)).toBe(false)
  })
})
