import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  backendKindOf,
  companionFor,
  diffusionBackendLadder,
  LINUX_VULKAN_MIN_VRAM_MIB,
  mlxHostChoice,
  readFailedBackends,
  rememberFailedBackend,
  sdcppHostChoice,
  sdcppHostOf,
  selectDiffusionBackend,
  type DiffusionBackendSelectionInput,
} from './select.js'

const MANIFEST_IDS = [
  'macos-arm64',
  'win-cuda12-x64',
  'win-rocm-7.14-x64',
  'win-vulkan-x64',
  'win-cpu-x64',
  'linux-vulkan-x64',
  'linux-rocm-7.14-x64',
  'linux-cpu-x64',
  'win-cudart-cu12',
]

/** A manifest after the Atomic arm64 builds were mirrored beside upstream's. */
const ARM64_IDS = ['linux-cuda13-arm64', 'linux-cpu-arm64', 'win-cuda13-arm64', 'win-cpu-arm64']
const WITH_ARM64 = [...MANIFEST_IDS, ...ARM64_IDS]

const host = (overrides: Partial<DiffusionBackendSelectionInput>): DiffusionBackendSelectionInput => ({
  os: 'windows',
  arch: 'x64',
  features: {},
  gpus: [],
  available: MANIFEST_IDS,
  ...overrides,
})

describe('selectDiffusionBackend on macOS', () => {
  it('installs the Metal build on Apple Silicon', () => {
    expect(selectDiffusionBackend(host({ os: 'macos', arch: 'arm64' }))).toBe('macos-arm64')
  })

  it('has nothing for an Intel Mac', () => {
    expect(selectDiffusionBackend(host({ os: 'macos', arch: 'x64' }))).toBeNull()
  })

  it('has nothing when the manifest does not ship the Mac build', () => {
    expect(
      selectDiffusionBackend(host({ os: 'macos', arch: 'arm64', available: ['win-cpu-x64'] }))
    ).toBeNull()
  })
})

describe('selectDiffusionBackend on Windows', () => {
  it('prefers CUDA 12 when the driver supports it', () => {
    expect(selectDiffusionBackend(host({ features: { cuda12: true, vulkan: true } }))).toBe('win-cuda12-x64')
  })

  it('runs the CUDA 12 build on a CUDA 13-only driver', () => {
    expect(selectDiffusionBackend(host({ features: { cuda13: true } }))).toBe('win-cuda12-x64')
  })

  it('takes ROCm over Vulkan on a supported AMD card', () => {
    expect(selectDiffusionBackend(host({ features: { rocm: true, vulkan: true } }))).toBe('win-rocm-7.14-x64')
  })

  it('picks the newest ROCm build when a tag ships several', () => {
    expect(
      selectDiffusionBackend(
        host({
          features: { rocm: true },
          available: ['win-rocm-7.14-x64', 'win-rocm-7.2-x64', 'win-cpu-x64'],
        })
      )
    ).toBe('win-rocm-7.14-x64')
  })

  it('falls through to Vulkan when the tag has no ROCm asset', () => {
    expect(
      selectDiffusionBackend(
        host({
          features: { rocm: true, vulkan: true },
          available: ['win-vulkan-x64', 'win-cpu-x64'],
        })
      )
    ).toBe('win-vulkan-x64')
  })

  it('skips a CUDA id the manifest does not list', () => {
    expect(
      selectDiffusionBackend(
        host({
          features: { cuda12: true, vulkan: true },
          available: ['win-vulkan-x64', 'win-cpu-x64'],
        })
      )
    ).toBe('win-vulkan-x64')
  })

  it('ends on the CPU build without any accelerator', () => {
    expect(selectDiffusionBackend(host({}))).toBe('win-cpu-x64')
  })

  it('has nothing for ARM Windows on a manifest without arm64 builds', () => {
    expect(selectDiffusionBackend(host({ arch: 'arm64', features: { vulkan: true } }))).toBeNull()
  })
})

