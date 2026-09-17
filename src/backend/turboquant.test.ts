import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { storedZip } from '../../test/helpers/backend-install-e2e.js'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { BackendVersion, GpuProbeInfo } from './types.js'
import {
  compareTurboquantBackendsForSort,
  copyBackendDlls,
  determineBestTurboquantBackend,
  determineTurboquantSupportedBackends,
  ensureTurboquantCudart,
  ensureUpstreamCudart,
  filterTurboquantBackendsBySupport,
  findUpstreamCudaDonor,
  getTurboquantBackendCategory,
  getTurboquantSupportedFeatures,
  isStableReleaseTag,
  isTurboQuantRelease,
  mapOldTurboquantBackendToNew,
  prioritizeTurboquantBackends,
  probeLinuxRocmHost,
  readTurboquantIndexedAsset,
  rocmSupportedLinux,
  turboquantArchiveUrl,
  turboquantCudaToolkit,
  turboquantCudartArchiveName,
  turboquantCudartUrl,
  turboquantDefaultAssetName,
  unifiedReleaseRank,
} from './turboquant.js'

const none = { cuda11: false, cuda12: false, cuda13: false, vulkan: false, rocm: false }
const latest = (backends: BackendVersion[], type: string) => {
  const matching = backends.filter((b) => mapOldTurboquantBackendToNew(b.backend) === type)
  const best = [...matching].sort(compareTurboquantBackendsForSort)[0]
  return best ? `${best.version}/${best.backend}` : undefined
}

describe('release tags', () => {
  it('tells fork builds, stable releases and ranks apart', () => {
    expect(isTurboQuantRelease('b10018-1.3.0/macos-arm64')).toBe(true)
    expect(isTurboQuantRelease('turboquant-linux-x64-vulkan-d86eb0b')).toBe(true)
    expect(isTurboQuantRelease('b8149')).toBe(false)
    expect(isStableReleaseTag('﻿b10018-1.3.0/linux-x64-cpu')).toBe(true)
    expect(isStableReleaseTag('turboquant-x-sha')).toBe(false)
    expect(isStableReleaseTag('dev-latest')).toBe(false)
    expect(unifiedReleaseRank('b10018-1.3.0')).toEqual([10018, 1, 3, 0])
    for (const bad of ['10018-1.3.0', 'b10018', 'b10018-1.3', 'b10018-1.3.0.1', 'bx-1.3.0', 'b1-1.x.0'])
      expect(unifiedReleaseRank(bad)).toBeUndefined()
  })

  it('prefers the newest unified release over install order and any legacy tag (Rust find_latest_version tests)', () => {
    expect(
      latest(
        [
          { version: 'b10018-1.3.0', backend: 'linux-x64-rocm', order: 1 },
          { version: 'b10018-1.2.9', backend: 'linux-x64-rocm', order: 9 },
          { version: 'b9900-1.4.0', backend: 'linux-x64-rocm', order: 8 },
        ],
        'linux-x64-rocm'
      )
    ).toBe('b10018-1.3.0/linux-x64-rocm')
    expect(
      latest(
        [
          { version: 'turboquant-linux-x64-vulkan-bbbb', backend: 'linux-x64-vulkan', order: 99 },
          { version: 'b10018-1.3.0', backend: 'linux-x64-vulkan', order: 1 },
        ],
        'linux-x64-vulkan'
      )
    ).toBe('b10018-1.3.0/linux-x64-vulkan')
    expect(
      latest(
        [
          { version: 'turboquant-linux-x64-vulkan-aaaa', backend: 'linux-avx2-x64', order: 1 },
          { version: 'turboquant-linux-x64-vulkan-bbbb', backend: 'linux-x64-vulkan', order: 2 },
          { version: 'turboquant-linux-x64-vulkan-cccc', backend: 'linux-x64-vulkan', order: 0 },
        ],
        'linux-x64-vulkan'
      )
    ).toBe('turboquant-linux-x64-vulkan-bbbb/linux-x64-vulkan')
    expect(
      latest(
        [
          { version: 'b7524', backend: 'windows-x64-cuda-12.4', order: 1_800_000_000 },
          { version: 'b7525', backend: 'windows-x64-cuda-12.4', order: 0 },
        ],
        'windows-x64-cuda-12.4'
      )
    ).toBe('b7525/windows-x64-cuda-12.4')
    const same = [
      { version: 'b1', backend: 'b', order: 1 },
      { version: 'b1', backend: 'a', order: 1 },
      { version: 'b2', backend: 'a', order: 1 },
    ].sort(compareTurboquantBackendsForSort)
    expect(same.map((b) => `${b.version}/${b.backend}`)).toEqual(['b2/a', 'b1/a', 'b1/b'])
  })
})

