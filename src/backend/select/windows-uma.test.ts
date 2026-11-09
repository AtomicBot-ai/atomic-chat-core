import { detectIdealPrismBackendType, determineBestPrismBackend } from './prism.js'
import { expect, it } from 'vitest'
import type { GpuProbeInfo } from '../types.js'
import { detectIdealBackendType } from './tiers.js'
import { detectIdealTurboquantBackendType } from './turboquant-tiers.js'
import { determineBestTurboquantBackend } from '../turboquant.js'

const apu: GpuProbeInfo = {
  vendor: 'AMD',
  total_memory: 512,
  shared_memory: 15945,
  vulkan_info: { device_type: 'IntegratedGpu', device_id: 0x1114 },
}
const card: GpuProbeInfo = {
  vendor: 'AMD',
  total_memory: 8192,
  vulkan_info: { device_type: 'DiscreteGpu', device_id: 0x744c },
}
it.each([
  ['UMA APU', [apu], true],
  ['UMA APU and discrete Radeon', [apu, card], true],
  ['discrete Radeon and UMA APU', [card, apu], true],
  ['unknown shared capacity', [{ vendor: 'AMD', total_memory: 512, vulkan_info: apu.vulkan_info! }], false],
  [
    'separate small devices',
    [
      { ...apu, shared_memory: 1024 },
      { ...card, total_memory: 1024 },
    ],
    false,
  ],
  [
    'VRAM belongs to a different adapter without Vulkan',
    [
      { ...apu, shared_memory: 1024 },
      { vendor: 'AMD', total_memory: 8192 },
    ],
    false,
  ],
] as const)('selects Windows GPU builds using per-adapter capacity: %s', async (_name, gpus, usable) => {
  const common = {
    osType: 'windows',
    arch: 'x86_64',
    cpuExtensions: [],
    gpus,
    probeTier: async () => 'unverified' as const,
  }
  for (const [detect, backend] of [
    [detectIdealBackendType, 'win-vulkan-x64'],
    [detectIdealTurboquantBackendType, 'windows-x64-vulkan'],
  ] as const) {
    expect(
      await detect({ ...common, listAvailableBackends: async () => [{ version: 'v1', backend }] })
    ).toEqual(usable ? { kind: 'gpu', backend } : { kind: 'cpu-optimal' })
  }
})
it('ranks the TurboQuant Vulkan download ahead of CPU for measured UMA capacity', () => {
  expect(
    determineBestTurboquantBackend(
      [
        { version: 'b10298-2.1.0', backend: 'windows-x64-cpu' },
        { version: 'b10298-2.1.0', backend: 'windows-x64-vulkan' },
      ],
      [apu]
    )
  ).toBe('b10298-2.1.0/windows-x64-vulkan')
})

it('keeps headless Linux ROCm eligible without a Vulkan ICD', async () => {
  expect(
    await detectIdealTurboquantBackendType({
      osType: 'linux',
      arch: 'x86_64',
      cpuExtensions: [],
      gpus: [{ vendor: 'AMD', total_memory: 24576, vulkan_info: null }],
      rocm: { hasRuntime: true, gfxTargetVersions: [110000] },
      listAvailableBackends: async () => [{ version: 'v1', backend: 'linux-x64-rocm' }],
    })
  ).toEqual({ kind: 'gpu', backend: 'linux-x64-rocm' })
})

it.each([[[apu]], [[apu, card]]])('uses UMA capacity for Prism on Windows: %j', async (...[gpus]) => {
  const backends = [
    { version: 'prism-b1-a', backend: 'win-cpu-x64' },
    { version: 'prism-b1-a', backend: 'win-vulkan-x64' },
  ]
  expect(determineBestPrismBackend(backends, gpus)).toBe('prism-b1-a/win-vulkan-x64')
  expect(
    await detectIdealPrismBackendType({
      osType: 'windows',
      arch: 'x86_64',
      cpuExtensions: [],
      gpus,
      listAvailableBackends: async () => backends,
    })
  ).toEqual({ kind: 'gpu', backend: 'win-vulkan-x64' })
})

it.each([
  ['available', 'unverified', 'win-rocm-10.0-x64'],
  ['working', 'works', 'win-rocm-10.0-x64'],
  ['broken', 'broken', 'win-vulkan-x64'],
] as const)('prefers Radeon 860M ROCm when %s, retaining Vulkan fallback', async (_name, health, backend) => {
  expect(
    await detectIdealBackendType({
      osType: 'windows',
      arch: 'x86_64',
      cpuExtensions: [],
      gpus: [apu],
      listAvailableBackends: async () => [
        { version: 'b12019', backend: 'win-rocm-10.0-x64' },
        { version: 'b12019', backend: 'win-vulkan-x64' },
      ],
      probeTier: async (tier) => (tier.includes('rocm') ? health : 'works'),
    })
  ).toEqual({ kind: 'gpu', backend })
})