describe('diffusionBackendLadder', () => {
  it('lists every build the host can fall back to, best first', () => {
    // An AMD card without the HIP SDK fails the ROCm probe and walks down.
    expect(diffusionBackendLadder(host({ features: { rocm: true, vulkan: true } }))).toEqual([
      'win-rocm-7.14-x64',
      'win-vulkan-x64',
      'win-cpu-x64',
    ])
    expect(diffusionBackendLadder(host({ features: { cuda12: true, vulkan: true } }))).toEqual([
      'win-cuda12-x64',
      'win-vulkan-x64',
      'win-cpu-x64',
    ])
    expect(diffusionBackendLadder(host({}))).toEqual(['win-cpu-x64'])
  })

  it('keeps only what the manifest ships, once each', () => {
    expect(
      diffusionBackendLadder(
        host({
          features: { rocm: true, vulkan: true },
          available: ['win-vulkan-x64', 'win-cpu-x64'],
        })
      )
    ).toEqual(['win-vulkan-x64', 'win-cpu-x64'])
    expect(
      diffusionBackendLadder(host({ arch: 'arm64', features: { cuda13: true }, available: WITH_ARM64 }))
    ).toEqual(['win-cuda13-arm64', 'win-cpu-arm64'])
    expect(
      diffusionBackendLadder(
        host({
          os: 'linux',
          features: { vulkan: true },
          gpus: [{ totalMemoryMib: LINUX_VULKAN_MIN_VRAM_MIB }],
        })
      )
    ).toEqual(['linux-vulkan-x64', 'linux-cpu-x64'])
  })

  it('is empty where selection has nothing', () => {
    expect(diffusionBackendLadder(host({ os: 'macos', arch: 'x64' }))).toEqual([])
    expect(diffusionBackendLadder(host({ available: [] }))).toEqual([])
    expect(selectDiffusionBackend(host({ available: [] }))).toBeNull()
  })
})

describe('selectDiffusionBackend on Windows on Arm', () => {
  const arm = (overrides: Partial<DiffusionBackendSelectionInput>) =>
    host({ arch: 'arm64', available: WITH_ARM64, ...overrides })

  it('takes the CUDA 13 build on an N1X with a CUDA 13 driver', () => {
    expect(selectDiffusionBackend(arm({ features: { cuda12: true, cuda13: true, vulkan: true } }))).toBe(
      'win-cuda13-arm64'
    )
  })

  it('never hands an arm64 host an x64 build', () => {
    for (const features of [{ cuda12: true }, { rocm: true }, { vulkan: true }, {}]) {
      expect(selectDiffusionBackend(arm({ features }))).toBe('win-cpu-arm64')
    }
  })

  it('runs the CPU build on a driver too old for CUDA 13', () => {
    expect(selectDiffusionBackend(arm({ features: { cuda12: true } }))).toBe('win-cpu-arm64')
  })

  it('falls back to the CPU build when the tag has no CUDA arm64 asset', () => {
    expect(
      selectDiffusionBackend(
        arm({ features: { cuda13: true }, available: [...MANIFEST_IDS, 'win-cpu-arm64'] })
      )
    ).toBe('win-cpu-arm64')
  })
})

describe('selectDiffusionBackend on Linux', () => {
  it('takes Vulkan when the loader sees a device with enough memory', () => {
    expect(
      selectDiffusionBackend(
        host({
          os: 'linux',
          features: { vulkan: true, cuda12: true },
          gpus: [{ vendor: 'NVIDIA', totalMemoryMib: LINUX_VULKAN_MIN_VRAM_MIB }],
        })
      )
    ).toBe('linux-vulkan-x64')
  })

  it('stays on the CPU build when every device is too small', () => {
    expect(
      selectDiffusionBackend(
        host({
          os: 'linux',
          features: { vulkan: true },
          gpus: [{ totalMemoryMib: LINUX_VULKAN_MIN_VRAM_MIB - 1 }],
        })
      )
    ).toBe('linux-cpu-x64')
  })

  it('ignores CUDA on Linux: there is no prebuilt for it', () => {
    expect(
      selectDiffusionBackend(
        host({
          os: 'linux',
          features: { cuda12: true },
          gpus: [{ totalMemoryMib: 24 * 1024 }],
        })
      )
    ).toBe('linux-cpu-x64')
  })

  it('takes the CUDA 13 build on a DGX Spark', () => {
    expect(
      selectDiffusionBackend(
        host({
          os: 'linux',
          arch: 'arm64',
          features: { cuda12: true, cuda13: true, vulkan: true },
          gpus: [{ vendor: 'NVIDIA', totalMemoryMib: 0 }],
          available: WITH_ARM64,
        })
      )
    ).toBe('linux-cuda13-arm64')
  })

  it('runs the arm64 CPU build on arm64 Linux without CUDA 13', () => {
    expect(
      selectDiffusionBackend(
        host({
          os: 'linux',
          arch: 'arm64',
          features: { vulkan: true },
          gpus: [{ totalMemoryMib: 8192 }],
          available: WITH_ARM64,
        })
      )
    ).toBe('linux-cpu-arm64')
  })

  it('has nothing for arm64 Linux on a manifest without arm64 builds', () => {
    expect(
      selectDiffusionBackend(host({ os: 'linux', arch: 'arm64', features: { cuda13: true } }))
    ).toBeNull()
  })

  it('stays on the CPU build when the manifest lacks the Vulkan asset', () => {
    expect(
      selectDiffusionBackend(
        host({
          os: 'linux',
          features: { vulkan: true },
          gpus: [{ totalMemoryMib: 8192 }],
          available: ['linux-cpu-x64'],
        })
      )
    ).toBe('linux-cpu-x64')
  })
})