describe('backend ids and the hardware matrix', () => {
  it.each([
    ['linux-avx2-cuda-cu12.0-x64', 'linux-x64-vulkan'],
    ['win-noavx-cuda-cu11.7-x64', 'windows-x64-cpu'],
    ['win-cuda-12-common_cpus-x64', 'windows-x64-cuda-12.4'],
    ['win-cuda-13-common_cpus-x64', 'windows-x64-cuda-13.3'],
    ['windows-x64-cuda-12.4', 'windows-x64-cuda-12.4'],
    ['linux-vulkan-x64', 'linux-x64-vulkan'],
    ['win-vulkan-common_cpus-x64', 'windows-x64-vulkan'],
    ['win-avx512-x64', 'windows-x64-cpu'],
    ['linux-avx2-x64', 'linux-x64-vulkan'],
    ['linux-arm64', 'linux-arm64'],
    ['linux-aarch64-cpu', 'linux-aarch64-cpu'],
    ['﻿macos-arm64 ', 'macos-arm64'],
    ['ubuntu-x64', 'ubuntu-x64'],
  ])('maps %j to %j', (from, to) => expect(mapOldTurboquantBackendToNew(from)).toBe(to))

  it('publishes the fork matrix per platform (Rust determine_supported_backends tests)', () => {
    expect(
      determineTurboquantSupportedBackends('windows', 'x86_64', {
        ...none,
        cuda11: true,
        cuda12: true,
        vulkan: true,
      })
    ).toEqual(['windows-x64-cpu', 'windows-x64-cuda-12.4', 'windows-x64-vulkan'])
    expect(
      determineTurboquantSupportedBackends('linux', 'x86_64', {
        cuda11: true,
        cuda12: true,
        cuda13: true,
        vulkan: true,
        rocm: true,
      })
    ).toEqual([
      'linux-x64-cpu',
      'linux-x64-cuda-12.4',
      'linux-x64-cuda-13.3',
      'linux-x64-rocm',
      'linux-x64-vulkan',
    ])
    expect(determineTurboquantSupportedBackends('linux', 'x86', none)).toEqual([
      'linux-x64-cpu',
      'linux-x64-vulkan',
    ])
    expect(determineTurboquantSupportedBackends('linux', 'aarch64', { ...none, cuda13: true })).toEqual([
      'linux-arm64-cuda-13.3',
    ])
    expect(determineTurboquantSupportedBackends('linux', 'arm64', { ...none, vulkan: true })).toEqual([])
    expect(determineTurboquantSupportedBackends('windows', 'arm64', none)).toEqual(['windows-arm64'])
    expect(determineTurboquantSupportedBackends('macos', 'arm64', none)).toEqual(['macos-arm64'])
    expect(determineTurboquantSupportedBackends('macos', 'x86_64', none)).toEqual(['macos-x64'])
    expect(() => determineTurboquantSupportedBackends('freebsd', 'x86_64', none)).toThrow(
      'Unsupported system type: freebsd-x86_64'
    )
  })

  it('keeps installed packs whose id maps onto a supported one, on every OS', () => {
    const installed = [
      { version: 'b1-1.0.0', backend: 'windows-x64-cpu' },
      { version: 'b1-1.0.0', backend: 'windows-x64-cuda-13.3' },
      { version: 'old', backend: 'win-avx2-x64' },
    ]
    expect(filterTurboquantBackendsBySupport(installed, ['windows-x64-cpu']).map((b) => b.backend)).toEqual([
      'windows-x64-cpu',
      'win-avx2-x64',
    ])
  })
})

