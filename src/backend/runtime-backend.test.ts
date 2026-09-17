import { describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { installFakeBackend } from '../../test/helpers/fake-backend-pack.js'
import { HardwareOverrideStore } from '../hardware/index.js'
import { ensureBackend, selectInstalledBackend } from './runtime-backend.js'

describe('runtime backend selection', () => {
  it('uses injected GPU facts instead of installed-directory order', async () => {
    const data = await makeTmpDataFolder('atomic-runtime-backend-')
    try {
      await installFakeBackend(data.layout, { version: 'b7000', backend: 'win-cpu-x64' })
      await installFakeBackend(data.layout, { version: 'b7000', backend: 'win-cuda-13.3-x64' })
      const hardware = new HardwareOverrideStore()
      hardware.set({
        os_type: 'windows',
        cpu_extensions: ['avx2'],
        gpus: [
          {
            vendor: 'NVIDIA',
            driver_version: '581.42',
            total_memory: 24_576,
            nvidia_info: { compute_capability: '8.9' },
            vulkan_info: { device_type: 'DiscreteGpu', device_id: 9860 },
          },
        ],
      })

      await expect(
        selectInstalledBackend(data.layout, 'llamacpp-upstream', hardware, 'x64')
      ).resolves.toMatchObject({ version_backend: 'b7000/win-cuda-13.3-x64' })
    } finally {
      await data.cleanup()
    }
  })

  it('does not execute an installed backend that the injected hardware cannot support', async () => {
    const data = await makeTmpDataFolder('atomic-runtime-backend-')
    try {
      await installFakeBackend(data.layout, { version: 'b7000', backend: 'win-cuda-13.3-x64' })
      const hardware = new HardwareOverrideStore()
      hardware.set({ os_type: 'windows', cpu_extensions: [], gpus: [] })

      await expect(
        ensureBackend(data.layout, 'llamacpp-upstream', 'missing', 'b0', hardware, 'x64')
      ).rejects.toMatchObject({ code: 'BINARY_NOT_FOUND' })
    } finally {
      await data.cleanup()
    }
  })

  it('chooses among TurboQuant packs with the fork matrix, and repairs the pack it returns', async () => {
    const data = await makeTmpDataFolder('atomic-runtime-backend-')
    try {
      for (const backend of ['windows-x64-cpu', 'windows-x64-cuda-12.4', 'win-cuda-13.3-x64'])
        await installFakeBackend(data.layout, { provider: 'llamacpp', version: 'b10018-1.3.0', backend })
      const hardware = new HardwareOverrideStore()
      hardware.set({
        os_type: 'windows',
        cpu_extensions: [],
        gpus: [
          {
            vendor: 'NVIDIA',
            driver_version: '528.0',
            total_memory: 8192,
            nvidia_info: { compute_capability: '8.6' },
          },
        ],
      })
      // 528 passes the fork's CUDA 12 floor (527.41) but not upstream's (551.61); the upstream id is
      // not a TurboQuant build and maps onto CPU here.
      await expect(selectInstalledBackend(data.layout, 'llamacpp', hardware, 'x64')).resolves.toMatchObject({
        version_backend: 'b10018-1.3.0/windows-x64-cuda-12.4',
      })
      const repaired: string[] = []
      await expect(
        ensureBackend(data.layout, 'llamacpp', 'missing', 'b0', hardware, 'x64', async (backend, version) => {
          repaired.push(`${version}/${backend}`)
        })
      ).resolves.toMatchObject({ backend: 'windows-x64-cuda-12.4' })
      await ensureBackend(
        data.layout,
        'llamacpp',
        'windows-x64-cpu',
        'b10018-1.3.0',
        hardware,
        'x64',
        async (backend, version) => {
          repaired.push(`${version}/${backend}`)
        }
      )
      expect(repaired).toEqual(['b10018-1.3.0/windows-x64-cuda-12.4', 'b10018-1.3.0/windows-x64-cpu'])

      const linux = new HardwareOverrideStore()
      linux.set({ os_type: 'linux', cpu_extensions: [], gpus: [] })
      await installFakeBackend(data.layout, {
        provider: 'llamacpp',
        version: 'b10018-1.3.0',
        backend: 'linux-x64-rocm',
      })
      await installFakeBackend(data.layout, {
        provider: 'llamacpp',
        version: 'b10018-1.3.0',
        backend: 'linux-x64-vulkan',
      })
      await expect(
        selectInstalledBackend(data.layout, 'llamacpp', linux, 'x64', async () => ({
          gfxTargetVersions: [110000],
          hasRuntime: true,
        }))
      ).resolves.toMatchObject({ backend: 'linux-x64-vulkan' })
      const none = new HardwareOverrideStore()
      none.set({ os_type: 'linux', cpu_extensions: [], gpus: [] })
      await expect(selectInstalledBackend(data.layout, 'llamacpp', none, 'arm64')).resolves.toBeUndefined()
    } finally {
      await data.cleanup()
    }
  })

  it('keeps an exact configured executable authoritative', async () => {
    const data = await makeTmpDataFolder('atomic-runtime-backend-')
    try {
      const installed = await installFakeBackend(data.layout, {
        version: 'b7000',
        backend: 'macos-arm64',
      })

      await expect(
        ensureBackend(
          data.layout,
          'llamacpp-upstream',
          installed.backend,
          installed.version,
          new HardwareOverrideStore()
        )
      ).resolves.toEqual({
        version: installed.version,
        backend: installed.backend,
        exePath: installed.exePath,
      })
    } finally {
      await data.cleanup()
    }
  })
})
