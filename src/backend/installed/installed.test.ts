import { describe, expect, it, vi } from 'vitest'
import { dataLayout } from '../../config/index.js'
import { AtomicCoreError } from '../../contracts/index.js'
import {
  backendExePathCandidates,
  backendTypeEquivalents,
  cudaRuntimeLibName,
  deletableBackendPack,
  findCompatibleInstalledBackend,
  getBackendDir,
  getBackendExePath,
  installedBackendsFromEntries,
  isBackendInstalled,
  isCudaInstalled,
  listInstalledBackendPacks,
  mergeBackendOptions,
} from './installed.js'
import type { CudaLibFs } from './installed.js'

const paths = dataLayout('/path/to/jan').provider('llamacpp-upstream')
const existsAmong = (present: string[]) => async (p: string) => present.includes(p)

describe('installedBackendsFromEntries (Rust get_local_installed_backends order semantics)', () => {
  it('keeps only directories with an executable, cleans names and floors the mtime', () => {
    expect(
      installedBackendsFromEntries([
        { version: '\uFEFFb7523 ', backend: ' backend-a', hasExe: true, mtimeSeconds: 1_800_000_000.9 },
        { version: 'b7523', backend: 'backend-empty', hasExe: false, mtimeSeconds: 1 },
        { version: 'custom', backend: 'macos-arm64', hasExe: true },
        { version: 'neg', backend: 'x', hasExe: true, mtimeSeconds: -5 },
      ])
    ).toEqual([
      { version: 'b7523', backend: 'backend-a', order: 1_800_000_000 },
      { version: 'custom', backend: 'macos-arm64', order: 0 },
      { version: 'neg', backend: 'x', order: 0 },
    ])
  })
  it('orders a newer directory above an older one', () => {
    const [old, fresh] = installedBackendsFromEntries([
      { version: 'old', backend: 'macos-arm64', hasExe: true, mtimeSeconds: 100 },
      { version: 'new', backend: 'macos-arm64', hasExe: true, mtimeSeconds: 102 },
    ])
    expect(fresh!.order!).toBeGreaterThan(old!.order!)
  })
})

describe('getBackendDir / getBackendExePath / isBackendInstalled (app backend.test.ts)', () => {
  it('uses the specific backend name for the directory path', () => {
    expect(getBackendDir(paths, 'linux-avx2-x64', 'v1.2.3')).toBe(
      '/path/to/jan/llamacpp-upstream/backends/v1.2.3/linux-avx2-x64'
    )
    expect(getBackendDir(paths, '\uFEFFwin-common_cpus-x64', 'v2.0.0 ')).toBe(
      '/path/to/jan/llamacpp-upstream/backends/v2.0.0/win-common_cpus-x64'
    )
  })
  it('lists both layouts per platform', () => {
    expect(backendExePathCandidates(paths, 'win-cpu-x64', 'b1', 'win32')).toEqual([
      '/path/to/jan/llamacpp-upstream/backends/b1/win-cpu-x64/build/bin/llama-server.exe',
      '/path/to/jan/llamacpp-upstream/backends/b1/win-cpu-x64/llama-server.exe',
    ])
  })
  it('prefers build/bin when the build directory exists, else the flat layout', async () => {
    const dir = '/path/to/jan/llamacpp-upstream/backends/v1.2.3/linux-avx2-x64'
    expect(
      await getBackendExePath(paths, 'linux-avx2-x64', 'v1.2.3', 'linux', existsAmong([`${dir}/build`]))
    ).toBe(`${dir}/build/bin/llama-server`)
    expect(await getBackendExePath(paths, 'linux-avx2-x64', 'v1.2.3', 'linux', existsAmong([]))).toBe(
      `${dir}/llama-server`
    )
  })
  it('is installed when either candidate executable exists', async () => {
    const dir = '/path/to/jan/llamacpp-upstream/backends/v1.0.0/win-avx2-x64'
    expect(
      await isBackendInstalled(
        paths,
        'win-avx2-x64',
        'v1.0.0',
        'darwin',
        existsAmong([`${dir}/build/bin/llama-server`])
      )
    ).toBe(true)
    expect(
      await isBackendInstalled(
        paths,
        'win-avx2-x64',
        'v1.0.0',
        'darwin',
        existsAmong([`${dir}/llama-server`])
      )
    ).toBe(true)
    expect(
      await isBackendInstalled(paths, 'win-avx2-x64', 'v1.0.0', 'darwin', existsAmong([`${dir}/build`]))
    ).toBe(false)
  })
})