describe('features', () => {
  const nvidia = (driver: string, cc = '8.6', memory = 8192): GpuProbeInfo => ({
    driver_version: driver,
    vendor: 'NVIDIA',
    total_memory: memory,
    nvidia_info: { compute_capability: cc },
    vulkan_info: { device_type: 'DiscreteGpu' },
  })
  const amd: GpuProbeInfo = {
    vendor: 'AMD',
    total_memory: 16384,
    vulkan_info: { device_type: 'DiscreteGpu' },
  }

  it('uses the fork Windows CUDA 12 floor and the CUDA 13 architecture veto', () => {
    expect(getTurboquantSupportedFeatures('windows', ['avx', 'avx2'], [nvidia('527.41')])).toMatchObject({
      avx: true,
      avx2: true,
      avx512: false,
      cuda11: true,
      cuda12: true,
      cuda13: false,
      vulkan: true,
      rocm: false,
    })
    expect(getTurboquantSupportedFeatures('windows', [], [nvidia('590.1', '7.0')]).cuda13).toBe(false)
    expect(
      getTurboquantSupportedFeatures('linux', [], [nvidia('580.0', '7.5'), nvidia('580.0', '')]).cuda13
    ).toBe(true)
    expect(getTurboquantSupportedFeatures('macos', ['avx512'], [nvidia('999')])).toMatchObject({
      avx512: true,
      cuda12: false,
    })
  })

  it('offers ROCm on Linux only with an AMD card of a built architecture and a HIP runtime', () => {
    const probe = { gfxTargetVersions: [110000], hasRuntime: true }
    expect(getTurboquantSupportedFeatures('linux', [], [amd], probe).rocm).toBe(true)
    expect(getTurboquantSupportedFeatures('windows', [], [amd], probe).rocm).toBe(false)
    expect(rocmSupportedLinux(true, { gfxTargetVersions: [90000], hasRuntime: true })).toBe(false)
    expect(rocmSupportedLinux(true, { gfxTargetVersions: [120100], hasRuntime: false })).toBe(false)
    expect(rocmSupportedLinux(false, probe)).toBe(false)
  })

  it('reads amdkfd architectures and the HIP library from the host', async () => {
    const files: Record<string, string> = {
      '/sys/class/kfd/kfd/topology/nodes/0/properties': 'cpu_cores_count 16\ngfx_target_version 0\n',
      '/sys/class/kfd/kfd/topology/nodes/1/properties': 'gfx_target_version 110000\nother 1\n',
    }
    const dirs: Record<string, string[]> = {
      '/sys/class/kfd/kfd/topology/nodes': ['0', '1', '2'],
      '/opt': ['rocm-6.2.0', 'x'],
    }
    const fs = (present: string[]) => ({
      readdir: async (path: string) => {
        const entries = dirs[path]
        if (!entries) throw new Error('ENOENT')
        return entries
      },
      readFile: async (path: string) => {
        const text = files[path]
        if (text === undefined) throw new Error('ENOENT')
        return text
      },
      exists: async (path: string) => present.includes(path),
    })
    expect(await probeLinuxRocmHost(fs(['/opt/rocm-6.2.0/lib64/libamdhip64.so']))).toEqual({
      gfxTargetVersions: [110000],
      hasRuntime: true,
    })
    expect((await probeLinuxRocmHost(fs(['/usr/lib/libamdhip64.so']))).hasRuntime).toBe(true)
    expect((await probeLinuxRocmHost(fs([]))).hasRuntime).toBe(false)
    expect(await probeLinuxRocmHost()).toMatchObject({ gfxTargetVersions: expect.any(Array) })
  })
})