describe('companionFor', () => {
  it('pairs the Windows CUDA build with the cudart archive', () => {
    expect(companionFor('win-cuda12-x64')).toBe('win-cudart-cu12')
  })

  it('needs nothing for every other build, arm64 CUDA included', () => {
    for (const id of WITH_ARM64.filter((id) => id !== 'win-cuda12-x64')) {
      expect(companionFor(id)).toBeNull()
    }
  })
})

describe('backendKindOf', () => {
  it('names the compute backend from the manifest id', () => {
    expect(backendKindOf('macos-arm64')).toBe('metal')
    expect(backendKindOf('win-cuda12-x64')).toBe('cuda')
    expect(backendKindOf('linux-rocm-7.14-x64')).toBe('rocm')
    expect(backendKindOf('win-vulkan-x64')).toBe('vulkan')
    expect(backendKindOf('linux-cpu-x64')).toBe('cpu')
    expect(backendKindOf('win-cuda13-arm64')).toBe('cuda')
    expect(backendKindOf('linux-cuda13-arm64')).toBe('cuda')
    expect(backendKindOf('win-cpu-arm64')).toBe('cpu')
    expect(backendKindOf('linux-cpu-arm64')).toBe('cpu')
  })
})

// --- core additions: the host from the core's own hardware facts, failed rungs, MLX ---------------

const nvidia = (driver: string, memory = 8192) => ({
  name: 'RTX',
  vendor: 'NVIDIA',
  total_memory: memory,
  uuid: 'gpu-0',
  driver_version: driver,
  nvidia_info: { index: 0, compute_capability: '8.6' },
  vulkan_info: null,
})

const choose = (h: ReturnType<typeof sdcppHostOf>) =>
  sdcppHostChoice(
    h,
    { tag_name: 'master-1-aaaaaaa', assets: MANIFEST_IDS.map((backend) => ({ backend })) },
    new Set()
  ).backend_id

describe('sdcppHostOf', () => {
  it('reads the CUDA tiers from the same feature probe the llama.cpp providers use', () => {
    const host = sdcppHostOf({
      osType: 'windows',
      arch: 'x86_64',
      cpuExtensions: [],
      gpus: [nvidia('560.94')],
    })
    expect(host).toMatchObject({ os: 'windows', arch: 'x64', features: { cuda12: true } })
    expect(choose(host)).toBe('win-cuda12-x64')
  })

  it('carries each card memory for the Linux Vulkan floor', () => {
    const vulkan = { ...nvidia('', 1024), nvidia_info: null, vulkan_info: { device_id: 1 } }
    const small = sdcppHostOf({ osType: 'linux', arch: 'x86_64', cpuExtensions: [], gpus: [vulkan as never] })
    expect(choose(small)).toBe('linux-cpu-x64')
    const big = sdcppHostOf({
      osType: 'linux',
      arch: 'x86_64',
      cpuExtensions: [],
      gpus: [{ ...vulkan, total_memory: 4096 } as never],
    })
    expect(choose(big)).toBe('linux-vulkan-x64')
  })

  it('maps aarch64 and arm64 to arm64, anything else to x64', () => {
    expect(sdcppHostOf({ osType: 'linux', arch: 'aarch64', cpuExtensions: [], gpus: [] }).arch).toBe('arm64')
    expect(sdcppHostOf({ osType: 'macos', arch: 'arm64', cpuExtensions: [], gpus: [] }).arch).toBe('arm64')
    expect(sdcppHostOf({ osType: 'macos', arch: 'x86_64', cpuExtensions: [], gpus: [] }).arch).toBe('x64')
  })
})

