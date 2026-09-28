import { describe, expect, it } from 'vitest'
import type { HardwareOverride, SystemInfo } from '../contracts/index.js'
import { factsOf, gpuInfoFromProbe, osTypeOf, rustArch, systemInfoWithOverride } from './facts.js'

const probed: SystemInfo = {
  cpu: {
    name: 'AMD Ryzen 9 5950X',
    core_count: 16,
    arch: 'x86_64',
    extensions: ['avx', 'avx2'],
    extensions_known: true,
  },
  os_type: 'linux',
  os_name: 'Ubuntu 24.04',
  total_memory: 65_536,
  gpus: [
    {
      name: 'NVIDIA GeForce RTX 4090',
      total_memory: 24_564,
      vendor: 'NVIDIA',
      uuid: 'abc',
      driver_version: '581.42',
      nvidia_info: { index: 0, compute_capability: '8.9' },
      vulkan_info: null,
    },
  ],
}

const override: HardwareOverride = {
  gpus: [
    { vendor: 'AMD', total_memory: 24_576, vulkan_info: { device_id: 0x744c, device_type: 'DiscreteGpu' } },
  ],
  cpu_extensions: ['avx'],
  os_type: 'windows',
  received_at: 1,
}

describe('osTypeOf / rustArch', () => {
  it.each([
    ['win32', 'windows'],
    ['darwin', 'macos'],
    ['linux', 'linux'],
    ['freebsd', 'unknown'],
  ])('%s → %s', (platform, expected) => expect(osTypeOf(platform)).toBe(expected))

  it.each([
    ['x64', 'x86_64'],
    ['ia32', 'x86'],
    ['arm64', 'arm64'],
  ])('%s → %s', (arch, expected) => expect(rustArch(arch)).toBe(expected))
})

describe('factsOf', () => {
  it('reads the probe when nothing is injected', () => {
    const facts = factsOf(probed, 'x86_64', undefined)
    expect(facts).toMatchObject({
      osType: 'linux',
      arch: 'x86_64',
      cpuExtensions: ['avx', 'avx2'],
      source: 'probe',
    })
    expect(facts.gpus).toHaveLength(1)
    expect(facts.gpus[0]).not.toBe(probed.gpus[0])
  })

  it('reports unknown CPU flags as undefined, never as an empty list', () => {
    const unknown: SystemInfo = { ...probed, cpu: { ...probed.cpu, extensions: [], extensions_known: false } }
    expect(factsOf(unknown, 'x86_64', undefined).cpuExtensions).toBeUndefined()
  })

  it('lets an override replace the GPUs, flags and OS wholesale', () => {
    const facts = factsOf(probed, 'x86_64', override)
    expect(facts).toMatchObject({ osType: 'windows', cpuExtensions: ['avx'], source: 'override' })
    expect(facts.gpus).toEqual(override.gpus)
  })

  it('falls back to the probe’s flags when the override carries none', () => {
    const { cpu_extensions: _dropped, ...withoutFlags } = override
    expect(factsOf(probed, 'x86_64', withoutFlags).cpuExtensions).toEqual(['avx', 'avx2'])
  })
})

describe('gpuInfoFromProbe / systemInfoWithOverride', () => {
  it('fills the plugin’s empty values for fields an override does not carry', () => {
    expect(gpuInfoFromProbe({ vendor: 'NVIDIA', nvidia_info: {} }, 2)).toEqual({
      name: 'GPU 2',
      total_memory: 0,
      vendor: 'NVIDIA',
      uuid: 'override-2',
      driver_version: '',
      nvidia_info: { index: 2, compute_capability: '' },
      vulkan_info: null,
    })
    expect(gpuInfoFromProbe({}, 0).vendor).toBe('Unknown (vendor_id: 0)')
    expect(gpuInfoFromProbe({ vulkan_info: {} }, 0).vulkan_info).toEqual({
      index: 0,
      device_type: 'Unknown',
      api_version: '',
      device_id: 0,
    })
  })

  it('serves the probe’s CPU and memory with the override’s GPUs', () => {
    const info = systemInfoWithOverride(probed, override)
    expect(info.os_type).toBe('windows')
    expect(info.total_memory).toBe(65_536)
    expect(info.cpu).toEqual({ ...probed.cpu, extensions: ['avx'], extensions_known: true })
    expect(info.gpus.map((g) => g.vendor)).toEqual(['AMD'])
    expect(info.gpus[0]?.vulkan_info?.device_id).toBe(0x744c)
  })
})
