import { describe, expect, it } from 'vitest'
import { AMD_ROCM_WINDOWS_PCI_IDS, isRocmSupportedPciId } from './amd-rocm-pci-ids.js'

describe('AMD_ROCM_WINDOWS_PCI_IDS', () => {
  it('mirrors the generated Rust table', () => {
    expect(AMD_ROCM_WINDOWS_PCI_IDS).toHaveLength(22)
    expect(AMD_ROCM_WINDOWS_PCI_IDS[0]).toEqual([0x73f0, 'gfx1102'])
    expect(AMD_ROCM_WINDOWS_PCI_IDS.every(([id, gfx]) => Number.isInteger(id) && /^gfx\d+$/.test(gfx))).toBe(
      true
    )
  })
  it('answers membership', () => {
    expect(isRocmSupportedPciId(0x744c)).toBe(true)
    expect(isRocmSupportedPciId(0x687f)).toBe(false)
  })
})