describe('installed engine packs (app backend.test.ts)', () => {
  const installed = [
    { version: 'b10205', backend: 'win-cpu-x64' },
    { version: 'b10344', backend: 'win-cpu-x64' },
  ]
  it('resolves each pack path and marks the selected build', () => {
    expect(listInstalledBackendPacks(paths, installed, 'b10344/win-cpu-x64')).toEqual([
      {
        version: 'b10205',
        backend: 'win-cpu-x64',
        path: '/path/to/jan/llamacpp-upstream/backends/b10205/win-cpu-x64',
        active: false,
      },
      {
        version: 'b10344',
        backend: 'win-cpu-x64',
        path: '/path/to/jan/llamacpp-upstream/backends/b10344/win-cpu-x64',
        active: true,
      },
    ])
  })
  it('validates a deletable pack', () => {
    expect(deletableBackendPack('b10344/win-cpu-x64', '\uFEFFb10205', 'win-cpu-x64')).toEqual({
      version: 'b10205',
      backend: 'win-cpu-x64',
    })
  })
  it('refuses to remove the build currently in use', () => {
    expect(() => deletableBackendPack('b10344/win-cpu-x64', 'b10344', 'win-cpu-x64')).toThrow(
      /currently selected/
    )
  })
  it.each([
    ['../../models', 'win-cpu-x64'],
    ['b10205', 'a\\b'],
    ['', 'win-cpu-x64'],
    ['b10205', '\uFEFF'],
    ['..', 'win-cpu-x64'],
    ['b10205', '.'],
  ])('rejects the pack id %j/%j', (version, backend) => {
    expect(() => deletableBackendPack('b10344/win-cpu-x64', version, backend)).toThrow(AtomicCoreError)
    expect(() => deletableBackendPack('b10344/win-cpu-x64', version, backend)).toThrow(/Invalid backend pack/)
  })
})

describe('backendTypeEquivalents / findCompatibleInstalledBackend', () => {
  it('pairs linux-* with ubuntu-* in both directions', () => {
    expect([...backendTypeEquivalents('linux-vulkan-x64')]).toEqual(['linux-vulkan-x64', 'ubuntu-vulkan-x64'])
    expect([...backendTypeEquivalents('ubuntu-x64')]).toEqual(['ubuntu-x64', 'linux-cpu-x64'])
    expect([...backendTypeEquivalents('win-cpu-x64')]).toEqual(['win-cpu-x64'])
  })
  it('returns the newest same-type build by install order, never crossing types', () => {
    const installed = [
      { version: 'b1', backend: 'ubuntu-vulkan-x64', order: 5 },
      { version: 'b2', backend: 'linux-vulkan-x64', order: 9 },
      { version: 'b3', backend: 'linux-cpu-x64', order: 99 },
    ]
    expect(findCompatibleInstalledBackend('linux-vulkan-x64', installed)).toEqual({
      version: 'b2',
      backend: 'linux-vulkan-x64',
      order: 9,
    })
    expect(findCompatibleInstalledBackend('win-cuda-13.3-x64', installed)).toBeNull()
  })
})

describe('mergeBackendOptions (app backend.test.ts)', () => {
  const latest = [{ value: 'latest/win-cpu-x64', name: 'Latest (CPU)' }]
  const catalog = [
    { value: 'b10344/win-cpu-x64', name: 'b10344/win-cpu-x64' },
    { value: 'b10205/win-cpu-x64', name: 'b10205/win-cpu-x64' },
  ]
  it('keeps every tier so a downloadable release is selectable next to the installed one', () => {
    const installed = [{ value: 'b10205/win-cpu-x64', name: 'b10205/win-cpu-x64' }]
    expect(mergeBackendOptions([latest, catalog, installed]).map((o) => o.value)).toEqual([
      'latest/win-cpu-x64',
      'b10344/win-cpu-x64',
      'b10205/win-cpu-x64',
    ])
  })
  it('keeps a side-loaded build that the catalog no longer offers', () => {
    const installed = [{ value: 'b9222/win-cpu-x64', name: 'b9222/win-cpu-x64' }]
    expect(mergeBackendOptions([catalog, installed]).map((o) => o.value)).toContain('b9222/win-cpu-x64')
  })
  it('prefers the label of the earliest tier for a duplicated build', () => {
    const installed = [{ value: 'b10344/win-cpu-x64', name: 'raw fallback label' }]
    expect(mergeBackendOptions([catalog, installed]).filter((o) => o.value === 'b10344/win-cpu-x64')).toEqual(
      [{ value: 'b10344/win-cpu-x64', name: 'b10344/win-cpu-x64' }]
    )
  })
  it('forces a recommendation the tiers missed into the list, without duplicating a present one', () => {
    expect(
      mergeBackendOptions([catalog], { value: 'b10400/win-cuda-13-x64', name: 'b10400/win-cuda-13-x64' })[0]
    ).toEqual({
      value: 'b10400/win-cuda-13-x64',
      name: 'b10400/win-cuda-13-x64',
    })
    expect(
      mergeBackendOptions([catalog], { value: 'b10344/win-cpu-x64', name: 'duplicate' }).map((o) => o.value)
    ).toEqual(['b10344/win-cpu-x64', 'b10205/win-cpu-x64'])
  })
  it('drops blank ids and the BOM a manifest read can leave behind', () => {
    expect(
      mergeBackendOptions([
        [
          { value: '   ', name: 'blank' },
          { value: '\uFEFFb10344/win-cpu-x64', name: 'bom' },
          { value: 'b10344/win-cpu-x64', name: 'clean' },
        ],
      ])
    ).toEqual([{ value: 'b10344/win-cpu-x64', name: 'bom' }])
  })
})

