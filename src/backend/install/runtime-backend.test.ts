import { describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { CAN_INSTALL_FAKE_BACKEND, installFakeBackend } from '../../../test/helpers/fake-backend-pack.js'
import type { GpuProbeInfo } from '../../contracts/index.js'
import type { HardwareFactsSource } from '../../hardware/index.js'
import { ensureBackend, platformArch, selectInstalledBackend } from './runtime-backend.js'

/** A `HardwareFactsSource` that answers what a test says the machine is. */
const facts = (over: {
  osType: string
  cpuExtensions?: string[] | undefined
  gpus?: GpuProbeInfo[]
}): HardwareFactsSource => ({
  facts: async () => ({
    osType: over.osType,
    arch: 'x86_64',
    cpuExtensions: over.cpuExtensions,
    gpus: over.gpus ?? [],
    source: 'probe',
  }),
})

describe('platformArch', () => {
  it.each([
    ['x64', 'x86_64'],
    ['ia32', 'x86'],
    ['arm64', 'arm64'],
  ])('maps %s to %s', (node, rust) => {
    expect(platformArch(node)).toBe(rust)
  })
})

// The scanner looks for `llama-server.exe` on Windows, and the fake pack is a shell script.
describe.skipIf(!CAN_INSTALL_FAKE_BACKEND)('runtime backend selection', () => {
  it('uses injected GPU facts instead of installed-directory order', async () => {
    const data = await makeTmpDataFolder('atomic-runtime-backend-')
    try {
      await installFakeBackend(data.layout, { version: 'b7000', backend: 'win-cpu-x64' })
      await installFakeBackend(data.layout, { version: 'b7000', backend: 'win-cuda-13.3-x64' })
      const hardware = facts({
        osType: 'windows',
        cpuExtensions: ['avx2'],
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
      // Flags unknown (`undefined`) read as none for the feature gates and never block on their own.
      const hardware = facts({ osType: 'windows', cpuExtensions: undefined })

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
      const hardware = facts({
        osType: 'windows',
        cpuExtensions: [],
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

      const linux = facts({ osType: 'linux', cpuExtensions: [] })
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
      const none = facts({ osType: 'linux', cpuExtensions: [] })
      await expect(selectInstalledBackend(data.layout, 'llamacpp', none, 'arm64')).resolves.toBeUndefined()
    } finally {
      await data.cleanup()
    }
  })

  it('chooses among PrismML packs with the Prism matrix, newest build first', async () => {
    const data = await makeTmpDataFolder('atomic-runtime-backend-')
    try {
      for (const [version, backend] of [
        ['prism-b10754-2459f68', 'win-cpu-x64'],
        ['prism-b10754-2459f68', 'win-cuda-12.4-x64'],
        ['prism-b10800-aaaaaaa', 'win-cuda-12.4-x64'],
        ['b7000', 'win-cuda-13.3-x64'],
      ] as const)
        await installFakeBackend(data.layout, { provider: 'atomic-prism', version, backend })
      const nvidia = facts({
        osType: 'windows',
        cpuExtensions: ['avx2'],
        gpus: [
          {
            vendor: 'NVIDIA',
            driver_version: '581.42',
            total_memory: 24_576,
            nvidia_info: { compute_capability: '8.9' },
          },
        ],
      })
      await expect(selectInstalledBackend(data.layout, 'atomic-prism', nvidia, 'x64')).resolves.toMatchObject(
        {
          version_backend: 'prism-b10800-aaaaaaa/win-cuda-12.4-x64',
        }
      )
      const cpuOnly = facts({ osType: 'windows', cpuExtensions: [] })
      await expect(
        selectInstalledBackend(data.layout, 'atomic-prism', cpuOnly, 'x64')
      ).resolves.toMatchObject({
        version_backend: 'prism-b10754-2459f68/win-cpu-x64',
      })
      await expect(
        selectInstalledBackend(data.layout, 'atomic-prism', cpuOnly, 'arm64')
      ).resolves.toBeUndefined()
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
          facts({ osType: 'macos' })
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
