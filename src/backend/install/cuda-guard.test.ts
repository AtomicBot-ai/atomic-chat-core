import { describe, expect, it } from 'vitest'
import { CAN_INSTALL_FAKE_BACKEND, installFakeBackend } from '../../../test/helpers/fake-backend-pack.js'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { HardwareFacts } from '../../hardware/index.js'
import { CudaRuntimeGuard, factsWithoutCuda } from './cuda-guard.js'
import type { GuardedEnsureSteps } from './cuda-guard.js'

const FACTS: HardwareFacts = {
  osType: 'windows',
  arch: 'x86_64',
  cpuExtensions: ['avx', 'avx2'],
  source: 'probe',
  gpus: [
    {
      name: 'NVIDIA GeForce RTX 4090',
      vendor: 'NVIDIA',
      driver_version: '581.42',
      total_memory: 24_564,
      nvidia_info: { compute_capability: '8.9' },
      vulkan_info: { device_id: 0x2684, device_type: 'DiscreteGpu' },
    },
    { name: 'Intel(R) UHD Graphics 770', vendor: 'Intel', nvidia_info: null, vulkan_info: null },
  ],
}
const hardware = { facts: async () => structuredClone(FACTS) }
const CUDA = { version: 'b12019', backend: 'win-cuda-13.3-x64', exePath: 'C:\\cuda\\llama-server.exe' }
const VULKAN = { version: 'b12019', backend: 'win-vulkan-x64', path: 'C:\\vulkan\\llama-server.exe' }

/** `ensureBackend` as the runtime calls it: the configured pack, repaired, then returned. */
function steps(over: Partial<GuardedEnsureSteps> & { repairFails?: boolean } = {}) {
  const seen = { repairs: 0, selects: [] as HardwareFacts[], ensureFacts: [] as HardwareFacts[] }
  const s: GuardedEnsureSteps = {
    ensure: async (facts, repair) => {
      seen.ensureFacts.push(await facts.facts())
      await repair(CUDA.backend, CUDA.version)
      return CUDA
    },
    repair: async () => {
      seen.repairs += 1
      if (over.repairFails) throw new Error('offline')
      return 'downloaded'
    },
    select: async (facts) => {
      seen.selects.push(await facts.facts())
      return VULKAN
    },
    ...over,
  }
  return { steps: s, seen }
}

describe('factsWithoutCuda', () => {
  it('drops only the CUDA side of the NVIDIA GPUs, keeping their Vulkan facts', () => {
    const stripped = factsWithoutCuda(FACTS)
    expect(stripped.gpus[0]).toEqual({ ...FACTS.gpus[0], nvidia_info: null })
    expect(stripped.gpus[1]).toBe(FACTS.gpus[1])
    expect(stripped).toMatchObject({ osType: 'windows', cpuExtensions: ['avx', 'avx2'] })
    expect(FACTS.gpus[0]?.nvidia_info).not.toBeNull()
  })
})