describe('sdcppHostChoice', () => {
  const manifest = {
    tag_name: 'master-883-137f740-a36f1b1a',
    assets: [...MANIFEST_IDS, ...ARM64_IDS].map((backend) => ({
      backend,
      name: `${backend}.zip`,
      ...(backend === 'win-cudart-cu12' ? { companion: true } : {}),
    })),
  }
  const amd = host({ features: { rocm: true, vulkan: true } })

  it('offers the top of the ladder, companions never', () => {
    expect(sdcppHostChoice(amd, manifest, new Set())).toEqual({
      ladder: ['win-rocm-7.14-x64', 'win-vulkan-x64', 'win-cpu-x64'],
      backend_id: 'win-rocm-7.14-x64',
      reason: null,
    })
  })

  it('skips a build that failed its probe on this tag, and only on this tag', () => {
    const failed = new Set(['master-883-137f740-a36f1b1a/win-rocm-7.14-x64'])
    expect(sdcppHostChoice(amd, manifest, failed).ladder).toEqual(['win-vulkan-x64', 'win-cpu-x64'])
    const older = new Set(['master-882-aaaaaaa/win-rocm-7.14-x64'])
    expect(sdcppHostChoice(amd, manifest, older).backend_id).toBe('win-rocm-7.14-x64')
  })

  it('offers the last build again once every build failed, so a retry ends on its own error', () => {
    const failed = new Set(
      ['win-rocm-7.14-x64', 'win-vulkan-x64', 'win-cpu-x64'].map((id) => `${manifest.tag_name}/${id}`)
    )
    expect(sdcppHostChoice(amd, manifest, failed)).toMatchObject({
      ladder: ['win-cpu-x64'],
      backend_id: 'win-cpu-x64',
    })
  })

  it('says why there is nothing', () => {
    expect(sdcppHostChoice(host({ os: 'macos', arch: 'x64' }), manifest, new Set())).toEqual({
      ladder: [],
      backend_id: null,
      reason: expect.stringMatching(/Apple Silicon/),
    })
    const noArm = { ...manifest, assets: manifest.assets.filter((a) => !a.backend.endsWith('-arm64')) }
    expect(sdcppHostChoice(host({ os: 'linux', arch: 'arm64' }), noArm, new Set()).reason).toMatch(
      /arm64 linux/
    )
    expect(
      sdcppHostChoice(host({}), { ...manifest, assets: [{ backend: 'macos-arm64' }] }, new Set()).reason
    ).toMatch(/no build for this computer/)
  })
})

describe('failed backends on disk', () => {
  it('remembers the last sixteen <tag>/<backend_id> pairs and survives a missing or broken file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-failed-backends-'))
    try {
      const file = join(dir, 'diffusion', 'failed-backends.json')
      expect(await readFailedBackends(file)).toEqual(new Set())
      for (let i = 0; i < 20; i++)
        await rememberFailedBackend(file, `master-${i}-aaaaaaa`, 'win-rocm-7.14-x64')
      await rememberFailedBackend(file, 'master-5-aaaaaaa', 'win-rocm-7.14-x64')
      const failed = await readFailedBackends(file)
      expect(failed.size).toBe(16)
      expect(failed.has('master-3-aaaaaaa/win-rocm-7.14-x64')).toBe(false)
      expect([...failed].at(-1)).toBe('master-5-aaaaaaa/win-rocm-7.14-x64')
      await writeFile(file, 'not json')
      expect(await readFailedBackends(file)).toEqual(new Set())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('mlxHostChoice', () => {
  const manifest = { assets: [{ backend: 'macos-arm64', name: 'mlx.tar.gz' }] }

  it('has the one build on Apple Silicon only', () => {
    expect(mlxHostChoice({ os: 'macos', arch: 'arm64' }, manifest)).toEqual({
      backend_id: 'macos-arm64',
      reason: null,
    })
    expect(mlxHostChoice({ os: 'macos', arch: 'x64' }, manifest)).toEqual({
      backend_id: null,
      reason: expect.stringMatching(/Apple Silicon/),
    })
    expect(mlxHostChoice({ os: 'windows', arch: 'x64' }, manifest).backend_id).toBeNull()
    expect(mlxHostChoice({ os: 'macos', arch: 'arm64' }, { assets: [] }).reason).toMatch(/no build/)
  })

  it('without a manifest still says whether the platform could run MLX', () => {
    expect(mlxHostChoice({ os: 'macos', arch: 'arm64' }, null)).toEqual({
      backend_id: 'macos-arm64',
      reason: null,
    })
    expect(mlxHostChoice({ os: 'linux', arch: 'x64' }, null).backend_id).toBeNull()
  })
})
