import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cudaRuntimeZip, storedZipFiles } from '../../../test/helpers/backend-install-e2e.js'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { AtomicCoreError } from '../../contracts/index.js'
import type { DownloadItem } from '../../downloads/index.js'
import {
  NVIDIA_CUDA_REDIST_BASE,
  PINNED_WINDOWS_CUDA_RUNTIMES,
  cudaToolkitOfPack,
  deliverWindowsCudaRuntime,
  nvidiaRedistArchives,
} from './cuda-runtime-source.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-cuda-rt-')
})
afterEach(() => data.cleanup())

const runtime = (major: 12 | 13) => [
  `cudart64_${major}.dll`,
  `cublas64_${major}.dll`,
  `cublasLt64_${major}.dll`,
]

async function writeDlls(dir: string, names: readonly string[]): Promise<void> {
  await mkdir(dir, { recursive: true })
  for (const name of names) await writeFile(join(dir, name), 'dll')
}

const pack = (provider: 'llamacpp-upstream' | 'llamacpp', version: string, backend: string) =>
  join(data.layout.provider(provider).backendsDir, version, backend)

/** A downloader that answers each URL with the archive `byUrl` gives, or fails it. */
function fakeDownloader(byUrl: (url: string) => Buffer | Error) {
  const items: DownloadItem[] = []
  const download = vi.fn(async (_task: string, batch: DownloadItem[]) => {
    for (const item of batch) {
      items.push(item)
      const answer = byUrl(item.url)
      if (answer instanceof Error) throw answer
      await writeFile(item.save_path, answer)
    }
  })
  return { downloader: { download }, items }
}

const offline = () => fakeDownloader(() => new Error('offline'))

describe('cudaToolkitOfPack', () => {
  it('reads the toolkit from upstream and TurboQuant backend names', () => {
    expect(cudaToolkitOfPack('llamacpp-upstream', 'win-cuda-13.4-x64')).toBe('13.4')
    expect(cudaToolkitOfPack('llamacpp', 'windows-x64-cuda-12.4')).toBe('12.4')
    expect(cudaToolkitOfPack('llamacpp-upstream', 'win-vulkan-x64')).toBeNull()
  })
})

