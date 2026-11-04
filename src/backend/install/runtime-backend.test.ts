import { describe, expect, it } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { CAN_INSTALL_FAKE_BACKEND, installFakeBackend } from '../../../test/helpers/fake-backend-pack.js'
import type { GpuProbeInfo } from '../../contracts/index.js'
import type { HardwareFactsSource } from '../../hardware/index.js'
import {
  badBackendsPath,
  ensureBackend,
  llamaBackendFallback,
  platformArch,
  readBadBackends,
  rememberBadBackend,
  selectInstalledBackend,
} from './runtime-backend.js'

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

/** A GTX 1660 on a driver before R616: CUDA 13 is gated off, CUDA 12.4 and Vulkan stay. */
const turing = (driver: string) =>
  facts({
    osType: 'windows',
    cpuExtensions: ['avx2'],
    gpus: [
      {
        vendor: 'NVIDIA',
        driver_version: driver,
        total_memory: 6144,
        nvidia_info: { compute_capability: '7.5' },
        vulkan_info: { device_type: 'DiscreteGpu', device_id: 0x2184 },
      },
    ],
  })
/** An RTX 3060 on an R58x driver: every CUDA tier is open. */
const ampere = (driver = '581.57') =>
  facts({
    osType: 'windows',
    cpuExtensions: ['avx2'],
    gpus: [
      {
        vendor: 'NVIDIA',
        driver_version: driver,
        total_memory: 12_288,
        nvidia_info: { compute_capability: '8.6' },
        vulkan_info: { device_type: 'DiscreteGpu', device_id: 0x2504 },
      },
    ],
  })

