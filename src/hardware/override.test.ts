import { describe, expect, it } from 'vitest'
import { HardwareOverrideStore } from './override.js'
import type { GpuProbeInfo } from '../backend/index.js'

const probed: GpuProbeInfo[] = [{ vendor: 'NVIDIA', total_memory: 8192 }]
const injected: GpuProbeInfo[] = [
  {
    vendor: 'NVIDIA',
    driver_version: '551.23',
    total_memory: 24576,
    nvidia_info: { compute_capability: '8.9' },
    vulkan_info: { device_id: 0x2684, device_type: 'DiscreteGpu' },
  },
]

const store = (now = () => 1_700_000_000_000) => new HardwareOverrideStore(now)

describe('HardwareOverrideStore', () => {
  it('uses the core’s own probe until something is injected', () => {
    const s = store()

    expect(s.get()).toBeUndefined()
    expect(s.gpus(probed)).toEqual(probed)
    expect(s.cpuExtensions(['avx2'])).toEqual(['avx2'])
  })

  it('replaces the probe wholesale, because the two must not be mixed', () => {
    // The injected list carries the driver version and compute capability the core cannot see; a
    // merge would produce a third description of the machine matching neither side.
    const s = store()

    s.set({ gpus: injected })

    expect(s.gpus(probed)).toEqual(injected)
    expect(s.gpus(probed)).not.toContainEqual(probed[0])
  })

  it('records when it arrived and who sent it', () => {
    const s = store(() => 42)

    const stored = s.set({ gpus: [], source: 'tauri-plugin-hardware', os_type: 'windows' })

    expect(stored).toMatchObject({
      received_at: 42,
      source: 'tauri-plugin-hardware',
      os_type: 'windows',
    })
  })

  it('accepts an empty list, which is a real answer', () => {
    // A machine with no GPU is not a machine we failed to probe.
    const s = store()

    s.set({ gpus: [] })

    expect(s.gpus(probed)).toEqual([])
  })

  it('lowercases cpu extensions, because the feature check compares them lowercase', () => {
    const s = store()

    s.set({ gpus: [], cpu_extensions: ['AVX', 'Avx2'] })

    expect(s.cpuExtensions([])).toEqual(['avx', 'avx2'])
  })

  it('keeps the probed extensions when the override does not mention any', () => {
    const s = store()

    s.set({ gpus: injected })

    expect(s.cpuExtensions(['avx512'])).toEqual(['avx512'])
  })

  it('refuses a payload it cannot read rather than applying half of it', () => {
    const s = store()

    expect(() => s.set({})).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
    expect(() => s.set({ gpus: 'nope' })).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
    expect(() => s.set({ gpus: [null] })).toThrowError(/gpus\[0\]/)
    expect(() => s.set({ gpus: [], cpu_extensions: [1] })).toThrowError(/cpu_extensions/)
    expect(s.get(), 'a rejected override leaves the previous state alone').toBeUndefined()
  })

  it('a rejected override does not replace one that was already in force', () => {
    const s = store()
    s.set({ gpus: injected })

    expect(() => s.set({ gpus: 'nope' })).toThrow()

    expect(s.gpus(probed)).toEqual(injected)
  })

  it('clearing goes back to the probe, and says whether there was anything to clear', () => {
    const s = store()
    expect(s.clear()).toBe(false)

    s.set({ gpus: injected })
    expect(s.clear()).toBe(true)

    expect(s.gpus(probed)).toEqual(probed)
  })

  it('hands out copies, so a caller cannot edit the stored override in place', () => {
    const s = store()
    s.set({ gpus: injected })

    const first = s.gpus([])
    first[0]!.total_memory = 1

    expect(s.gpus([])[0]?.total_memory).toBe(24576)
  })
})