describe('deliverWindowsCudaRuntime', () => {
  const target = (
    backend = 'win-cuda-12.4-x64',
    provider: 'llamacpp-upstream' | 'llamacpp' = 'llamacpp-upstream'
  ) => ({
    provider,
    version: 'b12019',
    backend,
    packDir: pack(provider, 'b12019', backend),
  })

  it('does nothing for a pack that is not CUDA, or already carries the whole runtime', async () => {
    const { downloader } = offline()
    const deps = { layout: data.layout, downloader, taskId: 't' }
    expect(await deliverWindowsCudaRuntime(target('win-vulkan-x64'), deps)).toBe('present')
    await writeDlls(join(target().packDir, 'build', 'bin'), runtime(12))
    expect(await deliverWindowsCudaRuntime(target(), deps)).toBe('present')
    expect(downloader.download).not.toHaveBeenCalled()
  })

  it('copies the runtime from another installed pack of the same major and at least the same minor', async () => {
    const { downloader } = offline()
    const deps = { layout: data.layout, downloader, taskId: 't', log: vi.fn() }
    // A 13.3 pack cannot lend its runtime to a 13.4 build; a 13.4 TurboQuant-compatible upstream one can.
    await writeDlls(
      join(pack('llamacpp-upstream', 'b11000', 'win-cuda-13.3-x64'), 'build', 'bin'),
      runtime(13)
    )
    const tq = target('windows-x64-cuda-13.3', 'llamacpp')
    expect(await deliverWindowsCudaRuntime(tq, deps)).toBe('installed-pack')
    expect((await readdir(join(tq.packDir, 'build', 'bin'))).sort()).toEqual(runtime(13).sort())

    const newer = target('win-cuda-13.4-x64')
    await expect(deliverWindowsCudaRuntime(newer, deps)).rejects.toBeInstanceOf(AtomicCoreError)
    await writeDlls(
      join(pack('llamacpp-upstream', 'b11500', 'win-cuda-13.4-x64'), 'build', 'bin'),
      runtime(13)
    )
    expect(await deliverWindowsCudaRuntime(newer, deps)).toBe('installed-pack')
    // Only the refused attempt above went to the network (the pinned 13.4 companion).
    expect(downloader.download).toHaveBeenCalledTimes(1)
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('installed-pack'))
  })

  it('only uses a donor that has every missing DLL, and takes the legacy lib folder', async () => {
    const { downloader } = offline()
    const deps = { layout: data.layout, downloader, taskId: 't' }
    await writeDlls(join(pack('llamacpp', 'b1-1.0.0', 'windows-x64-cuda-12.4'), 'build', 'bin'), [
      'cudart64_12.dll',
    ])
    await expect(deliverWindowsCudaRuntime(target(), deps)).rejects.toMatchObject({
      code: 'ENGINE_BINARY_BROKEN',
    })
    await writeDlls(join(data.root, 'llamacpp', 'lib'), [
      'CUDART64_12.DLL',
      'cublas64_12.dll',
      'cublasLt64_12.dll',
    ])
    expect(await deliverWindowsCudaRuntime(target(), deps)).toBe('installed-pack')
    expect((await readdir(join(target().packDir, 'build', 'bin'))).sort()).toEqual(runtime(12).sort())
  })

  it('copies from a CUDA toolkit on the host: bin\\x64 for CUDA 13, bin for CUDA 12', async () => {
    const { downloader } = offline()
    // CUDA_PATH alone is read for its version from the folder name; an older minor is not enough.
    const toolkit132 = join(data.root, 'cuda', 'v13.2')
    await writeDlls(join(toolkit132, 'bin', 'x64'), runtime(13))
    await expect(
      deliverWindowsCudaRuntime(target('win-cuda-13.4-x64'), {
        layout: data.layout,
        downloader,
        taskId: 't',
        env: { CUDA_PATH: toolkit132 },
      })
    ).rejects.toMatchObject({ code: 'ENGINE_BINARY_BROKEN' })

    const toolkit13 = join(data.root, 'cuda', 'v13.4')
    const toolkit12 = join(data.root, 'Program Files', 'NVIDIA GPU Computing Toolkit', 'CUDA', 'v12.6')
    await writeDlls(join(toolkit13, 'bin', 'x64'), runtime(13))
    await mkdir(join(toolkit13, 'bin'), { recursive: true })
    await writeDlls(join(toolkit12, 'bin'), runtime(12))
    const env = { CUDA_PATH_V13_4: toolkit13, ProgramFiles: join(data.root, 'Program Files') }
    const deps = { layout: data.layout, downloader, taskId: 't', env }
    expect(await deliverWindowsCudaRuntime(target('win-cuda-13.4-x64'), deps)).toBe('host-toolkit')
    expect(await deliverWindowsCudaRuntime(target('win-cuda-12.4-x64'), deps)).toBe('host-toolkit')
    // Only the refused attempt above went to the network (the pinned 13.4 companion).
    expect(downloader.download).toHaveBeenCalledTimes(1)
  })

  it("downloads the pack's own release companion with its checksum", async () => {
    const url = 'https://mirror.example/b12019/cudart-llama-bin-win-cuda-12.4-x64.zip'
    const { downloader, items } = fakeDownloader((u) =>
      u === url ? cudaRuntimeZip(12, '') : new Error('unexpected')
    )
    const source = await deliverWindowsCudaRuntime(target(), {
      layout: data.layout,
      downloader,
      taskId: 't',
      proxy: { url: 'http://proxy' },
      releaseCompanion: { url, sha256: 'abc', size: 3 },
    })
    expect(source).toBe('release-companion')
    expect(items).toEqual([
      expect.objectContaining({ url, sha256: 'abc', size: 3, proxy: { url: 'http://proxy' } }),
    ])
    expect((await readdir(join(target().packDir, 'build', 'bin'))).sort()).toEqual(runtime(12).sort())
    expect(await readdir(data.layout.provider('llamacpp-upstream').tmpDir)).toEqual([])
  })

  it("falls back to NVIDIA's redistributables, verified by the manifest's sha256 and size", async () => {
    const manifest = {
      cuda_cudart: {
        'windows-x86_64': {
          relative_path: 'cuda_cudart/windows-x86_64/cuda_cudart-windows-x86_64-13.4.31-archive.zip',
          sha256: 'c'.repeat(64),
          size: '2589792',
        },
      },
      libcublas: {
        'windows-x86_64': {
          relative_path: 'libcublas/windows-x86_64/libcublas-windows-x86_64-13.6.0.1-archive.zip',
          sha256: 'b'.repeat(64),
          size: '391055517',
        },
      },
    }
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === `${NVIDIA_CUDA_REDIST_BASE}/`)
        return new Response(
          '<a href="redistrib_13.3.1.json">x</a> redistrib_13.4.1.json redistrib_13.4.3.json redistrib_12.9.1.json'
        )
      if (url === `${NVIDIA_CUDA_REDIST_BASE}/redistrib_13.4.3.json`) return Response.json(manifest)
      return new Response('nope', { status: 404 })
    })
    const { downloader, items } = fakeDownloader((url) =>
      url.includes('cuda_cudart')
        ? storedZipFiles([['cuda_cudart-archive/bin/x64/cudart64_13.dll', Buffer.from('dll')]])
        : url.includes('libcublas')
          ? storedZipFiles([
              ['libcublas-archive/bin/x64/cublas64_13.dll', Buffer.from('dll')],
              ['libcublas-archive/bin/x64/cublasLt64_13.dll', Buffer.from('dll')],
              ['libcublas-archive/bin/x64/nvblas64_13.dll', Buffer.from('dll')],
            ])
          : new Error('offline')
    )
    const source = await deliverWindowsCudaRuntime(target('win-cuda-13.4-x64'), {
      layout: data.layout,
      downloader,
      taskId: 't',
      releaseCompanion: { url: 'https://cdn.example/cudart-llama-bin-win-cuda-13.4-x64.zip' },
      fetch: fetchImpl as unknown as typeof fetch,
    })
    expect(source).toBe('nvidia-redist')
    expect(items.slice(1)).toEqual([
      expect.objectContaining({
        url: `${NVIDIA_CUDA_REDIST_BASE}/${manifest.cuda_cudart['windows-x86_64'].relative_path}`,
        sha256: 'c'.repeat(64),
        size: 2_589_792,
      }),
      expect.objectContaining({
        url: `${NVIDIA_CUDA_REDIST_BASE}/${manifest.libcublas['windows-x86_64'].relative_path}`,
        sha256: 'b'.repeat(64),
        size: 391_055_517,
      }),
    ])
    // Only the runtime DLLs are put beside the pack, not everything in the archives.
    expect((await readdir(join(target('win-cuda-13.4-x64').packDir, 'build', 'bin'))).sort()).toEqual(
      runtime(13).sort()
    )
  })

  it('picks the same minor first, then the next one up, and skips a manifest without the runtime', async () => {
    const answers: Record<string, (() => Response) | undefined> = {}
    const fetchImpl = (async (input: string | URL | Request) =>
      answers[String(input)]?.() ?? new Response('nope', { status: 404 })) as typeof fetch
    answers[`${NVIDIA_CUDA_REDIST_BASE}/`] = () =>
      new Response('redistrib_12.4.0.json redistrib_12.6.3.json redistrib_11.8.0.json')
    answers[`${NVIDIA_CUDA_REDIST_BASE}/redistrib_12.6.3.json`] = () =>
      Response.json({
        cuda_cudart: { 'windows-x86_64': { relative_path: 'a/x.zip', sha256: 'a', size: 1 } },
        libcublas: { 'windows-x86_64': { relative_path: 'b/y.zip', sha256: 'b', size: 2 } },
      })
    // 12.4.0 has no Windows cuBLAS entry: skipped for the next release up.
    answers[`${NVIDIA_CUDA_REDIST_BASE}/redistrib_12.4.0.json`] = () =>
      Response.json({
        cuda_cudart: { 'windows-x86_64': { relative_path: 'a/x.zip', sha256: 'a', size: 1 } },
      })
    expect(await nvidiaRedistArchives({ major: 12, minor: 4 }, fetchImpl)).toEqual([
      { url: `${NVIDIA_CUDA_REDIST_BASE}/a/x.zip`, sha256: 'a', size: 1, name: 'x.zip' },
      { url: `${NVIDIA_CUDA_REDIST_BASE}/b/y.zip`, sha256: 'b', size: 2, name: 'y.zip' },
    ])
    expect(await nvidiaRedistArchives({ major: 13, minor: 0 }, fetchImpl)).toBeUndefined()
    const down = (async () => new Response('', { status: 503 })) as typeof fetch
    expect(await nvidiaRedistArchives({ major: 12, minor: 4 }, down)).toBeUndefined()
  })

  it('falls back to the pinned ggml-org companions, arm64 included, and skips NVIDIA there', async () => {
    const arm = PINNED_WINDOWS_CUDA_RUNTIMES.find((p) => p.arch === 'arm64')!
    const { downloader, items } = fakeDownloader((url) =>
      url === arm.url ? cudaRuntimeZip(13, '') : new Error('offline')
    )
    const fetchImpl = vi.fn()
    const source = await deliverWindowsCudaRuntime(target('win-cuda-13.4-arm64'), {
      layout: data.layout,
      downloader,
      taskId: 't',
      fetch: fetchImpl as unknown as typeof fetch,
    })
    expect(source).toBe('pinned-companion')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(items).toEqual([expect.objectContaining({ url: arm.url, sha256: arm.sha256, size: arm.size })])
  })

  it('refuses with every source it tried when none can supply the runtime', async () => {
    const { downloader } = offline()
    const failingFetch = (async () => {
      throw new Error('no network')
    }) as unknown as typeof fetch
    const error = await deliverWindowsCudaRuntime(target('windows-x64-cuda-12.4', 'llamacpp'), {
      layout: data.layout,
      downloader,
      taskId: 't',
      fetch: failingFetch,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AtomicCoreError)
    expect(error).toMatchObject({
      code: 'ENGINE_BINARY_BROKEN',
      message: expect.stringContaining(
        'missing its CUDA runtime (cudart64_12.dll, cublas64_12.dll, cublasLt64_12.dll)'
      ),
    })
    const details = (error as AtomicCoreError).details ?? ''
    expect(details).toContain('installed packs')
    expect(details).toContain('CUDA toolkit on this computer')
    expect(details).toContain('NVIDIA redist manifest: no network')
    expect(details).toContain('cudart-llama-bin-win-cuda-12.4-x64.zip: offline')
  })
})