describe('CudaRuntimeGuard', () => {
  it('passes the configured CUDA pack through while its runtime is repaired', async () => {
    const guard = new CudaRuntimeGuard({ toolkitOnHost: () => false })
    const { steps: s, seen } = steps()
    await expect(guard.ensure('llamacpp-upstream', hardware, s)).resolves.toEqual(CUDA)
    expect(seen.repairs).toBe(1)
    expect(seen.selects).toEqual([])
    expect(guard.isBlocked('llamacpp-upstream')).toBe(false)
    expect(seen.ensureFacts[0]?.gpus[0]?.nvidia_info).not.toBeNull()
  })

  it('leaves CUDA out of selection for the run and loads another pack when the repair fails', async () => {
    const logs: string[] = []
    const guard = new CudaRuntimeGuard({ toolkitOnHost: () => false, log: (_level, m) => logs.push(m) })
    const { steps: s, seen } = steps({ repairFails: true })
    await expect(guard.ensure('llamacpp-upstream', hardware, s)).resolves.toEqual({
      version: VULKAN.version,
      backend: VULKAN.backend,
      exePath: VULKAN.path,
    })
    expect(guard.isBlocked('llamacpp-upstream')).toBe(true)
    expect(guard.isBlocked('llamacpp')).toBe(false)
    expect(seen.selects[0]?.gpus.every((gpu) => !gpu.nvidia_info)).toBe(true)
    expect(logs).toEqual([
      'cudart pre-flight for b12019/win-cuda-13.3-x64 failed: Error: offline',
      'llamacpp-upstream: CUDA builds are left out of backend selection until the core restarts',
      'b12019/win-cuda-13.3-x64 cannot run without its CUDA runtime; loading b12019/win-vulkan-x64 instead',
    ])
    // Selection reads the facts without CUDA from now on, for this provider only.
    expect((await guard.facts('llamacpp-upstream', hardware).facts()).gpus[0]?.nvidia_info).toBeNull()
    expect((await guard.facts('llamacpp', hardware).facts()).gpus[0]?.nvidia_info).not.toBeNull()
    // The next load tries the configured pack again (its repair may work now) and says the block once.
    await guard.ensure('llamacpp-upstream', hardware, s)
    expect(seen.repairs).toBe(2)
    expect(seen.ensureFacts[1]?.gpus[0]?.nvidia_info).toBeNull()
    expect(logs.filter((m) => m.includes('left out'))).toHaveLength(1)
  })

  it('keeps the CUDA pack when nothing else is installed, the choice is the same pack, or a toolkit is on the host', async () => {
    const none = new CudaRuntimeGuard({ toolkitOnHost: () => false })
    await expect(
      none.ensure('llamacpp', hardware, steps({ repairFails: true, select: async () => undefined }).steps)
    ).resolves.toEqual(CUDA)
    expect(none.isBlocked('llamacpp')).toBe(true)

    const same = new CudaRuntimeGuard()
    const sameSteps = steps({
      repairFails: true,
      select: async () => ({ version: CUDA.version, backend: CUDA.backend, path: CUDA.exePath }),
    }).steps
    const toolkitless = new CudaRuntimeGuard({ toolkitOnHost: () => false })
    await expect(toolkitless.ensure('llamacpp', hardware, sameSteps)).resolves.toEqual(CUDA)

    const toolkit = new CudaRuntimeGuard({ toolkitOnHost: () => true })
    const { steps: s, seen } = steps({ repairFails: true })
    await expect(toolkit.ensure('llamacpp-upstream', hardware, s)).resolves.toEqual(CUDA)
    expect(toolkit.isBlocked('llamacpp-upstream')).toBe(false)
    expect(seen.selects).toEqual([])
    // The default toolkit probe is the runtime's CUDA path discovery (none on macOS, deterministically).
    expect(same.isBlocked('llamacpp')).toBe(false)
    const probed = new CudaRuntimeGuard({ platform: 'darwin', env: {} })
    await expect(
      probed.ensure('llamacpp', hardware, steps({ repairFails: true }).steps)
    ).resolves.toMatchObject({
      backend: VULKAN.backend,
    })
  })
})

// The scanner looks for `llama-server.exe` on Windows, and the fake pack is a shell script.
describe.skipIf(!CAN_INSTALL_FAKE_BACKEND)('CudaRuntimeGuard.ensureBackend over the data folder', () => {
  it('loads the configured CUDA pack, and the best other installed pack once its runtime cannot be repaired', async () => {
    const data = await makeTmpDataFolder('atomic-cuda-guard-')
    try {
      await installFakeBackend(data.layout, { version: 'b7000', backend: 'win-cpu-x64' })
      const cuda = await installFakeBackend(data.layout, { version: 'b7000', backend: 'win-cuda-13.3-x64' })
      const guard = new CudaRuntimeGuard({ toolkitOnHost: () => false })
      const repaired: string[] = []
      const ok = await guard.ensureBackend(
        data.layout,
        'llamacpp-upstream',
        'win-cuda-13.3-x64',
        'b7000',
        hardware,
        'x64',
        async (backend, version) => void repaired.push(`${version}/${backend}`)
      )
      expect(ok).toEqual({ version: 'b7000', backend: 'win-cuda-13.3-x64', exePath: cuda.exePath })
      expect(repaired).toEqual(['b7000/win-cuda-13.3-x64'])
      const fallback = await guard.ensureBackend(
        data.layout,
        'llamacpp-upstream',
        'win-cuda-13.3-x64',
        'b7000',
        hardware,
        'x64',
        async () => {
          throw new Error('offline')
        }
      )
      expect(fallback).toMatchObject({ version: 'b7000', backend: 'win-cpu-x64' })
    } finally {
      await data.cleanup()
    }
  })
})