describe.skipIf(!CAN_INSTALL_FAKE_BACKEND)('a backend that could not run on this machine', () => {
  const PACKS = ['win-cpu-x64', 'win-vulkan-x64', 'win-cuda-12.4-x64', 'win-cuda-13.3-x64']
  const install = async (data: Awaited<ReturnType<typeof makeTmpDataFolder>>) => {
    for (const backend of PACKS) await installFakeBackend(data.layout, { version: 'b12019', backend })
  }

  it('no longer selects CUDA 13 for Turing on a driver before 616, and does once it is updated', async () => {
    const data = await makeTmpDataFolder('atomic-runtime-backend-')
    try {
      await install(data)
      await expect(
        selectInstalledBackend(data.layout, 'llamacpp-upstream', turing('596.36'), 'x64')
      ).resolves.toMatchObject({ backend: 'win-cuda-12.4-x64' })
      await expect(
        selectInstalledBackend(data.layout, 'llamacpp-upstream', turing('616.07'), 'x64')
      ).resolves.toMatchObject({ backend: 'win-cuda-13.3-x64' })
    } finally {
      await data.cleanup()
    }
  })

  it('remembers the pack, answers the next one down, and passes it over until the driver changes', async () => {
    const data = await makeTmpDataFolder('atomic-runtime-backend-')
    try {
      await install(data)
      const hardware = ampere()
      const failed = { version: 'b12019', backend: 'win-cuda-13.3-x64' }
      await expect(
        llamaBackendFallback(data.layout, 'llamacpp-upstream', hardware, failed, 'GPU_BACKEND_INCOMPATIBLE', {
          hostArch: 'x64',
          now: () => new Date('2026-11-04T10:00:00Z'),
        })
      ).resolves.toEqual({ version: 'b12019', backend: 'win-cuda-12.4-x64' })
      expect(await readBadBackends(data.layout)).toEqual([
        {
          provider: 'llamacpp-upstream',
          backend: 'win-cuda-13.3-x64',
          driver: '581.57',
          reason: 'GPU_BACKEND_INCOMPATIBLE',
          version: 'b12019',
          at: '2026-11-04T10:00:00.000Z',
        },
      ])
      expect(badBackendsPath(data.layout)).toBe(join(data.layout.core.dir, 'bad-backends.json'))

      // Selection and the configured pack both skip it on this driver…
      await expect(
        selectInstalledBackend(data.layout, 'llamacpp-upstream', hardware, 'x64')
      ).resolves.toMatchObject({ backend: 'win-cuda-12.4-x64' })
      const repaired: string[] = []
      await expect(
        ensureBackend(
          data.layout,
          'llamacpp-upstream',
          'win-cuda-13.3-x64',
          'b12019',
          hardware,
          'x64',
          async (b) => {
            repaired.push(b)
          }
        )
      ).resolves.toMatchObject({ backend: 'win-cuda-12.4-x64' })
      expect(repaired).toEqual(['win-cuda-12.4-x64'])
      // …a pack that did not fail is still used as configured…
      await expect(
        ensureBackend(data.layout, 'llamacpp-upstream', 'win-cpu-x64', 'b12019', hardware, 'x64')
      ).resolves.toMatchObject({ backend: 'win-cpu-x64' })
      // …and a new driver forgets it.
      await expect(
        ensureBackend(
          data.layout,
          'llamacpp-upstream',
          'win-cuda-13.3-x64',
          'b12019',
          ampere('620.10'),
          'x64'
        )
      ).resolves.toMatchObject({ backend: 'win-cuda-13.3-x64' })

      // The next failure walks on down: CUDA 12.4 → Vulkan → CPU, then nothing.
      await expect(
        llamaBackendFallback(
          data.layout,
          'llamacpp-upstream',
          hardware,
          { version: 'b12019', backend: 'win-cuda-12.4-x64' },
          'EMPTY_STDERR_CRASH',
          { hostArch: 'x64' }
        )
      ).resolves.toEqual({ version: 'b12019', backend: 'win-vulkan-x64' })
      await expect(
        llamaBackendFallback(
          data.layout,
          'llamacpp-upstream',
          hardware,
          { version: 'b12019', backend: 'win-cpu-x64' },
          'ENGINE_BINARY_BROKEN',
          { hostArch: 'x64' }
        )
      ).resolves.toBeUndefined()
    } finally {
      await data.cleanup()
    }
  })

  it('still runs a pack that failed here when it is the only one installed', async () => {
    const data = await makeTmpDataFolder('atomic-runtime-backend-')
    try {
      const only = await installFakeBackend(data.layout, { version: 'b12019', backend: 'win-cuda-13.3-x64' })
      const hardware = ampere()
      await rememberBadBackend(data.layout, {
        provider: 'llamacpp-upstream',
        backend: 'win-cuda-13.3-x64',
        driver: '581.57',
        reason: 'GPU_BACKEND_INCOMPATIBLE',
        version: 'b12019',
        at: '',
      })
      await expect(
        ensureBackend(data.layout, 'llamacpp-upstream', 'win-cuda-13.3-x64', 'b12019', hardware, 'x64')
      ).resolves.toEqual({ version: 'b12019', backend: 'win-cuda-13.3-x64', exePath: only.exePath })
      await expect(
        selectInstalledBackend(data.layout, 'llamacpp-upstream', hardware, 'x64')
      ).resolves.toMatchObject({ backend: 'win-cuda-13.3-x64' })
    } finally {
      await data.cleanup()
    }
  })

  it('reads a corrupt record file as empty, and falls back even when the record cannot be written', async () => {
    const data = await makeTmpDataFolder('atomic-runtime-backend-')
    try {
      await install(data)
      await mkdir(data.layout.core.dir, { recursive: true })
      await writeFile(badBackendsPath(data.layout), '{ not json')
      expect(await readBadBackends(data.layout)).toEqual([])
      await writeFile(badBackendsPath(data.layout), '  ')
      expect(await readBadBackends(data.layout)).toEqual([])
      // A directory where the file goes: the write fails, the answer does not.
      await rm(badBackendsPath(data.layout))
      await mkdir(badBackendsPath(data.layout))
      const logged: string[] = []
      await expect(
        llamaBackendFallback(
          data.layout,
          'llamacpp-upstream',
          ampere(),
          { version: 'b12019', backend: 'win-cuda-13.3-x64' },
          'GPU_BACKEND_INCOMPATIBLE',
          { hostArch: 'x64', log: (m) => logged.push(m) }
        )
      ).resolves.toEqual({ version: 'b12019', backend: 'win-cuda-12.4-x64' })
      expect(logged).toEqual([
        expect.stringMatching(/^could not remember b12019\/win-cuda-13.3-x64 as unusable here: /),
      ])
      await expect(readFile(badBackendsPath(data.layout), 'utf8')).rejects.toThrow()
    } finally {
      await data.cleanup()
    }
  })
})
