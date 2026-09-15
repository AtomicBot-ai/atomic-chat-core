import { describe, expect, it } from 'vitest'
import {
  isIntegratedGpu,
  isModelSupported,
  memoryBudget,
  modelSupportStatus,
  RESERVE_BYTES,
} from './support.js'

const GB = 1024 ** 3
const discrete = (bytes: number) => ({ total_bytes: bytes, integrated: false })
const integrated = (bytes: number) => ({ total_bytes: bytes, integrated: true })

describe('memoryBudget', () => {
  it('does not count integrated VRAM on top of system RAM', () => {
    const b = memoryBudget(16 * GB, [integrated(8 * GB)])
    expect(b.usable_total).toBeLessThan(16 * GB)
  })
  it('adds discrete VRAM to system RAM', () => {
    const b = memoryBudget(16 * GB, [discrete(11 * GB)])
    expect(b.usable_total).toBe(16 * GB - RESERVE_BYTES + (11 * GB - RESERVE_BYTES))
    expect(b.usable_vram).toBe(11 * GB - RESERVE_BYTES)
  })
  it('reports one pool for unified memory', () => {
    const b = memoryBudget(16 * GB, [])
    expect(b.usable_vram).toBe(16 * GB - RESERVE_BYTES)
    expect(b.usable_total).toBe(b.usable_vram)
  })
  it('lets a discrete GPU beside an integrated one contribute alone', () => {
    const b = memoryBudget(32 * GB, [integrated(4 * GB), discrete(24 * GB)])
    expect(b.usable_total).toBe(32 * GB - RESERVE_BYTES + (24 * GB - RESERVE_BYTES))
    expect(b.usable_vram).toBe(28 * GB - RESERVE_BYTES)
  })
  it('offers nothing on a machine smaller than the reserve', () => {
    expect(memoryBudget(1 * GB, [integrated(512 * 1024 * 1024)])).toEqual({ usable_total: 0, usable_vram: 0 })
  })
})

describe('modelSupportStatus / isModelSupported', () => {
  it('classifies RED / GREEN / YELLOW', () => {
    const budget = { usable_vram: 10, usable_total: 20 }
    expect(modelSupportStatus(21, budget)).toBe('RED')
    expect(modelSupportStatus(10, budget)).toBe('GREEN')
    expect(modelSupportStatus(15, budget)).toBe('YELLOW')
  })
  it('converts MiB facts and trusts only Vulkan IntegratedGpu', () => {
    expect(isIntegratedGpu({ vulkan_info: { device_type: 'IntegratedGpu' } })).toBe(true)
    expect(isIntegratedGpu({ vulkan_info: { device_type: 'DiscreteGpu' } })).toBe(false)
    expect(isIntegratedGpu({ vulkan_info: null })).toBe(false)
    expect(isIntegratedGpu({})).toBe(false)
    const status = isModelSupported(4 * GB, 1 * GB, {
      total_memory: 16 * 1024,
      gpus: [{ total_memory: 24 * 1024, vulkan_info: { device_type: 'DiscreteGpu' } }],
    })
    expect(status).toBe('GREEN')
    expect(isModelSupported(40 * GB, 0, { total_memory: 16 * 1024, gpus: [] })).toBe('RED')
  })
})