describe('cudaRuntimeLibName / isCudaInstalled (Rust test_is_cuda_installed_*)', () => {
  it.each([
    ['windows', '11.7', 'cudart64_110.dll'],
    ['windows', '12.4', 'cudart64_12.dll'],
    ['windows', '13.3', 'cudart64_13.dll'],
    ['linux', '11.0', 'libcudart.so.11.0'],
    ['linux', '12', 'libcudart.so.12'],
    ['linux', '13.1', 'libcudart.so.13'],
    ['macos', '12.4', null],
    ['windows', '10.2', null],
    ['windows', 'x', null],
  ])('cudaRuntimeLibName(%j, %j) = %j', (os, version, expected) => {
    expect(cudaRuntimeLibName(os, version)).toBe(expected)
  })

  const fakeFs = (
    present: Set<string>
  ): CudaLibFs & { renames: Array<[string, string]>; mkdirs: string[] } => {
    const renames: Array<[string, string]> = []
    const mkdirs: string[] = []
    return {
      renames,
      mkdirs,
      exists: async (p) => present.has(p),
      mkdir: async (p) => {
        mkdirs.push(p)
        present.add(p)
      },
      rename: async (from, to) => {
        renames.push([from, to])
        present.delete(from)
        present.add(to)
      },
    }
  }
  const base = { backendDir: '/backend', legacyLibDir: '/data/llamacpp/lib' }

  it('migrates the legacy library into build/bin', async () => {
    const present = new Set(['/data/llamacpp/lib/libcudart.so.12'])
    const fs = fakeFs(present)
    expect(await isCudaInstalled({ ...base, version: '12.0', osType: 'linux', fs })).toBe(true)
    expect(fs.mkdirs).toEqual(['/backend/build/bin'])
    expect(fs.renames).toEqual([['/data/llamacpp/lib/libcudart.so.12', '/backend/build/bin/libcudart.so.12']])
    expect(present.has('/data/llamacpp/lib/libcudart.so.12')).toBe(false)
  })
  it('is true when the library already sits in build/bin, without touching anything', async () => {
    const fs = fakeFs(new Set(['/backend/build/bin/cudart64_110.dll']))
    expect(await isCudaInstalled({ ...base, version: '11.7', osType: 'windows', fs })).toBe(true)
    expect(fs.renames).toEqual([])
  })
  it('is false for an unknown os/major or when nothing is on disk', async () => {
    expect(await isCudaInstalled({ ...base, version: '12.0', osType: 'macos', fs: fakeFs(new Set()) })).toBe(
      false
    )
    expect(await isCudaInstalled({ ...base, version: '12.0', osType: 'linux', fs: fakeFs(new Set()) })).toBe(
      false
    )
  })
  it('is false when the move fails and IO_ERROR when the target directory cannot be created', async () => {
    const failingRename: CudaLibFs = {
      exists: async (p) => p === '/data/llamacpp/lib/libcudart.so.12' || p === '/backend/build/bin',
      mkdir: vi.fn(),
      rename: async () => {
        throw new Error('EXDEV')
      },
    }
    expect(await isCudaInstalled({ ...base, version: '12.0', osType: 'linux', fs: failingRename })).toBe(
      false
    )
    const failingMkdir: CudaLibFs = {
      exists: async (p) => p === '/data/llamacpp/lib/libcudart.so.12',
      mkdir: async () => {
        throw new Error('EACCES')
      },
      rename: vi.fn(),
    }
    await expect(
      isCudaInstalled({ ...base, version: '12.0', osType: 'linux', fs: failingMkdir })
    ).rejects.toMatchObject({
      code: 'IO_ERROR',
    })
  })
})