describe('categories and priority', () => {
  it.each([
    ['windows-x64-cuda-13.3', 'cuda-cu13.0'],
    ['linux-x64-cuda-12.4', 'cuda-cu12.0'],
    ['win-cuda-11-common_cpus-x64', 'cuda-cu11.7'],
    ['linux-x64-rocm', 'rocm'],
    ['linux-x64-vulkan', 'vulkan'],
    ['windows-x64-cpu', 'common_cpus'],
    ['win-avx512-x64', 'avx512'],
    ['win-avx2-x64', 'avx2'],
    ['win-avx-x64', 'avx'],
    ['macos-arm64', 'arm64'],
    ['macos-x64', 'x64'],
    ['something', null],
  ])('%j is %j', (backend, category) => expect(getTurboquantBackendCategory(backend)).toBe(category))

  it('puts GPU builds ahead of CPU only with 6 GiB of VRAM', () => {
    const installed = [
      { version: 'b1-1.0.0', backend: 'linux-x64-cpu' },
      { version: 'b1-1.0.0', backend: 'linux-x64-vulkan' },
      { version: 'b2-1.0.0', backend: 'linux-x64-vulkan' },
    ]
    expect(determineBestTurboquantBackend(installed, [{ total_memory: 6 * 1024 }])).toBe(
      'b2-1.0.0/linux-x64-vulkan'
    )
    expect(determineBestTurboquantBackend(installed, [{ total_memory: 4 * 1024 }])).toBe(
      'b1-1.0.0/linux-x64-cpu'
    )
    expect(determineBestTurboquantBackend([], [])).toBe('')
    expect(prioritizeTurboquantBackends([{ version: 'v', backend: 'odd' }], true)).toBe('v/odd')
    expect(() => prioritizeTurboquantBackends([], true)).toThrow('No backends available')
  })
})

