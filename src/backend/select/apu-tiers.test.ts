import { expect, it } from 'vitest'
import { detectIdealBackendType } from './tiers.js'

it.each([
  [true, true, 'linux-rocm-10.0-x64'],
  [false, true, 'linux-vulkan-x64'],
  [true, false, 'linux-vulkan-x64'],
])(
  'uses measured APU memory, preserving HIP runtime (%s) and archive (%s) gates',
  async (hasRuntime, archive, backend) => {
    const gpu = {
      vendor: 'AMD',
      total_memory: 512,
      shared_memory: 15606,
      vulkan_info: { device_type: 'IntegratedGpu', device_id: 0x1114 },
    }
    expect(
      await detectIdealBackendType({
        osType: 'linux',
        arch: 'x86_64',
        cpuExtensions: [],
        gpus: [gpu],
        rocm: { hasRuntime, gfxTargetVersions: [110502] },
        listAvailableBackends: async () =>
          archive ? [{ version: 'b12019', backend: 'linux-rocm-10.0-x64' }] : [],
        probeTier: async () => 'unverified',
      })
    ).toEqual({ kind: 'gpu', backend })
  }
)