describe('archives', () => {
  let data: TmpDataFolder
  beforeEach(async () => {
    data = await makeTmpDataFolder('atomic-core-tq-')
  })
  afterEach(() => data.cleanup())

  it('names the fork asset by id prefix, then by host OS', () => {
    expect(turboquantDefaultAssetName('windows-x64-cuda-12.4', 'linux')).toBe(
      'llama-turboquant-windows-x64-cuda-12.4.zip'
    )
    expect(turboquantDefaultAssetName('win-avx2-x64', 'darwin')).toBe('llama-turboquant-win-avx2-x64.zip')
    expect(turboquantDefaultAssetName('macos-arm64', 'win32')).toBe('llama-turboquant-macos-arm64.tar.gz')
    expect(turboquantDefaultAssetName('odd', 'win32')).toBe('llama-turboquant-odd.zip')
    expect(turboquantDefaultAssetName('odd', 'linux')).toBe('llama-turboquant-odd.tar.gz')
    expect(turboquantArchiveUrl('﻿b10018-1.3.0', 'linux-x64-rocm', undefined, 'linux')).toBe(
      'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/download/b10018-1.3.0/llama-turboquant-linux-x64-rocm.tar.gz'
    )
    expect(turboquantArchiveUrl('b1-1.0.0', 'linux-x64-rocm', ' custom.tar.gz ')).toMatch(
      /\/b1-1\.0\.0\/custom\.tar\.gz$/
    )
  })

  it('reads the asset name from the release index the extension cached on disk', async () => {
    expect(await readTurboquantIndexedAsset(data.layout, 'b1-1.0.0', 'linux-x64-cpu')).toBeUndefined()
    await mkdir(join(data.root, 'llamacpp'), { recursive: true })
    await writeFile(
      join(data.root, 'llamacpp', 'release-index.cache.json'),
      JSON.stringify({
        fetched_at: 1,
        catalog: {
          releases: [
            { tag: 'b1-1.0.0', variants: [{ id: 'linux-x64-cpu', asset: 'named.tar.gz' }, { id: 'x' }] },
          ],
        },
      })
    )
    expect(await readTurboquantIndexedAsset(data.layout, 'b1-1.0.0', 'linux-x64-cpu')).toBe('named.tar.gz')
    expect(await readTurboquantIndexedAsset(data.layout, 'b1-1.0.0', 'x')).toBeUndefined()
  })

  it('names the Windows CUDA runtime companion at the pinned ggml-org tag', () => {
    expect(turboquantCudaToolkit('windows-x64-cuda-13.3')).toBe('13.3')
    expect(turboquantCudaToolkit('linux-x64-cuda-13.3')).toBeNull()
    expect(turboquantCudartArchiveName('windows-x64-vulkan')).toBeNull()
    expect(turboquantCudartUrl('windows-x64-cuda-12.4')).toBe(
      'https://github.com/ggml-org/llama.cpp/releases/download/b10205/cudart-llama-bin-win-cuda-12.4-x64.zip'
    )
    expect(turboquantCudartUrl('windows-x64-cuda-12.4', ' ')).toBeNull()
    expect(turboquantCudartUrl('windows-x64-cpu')).toBeNull()
  })

  it('copies only matching runtime DLLs and refuses a missing source', async () => {
    const src = join(data.root, 'src')
    await mkdir(join(src, 'nested.dll'), { recursive: true })
    for (const name of ['cudart64_12.dll', 'CUBLAS64_12.DLL', 'ggml.dll', 'cudart.txt'])
      await writeFile(join(src, name), 'x')
    expect(await copyBackendDlls(src, join(data.root, 'dst'), ['cudart', 'cublas'])).toBe(2)
    expect((await readdir(join(data.root, 'dst'))).sort()).toEqual(['CUBLAS64_12.DLL', 'cudart64_12.dll'])
    await expect(
      copyBackendDlls(join(data.root, 'none'), join(data.root, 'dst'), ['x'])
    ).rejects.toMatchObject({ code: 'IO_ERROR' })
  })

  it('repairs a Windows CUDA pack: present, copied from an upstream pack, or downloaded', async () => {
    const pack = join(data.layout.provider('llamacpp').backendsDir, 'b1-1.0.0', 'windows-x64-cuda-12.4')
    const bin = join(pack, 'build', 'bin')
    const downloads: string[] = []
    const deps = {
      layout: data.layout,
      platform: 'win32' as const,
      downloader: {
        download: async (_task: string, items: Array<{ url: string; save_path: string }>) => {
          downloads.push(items[0]?.url ?? '')
          throw new Error('offline')
        },
      },
    }
    expect(
      await ensureTurboquantCudart('windows-x64-cuda-12.4', pack, 't', { ...deps, platform: 'darwin' })
    ).toBe('not-needed')
    expect(await ensureTurboquantCudart('windows-x64-vulkan', pack, 't', deps)).toBe('not-needed')
    await expect(ensureTurboquantCudart('windows-x64-cuda-12.4', pack, 't', deps)).rejects.toThrow('offline')
    expect(downloads).toEqual([
      'https://github.com/ggml-org/llama.cpp/releases/download/b10205/cudart-llama-bin-win-cuda-12.4-x64.zip',
    ])

    const donorBin = join(
      data.layout.provider('llamacpp-upstream').backendsDir,
      'b9000',
      'win-cuda-12.4-x64',
      'build',
      'bin'
    )
    await mkdir(donorBin, { recursive: true })
    await writeFile(join(donorBin, 'cudart64_12.dll'), 'x')
    expect(await findUpstreamCudaDonor(data.layout, '12.4')).toBe(donorBin)
    expect(await findUpstreamCudaDonor(data.layout, '9.0')).toBeUndefined()
    expect(await ensureTurboquantCudart('windows-x64-cuda-12.4', pack, 't', deps)).toBe('copied')
    expect(await readdir(bin)).toEqual(['cudart64_12.dll'])
    expect(await ensureTurboquantCudart('windows-x64-cuda-12.4', pack, 't', deps)).toBe('present')
  })

  it('repairs an already-installed upstream CUDA pack, including the legacy lib location', async () => {
    const pack = join(data.layout.provider('llamacpp-upstream').backendsDir, 'b10205', 'win-cuda-12.4-x64')
    const legacy = join(data.root, 'llamacpp', 'lib')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'cudart64_12.dll'), 'old')
    const downloads: string[] = []
    const deps = {
      layout: data.layout,
      platform: 'win32' as const,
      downloader: {
        download: async (_task: string, items: Array<{ url: string; save_path: string }>) => {
          downloads.push(items[0]!.url)
          await writeFile(items[0]!.save_path, storedZip('bin/cudart64_12.dll', Buffer.from('new')))
        },
      },
    }
    expect(await ensureUpstreamCudart('b10205', 'win-cuda-12.4-x64', pack, 't', deps)).toBe('present')
    expect(downloads).toHaveLength(0)
    const bin = join(pack, 'build', 'bin')
    expect(await readdir(bin)).toEqual(['cudart64_12.dll'])
    await rm(join(bin, 'cudart64_12.dll'))
    expect(await ensureUpstreamCudart('b10205', 'win-cuda-12.4-x64', pack, 't', deps)).toBe('downloaded')
    expect(downloads).toHaveLength(1)
    expect(await readdir(bin)).toEqual(['cudart64_12.dll'])
  })

  it('does not fetch for other platforms or backends, and rejects a companion without the required DLL', async () => {
    const pack = join(data.layout.provider('llamacpp-upstream').backendsDir, 'b10205', 'win-cuda-13.3-x64')
    const seen: Array<{ task: string; url: string; proxy?: unknown }> = []
    const deps = {
      layout: data.layout,
      platform: 'win32' as const,
      proxy: { url: 'http://proxy' },
      downloader: {
        download: async (task: string, items: Array<{ url: string; save_path: string; proxy?: unknown }>) => {
          seen.push({ task, url: items[0]!.url, proxy: items[0]!.proxy })
          await writeFile(items[0]!.save_path, storedZip('readme.txt', Buffer.from('no runtime')))
        },
      },
    }
    expect(
      await ensureUpstreamCudart('b10205', 'win-cuda-13.3-x64', pack, 't', { ...deps, platform: 'darwin' })
    ).toBe('not-needed')
    expect(await ensureUpstreamCudart('b10205', 'win-cpu-x64', pack, 't', deps)).toBe('not-needed')
    await expect(ensureUpstreamCudart('b10205', 'win-cuda-13.3-x64', pack, 't', deps)).rejects.toThrow(
      'did not contain cudart64_13.dll'
    )
    expect(seen).toEqual([
      {
        task: 't',
        url: 'https://github.com/ggml-org/llama.cpp/releases/download/b10205/cudart-llama-bin-win-cuda-13.3-x64.zip',
        proxy: { url: 'http://proxy' },
      },
    ])
    expect(await readdir(data.layout.provider('llamacpp-upstream').tmpDir)).toEqual([])
  })

  it('downloads the companion into the pack and cleans up, and refuses an archive with no DLLs', async () => {
    const pack = join(data.layout.provider('llamacpp').backendsDir, 'b1-1.0.0', 'windows-x64-cuda-13.3')
    let content = storedZip('bin/cudart64_13.dll', Buffer.from('runtime'))
    const deps = {
      layout: data.layout,
      platform: 'win32' as const,
      proxy: { url: 'http://proxy' },
      downloader: {
        download: async (_task: string, items: Array<{ save_path: string; proxy?: unknown }>) => {
          expect(items[0]?.proxy).toEqual({ url: 'http://proxy' })
          await writeFile(items[0]?.save_path as string, content)
        },
      },
    }
    expect(await ensureTurboquantCudart('windows-x64-cuda-13.3', pack, 't', deps)).toBe('downloaded')
    expect(await readdir(join(pack, 'build', 'bin'))).toEqual(['cudart64_13.dll'])
    expect(await readdir(data.layout.provider('llamacpp').tmpDir)).toEqual([])

    const other = join(data.layout.provider('llamacpp').backendsDir, 'b1-1.0.0', 'windows-x64-cuda-12.4')
    content = storedZip('readme.txt', Buffer.from('no dlls'))
    await expect(ensureTurboquantCudart('windows-x64-cuda-12.4', other, 't', deps)).rejects.toThrow(
      'contained no DLLs'
    )
  })
})
