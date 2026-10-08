import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { c as tarCreate } from 'tar'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { storedZip } from '../../../test/helpers/backend-install-e2e.js'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import {
  BackendService,
  mergeCompanionIntoBin,
  verifyMacBackendBinary,
  PRISM_LAUNCH_CHECK_TIMEOUT_MS,
  verifyPrismBackendBinary,
} from './service.js'
import type { PrismManifest } from '../catalog/index.js'
import { OptimalBackendStore } from '../optimal/index.js'
import type { UpstreamManifest } from '../types.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-backend-service-')
})
afterEach(() => data.cleanup())

const MANIFEST: UpstreamManifest = {
  tag_name: 'b6325',
  download_base: 'https://mirror.example/b6325',
  assets: [{ name: 'llama-b6325-bin-macos-arm64.tar.gz', sha256: 'a'.repeat(64), size: 1024 }],
}

/**
 * A downloader stand-in that writes whatever the caller asked to be saved.
 *
 * The real one is covered where it lives; what matters here is the order this service does things
 * in, and what it leaves behind when a step fails.
 */
function fakeDownloader(behaviour: { fail?: boolean; write?: string } = {}) {
  const calls: Array<{ taskId: string; paths: string[] }> = []
  return {
    calls,
    download: vi.fn(async (taskId: string, items: Array<{ save_path: string }>) => {
      calls.push({ taskId, paths: items.map((i) => i.save_path) })
      if (behaviour.fail) throw new Error('network went away')
      for (const item of items) {
        await mkdir(join(item.save_path, '..'), { recursive: true })
        await writeFile(item.save_path, behaviour.write ?? 'archive')
      }
    }),
  }
}

function service(downloader: ReturnType<typeof fakeDownloader>, manifest = MANIFEST) {
  return new BackendService({
    layout: data.layout,
    provider: 'llamacpp-upstream',
    downloader: downloader as never,
    readManifest: async () => manifest,
    platform: 'darwin',
    now: () => 1,
    verifyMacBackend: async () => {},
  })
}

describe('listInstalled', () => {
  it('reports what is on disk and marks the one in use', async () => {
    await data.writeBackend('llamacpp-upstream', 'b6325', 'macos-arm64')
    await data.writeBackend('llamacpp-upstream', 'b6100', 'macos-arm64')

    const packs = await service(fakeDownloader()).listInstalled('b6325/macos-arm64')

    expect(packs.map((p) => `${p.version}/${p.backend}`).sort()).toEqual([
      'b6100/macos-arm64',
      'b6325/macos-arm64',
    ])
    expect(packs.find((p) => p.version === 'b6325')?.active).toBe(true)
    expect(packs.find((p) => p.version === 'b6100')?.active).toBe(false)
  })

  it('is empty on a data folder with no backends', async () => {
    expect(await service(fakeDownloader()).listInstalled()).toEqual([])
  })
})

describe('install', () => {
  it('rejects a macOS pack with the wrong build before replacing the installed version', async () => {
    const target = join(data.layout.provider('llamacpp-upstream').backendsDir, 'b6325', 'macos-arm64')
    await data.writeBackend('llamacpp-upstream', 'b6325', 'macos-arm64')
    const oldExe = join(target, 'build', 'bin', 'llama-server')
    await writeFile(oldExe, 'previous build')
    const fixture = join(data.root, 'wrong-build-fixture')
    await mkdir(join(fixture, 'build', 'bin'), { recursive: true })
    await writeFile(join(fixture, 'build', 'bin', 'llama-server'), 'wrong build')
    const downloader = {
      download: vi.fn(async (_task: string, items: Array<{ save_path: string }>) => {
        await tarCreate({ gzip: true, cwd: fixture, file: items[0]!.save_path }, ['build'])
      }),
    }
    const installed = new BackendService({
      layout: data.layout,
      provider: 'llamacpp-upstream',
      downloader: downloader as never,
      readManifest: async () => MANIFEST,
      platform: 'darwin',
      now: () => 1,
      verifyMacBackend: async () => {
        throw new Error('wrong architecture')
      },
    })
    await expect(installed.install('b6325', 'macos-arm64', { taskId: 't', force: true })).rejects.toThrow(
      /wrong architecture/
    )
    expect(await readFile(oldExe, 'utf8')).toBe('previous build')
    await expect(readdir(`${target}.incoming-1`)).rejects.toThrow()
  })

  // A `#!/bin/sh` stand-in for the binary and POSIX exec bits; the check only runs for macOS packs.
  it.skipIf(process.platform === 'win32')(
    'launch-checks the real executable and compares its reported build',
    async () => {
      const staging = join(data.root, 'launch-check')
      await mkdir(join(staging, 'build', 'bin'), { recursive: true })
      const exe = join(staging, 'build', 'bin', 'llama-server')
      const helper = join(staging, 'build', 'bin', 'helper')
      await writeFile(exe, '#!/bin/sh\necho "version: 6325 (test)"\n')
      await writeFile(helper, 'other binary')
      await expect(verifyMacBackendBinary(staging, 'b6325')).resolves.toBeUndefined()
      expect((await stat(helper)).mode & 0o111).toBe(0o111)
      await expect(verifyMacBackendBinary(staging, 'b6326')).rejects.toThrow(/did not report/)
    }
  )
  it('does not download a pack that is already there', async () => {
    await data.writeBackend('llamacpp-upstream', 'b6325', 'macos-arm64')
    const downloader = fakeDownloader()

    const result = await service(downloader).install('b6325', 'macos-arm64', { taskId: 't' })

    expect(result.installed).toBe(false)
    expect(downloader.download).not.toHaveBeenCalled()
  })

  it('downloads it again when the caller insists', async () => {
    await data.writeBackend('llamacpp-upstream', 'b6325', 'macos-arm64')
    const downloader = fakeDownloader()

    await service(downloader)
      .install('b6325', 'macos-arm64', { taskId: 't', force: true })
      .catch(() => {})

    expect(downloader.download).toHaveBeenCalled()
  })

  it('reports everything under the one task id the caller named', async () => {
    // The progress bar listens on a name derived from the task; a second id invented mid-install
    // would strand the bar at whatever it last saw.
    const downloader = fakeDownloader()

    await service(downloader)
      .install('b6325', 'macos-arm64', { taskId: 'backend-install-1' })
      .catch(() => {})

    expect(downloader.calls).toHaveLength(1)
    expect(downloader.calls[0]?.taskId).toBe('backend-install-1')
  })

  it('passes the checksum and size the manifest published', async () => {
    const downloader = fakeDownloader()
    const items: Array<Record<string, unknown>> = []
    downloader.download.mockImplementation(
      async (_t: string, given: ReadonlyArray<Record<string, unknown>>) => {
        items.push(...given)
        throw new Error('stop here')
      }
    )

    await service(downloader)
      .install('b6325', 'macos-arm64', { taskId: 't' })
      .catch(() => {})

    expect(items[0]).toMatchObject({ sha256: 'a'.repeat(64), size: 1024 })
  })

  it('uses one proxy policy for manifest, archive and CUDA companion', async () => {
    const downloader = fakeDownloader()
    const items: Array<Record<string, unknown>> = []
    downloader.download.mockImplementation(
      async (_task: string, given: ReadonlyArray<Record<string, unknown>>) => {
        items.push(...given)
        throw new Error('stop before extraction')
      }
    )
    const seen: unknown[] = []
    const s = new BackendService({
      layout: data.layout,
      provider: 'llamacpp-upstream',
      downloader: downloader as never,
      readManifest: async (proxy) => {
        seen.push(proxy)
        return null
      },
      platform: 'win32',
    })
    const proxy = { url: 'http://proxy.example:8080', username: 'user', password: 'secret' }
    await s.install('b1', 'win-cuda-13.3-x64', { taskId: 't', proxy }).catch(() => {})
    expect(seen).toEqual([proxy])
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ proxy })
    expect(items[1]).toMatchObject({ proxy })
  })

  it('installs a Linux arm64 CUDA pack with its cudart companion next to llama-server', async () => {
    const fixtures = join(data.root, 'linux-cuda-fixtures')
    await mkdir(join(fixtures, 'llama-b11344'), { recursive: true })
    await writeFile(join(fixtures, 'llama-b11344', 'llama-server'), 'server')
    await writeFile(join(fixtures, 'llama-b11344', 'libggml-cuda.so'), 'ggml-cuda')
    const cudartDir = 'cudart-llama-b11344-bin-ubuntu-cuda-13.4-arm64'
    await mkdir(join(fixtures, cudartDir), { recursive: true })
    await writeFile(join(fixtures, cudartDir, 'libcudart.so.13'), 'cudart')
    await writeFile(join(fixtures, cudartDir, 'libcublas.so.13'), 'cublas')
    const urls: string[] = []
    const downloader = {
      download: vi.fn(async (_task: string, items: Array<{ url: string; save_path: string }>) => {
        for (const item of items) {
          urls.push(item.url)
          const entry = item.save_path.includes('cudart-') ? cudartDir : 'llama-b11344'
          await tarCreate({ gzip: true, cwd: fixtures, file: item.save_path }, [entry])
        }
      }),
    }
    const s = new BackendService({
      layout: data.layout,
      provider: 'llamacpp-upstream',
      downloader: downloader as never,
      readManifest: async () => null,
      platform: 'linux',
      now: () => 1,
    })

    const result = await s.install('b11344', 'linux-cuda-13.4-arm64', { taskId: 't' })

    expect(urls).toEqual([
      'https://github.com/ggml-org/llama.cpp/releases/download/b11344/llama-b11344-bin-ubuntu-cuda-13.4-arm64.tar.gz',
      `https://github.com/ggml-org/llama.cpp/releases/download/b11344/${cudartDir}.tar.gz`,
    ])
    expect((await readdir(join(result.path, 'build', 'bin'))).sort()).toEqual([
      'libcublas.so.13',
      'libcudart.so.13',
      'libggml-cuda.so',
      'llama-server',
    ])
    expect(await readdir(result.path)).toEqual(['build'])
  })

  it('still has a URL for a tag the mirror never published, without a checksum', async () => {
    // The fallback to the ggml-org CDN is what lets a backend be installed for a build the mirror
    // has not caught up with. A wrong tag then fails as a 404 mid-download, not as a refusal here.
    const empty: UpstreamManifest = { tag_name: 'b1', assets: [] }
    const downloader = fakeDownloader()
    const items: Array<Record<string, unknown>> = []
    downloader.download.mockImplementation(
      async (_t: string, given: ReadonlyArray<Record<string, unknown>>) => {
        items.push(...given)
        throw new Error('stop here')
      }
    )

    await service(downloader, empty)
      .install('b6325', 'macos-arm64', { taskId: 't' })
      .catch(() => {})

    expect(items[0]?.url).toMatch(/^https?:\/\//)
    expect(items[0]?.sha256, 'nothing to verify against off the mirror').toBeUndefined()
  })

  it('leaves nothing behind when the download fails', async () => {
    // A half-extracted pack is worse than none: backend selection would find it and the failure
    // would surface later as a model that will not load.
    const downloader = fakeDownloader({ fail: true })

    await expect(service(downloader).install('b6325', 'macos-arm64', { taskId: 't' })).rejects.toThrow(
      /network went away/
    )

    await expectNoPackOrStaging()
  })

  it('leaves nothing behind when the archive cannot be unpacked', async () => {
    // The downloader "succeeded" but wrote something that is not an archive.
    const downloader = fakeDownloader({ write: 'not an archive' })

    await expect(service(downloader).install('b6325', 'macos-arm64', { taskId: 't' })).rejects.toThrow()

    await expectNoPackOrStaging()
  })
})

/** Neither an installed pack nor the directory an interrupted install extracts into. */
async function expectNoPackOrStaging(version = 'b6325'): Promise<void> {
  const backends = data.layout.provider('llamacpp-upstream').backendsDir
  const inside = await readdir(join(backends, version)).catch(() => [])
  expect(inside, 'no pack and no staging directory survives a failure').toEqual([])
  expect(await service(fakeDownloader()).listInstalled()).toEqual([])
}

describe('install on the TurboQuant provider', () => {
  const tq = (downloader: ReturnType<typeof fakeDownloader>, platform: NodeJS.Platform = 'darwin') =>
    new BackendService({
      layout: data.layout,
      provider: 'llamacpp',
      downloader: downloader as never,
      readManifest: async () => {
        throw new Error('the upstream manifest is not read for TurboQuant')
      },
      platform,
      now: () => 1,
    })

  it('downloads the fork asset the caller names, without a checksum, into the llamacpp tree', async () => {
    const downloader = fakeDownloader({ fail: true })
    await expect(
      tq(downloader).install('b10018-1.3.0', 'macos-arm64', {
        taskId: 'llamacpp-backend-b10018-1_3_0/macos-arm64',
        assetName: 'llama-turboquant-macos-arm64.tar.gz',
      })
    ).rejects.toThrow(/network went away/)
    const [call] = downloader.download.mock.calls
    expect(call?.[1]).toEqual([
      {
        url: 'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/download/b10018-1.3.0/llama-turboquant-macos-arm64.tar.gz',
        save_path: join(
          data.layout.provider('llamacpp').backendsDir,
          'b10018-1.3.0',
          'macos-arm64.incoming-1',
          'llama-turboquant-macos-arm64.tar.gz'
        ),
      },
    ])
  })

  it('falls back to the cached release index, then to the naming convention, for the asset', async () => {
    const downloader = fakeDownloader({ fail: true })
    await expect(
      tq(downloader).install('b1-1.0.0', 'linux-x64-rocm', {
        taskId: 't',
        proxy: { url: 'http://proxy:8080' },
      })
    ).rejects.toThrow()
    expect(downloader.download.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({
        url: expect.stringMatching(/\/b1-1\.0\.0\/llama-turboquant-linux-x64-rocm\.tar\.gz$/),
        proxy: { url: 'http://proxy:8080' },
      }),
    ])
    await mkdir(join(data.root, 'llamacpp'), { recursive: true })
    await writeFile(
      join(data.root, 'llamacpp', 'release-index.cache.json'),
      JSON.stringify({
        catalog: {
          releases: [{ tag: 'b1-1.0.0', variants: [{ id: 'linux-x64-rocm', asset: 'rocm.tar.gz' }] }],
        },
      })
    )
    await expect(tq(downloader).install('b1-1.0.0', 'linux-x64-rocm', { taskId: 't' })).rejects.toThrow()
    expect(downloader.download.mock.calls[1]?.[1]).toEqual([
      expect.objectContaining({ url: expect.stringMatching(/\/rocm\.tar\.gz$/) }),
    ])
  })

  it('installs a pack and warns instead of failing when the CUDA runtime cannot be repaired', async () => {
    const bytes = storedZip('build/bin/llama-server.exe', Buffer.from('exe'))
    const warnings: string[] = []
    const downloader = {
      download: vi.fn(async (_task: string, items: Array<{ url: string; save_path: string }>) => {
        if (items[0]?.url.includes('cudart')) throw new Error('offline')
        await writeFile(items[0]?.save_path as string, bytes)
      }),
    }
    const service = new BackendService({
      layout: data.layout,
      provider: 'llamacpp',
      downloader: downloader as never,
      readManifest: async () => null,
      platform: 'win32',
      now: () => 1,
      log: (message) => warnings.push(message),
    })
    const result = await service.install('b1-1.0.0', 'windows-x64-cuda-12.4', { taskId: 't' })
    expect(result).toMatchObject({ installed: true })
    expect(downloader.download).toHaveBeenCalledTimes(2)
    expect(warnings).toEqual([
      expect.stringContaining('cudart repair for b1-1.0.0/windows-x64-cuda-12.4 failed'),
    ])
  })
})

describe('install on the PrismML provider', () => {
  const TAG = 'prism-b10754-2459f68'
  const asset = (backend: string, name: string, extra: Record<string, unknown> = {}) => ({
    backend,
    name,
    size: 3,
    sha256: backend.charCodeAt(4).toString(16).padStart(2, '0').repeat(32),
    validation: 'approved' as const,
    ...extra,
  })
  const manifest = (withdrawn = false): PrismManifest => ({
    schema_version: 1,
    updated_at: '2026-10-05T00:00:00Z',
    upstream_repo: 'PrismML-Eng/llama.cpp',
    releases: [
      {
        tag: TAG,
        commit: '2459f68b5c0eb26261fd5a81682004b93cd645ba',
        published_at: '2026-10-02T00:00:00Z',
        min_core_version: '0.10.0',
        notes_url: `https://github.com/PrismML-Eng/llama.cpp/releases/tag/${TAG}`,
        capabilities: ['pq2_0'],
        ...(withdrawn ? { withdrawn: { reason: 'broken' } } : {}),
        assets: [
          asset('win-cuda-12.4-x64', `llama-${TAG}-bin-win-cuda-12.4-x64.zip`, {
            companion_backend: 'win-cudart-12.4-x64',
          }),
          asset('win-cudart-12.4-x64', 'cudart-llama-bin-win-cuda-12.4-x64.zip', { companion: true }),
          asset('linux-cpu-x64', `llama-${TAG}-bin-ubuntu-x64.tar.gz`),
        ],
      },
    ],
  })
  const prism = (
    downloader: { download: (task: string, items: never[]) => Promise<void> },
    options: { withdrawn?: boolean; verify?: () => Promise<void>; platform?: NodeJS.Platform } = {}
  ) =>
    new BackendService({
      layout: data.layout,
      provider: 'atomic-prism',
      downloader: downloader as never,
      readManifest: async () => {
        throw new Error('the upstream manifest is not read for PrismML')
      },
      prismCatalog: { catalog: async () => ({ manifest: manifest(options.withdrawn), source: 'live' }) },
      platform: options.platform ?? 'win32',
      now: () => 1,
      verifyPrismBackend: options.verify ?? (async () => {}),
    })

  it('installs a Windows CUDA pack and its runtime into one build/bin, with hashes, under one task', async () => {
    const items: Array<{ url: string; save_path: string; sha256?: string; size?: number }> = []
    const downloader = {
      download: vi.fn(async (task: string, given: typeof items) => {
        expect(task).toBe('prism-task')
        items.push(...given)
        await writeFile(given[0]!.save_path, storedZip(`llama-${TAG}/llama-server.exe`, Buffer.from('exe')))
        await writeFile(given[1]!.save_path, storedZip('cudart64_12.dll', Buffer.from('dll')))
      }),
    }
    const result = await prism(downloader as never).install(TAG, 'win-cuda-12.4-x64', {
      taskId: 'prism-task',
    })
    expect(items.map((i) => i.url)).toEqual([
      `https://github.com/PrismML-Eng/llama.cpp/releases/download/${TAG}/llama-${TAG}-bin-win-cuda-12.4-x64.zip`,
      `https://github.com/PrismML-Eng/llama.cpp/releases/download/${TAG}/cudart-llama-bin-win-cuda-12.4-x64.zip`,
    ])
    expect(items.every((i) => i.sha256?.length === 64 && i.size === 3)).toBe(true)
    expect(result.path).toBe(join(data.layout.provider('atomic-prism').backendsDir, TAG, 'win-cuda-12.4-x64'))
    expect((await readdir(join(result.path, 'build', 'bin'))).sort()).toEqual([
      'cudart64_12.dll',
      'llama-server.exe',
    ])
    expect(await readdir(result.path)).toEqual(['build'])
  })

  it.each([
    ['an asset the manifest does not list', TAG, 'win-vulkan-x64', false, /not in the Atomic Chat manifest/],
    [
      'a companion asked for on its own',
      TAG,
      'win-cudart-12.4-x64',
      false,
      /not in the Atomic Chat manifest/,
    ],
    ['a withdrawn release', TAG, 'linux-cpu-x64', true, /withdrawn/],
  ])('refuses %s before downloading', async (_label, tag, backend, withdrawn, message) => {
    const downloader = fakeDownloader()
    await expect(prism(downloader, { withdrawn }).install(tag, backend, { taskId: 't' })).rejects.toThrow(
      message
    )
    expect(downloader.download).not.toHaveBeenCalled()
  })

  it('keeps the previous pack when the new one fails its launch check', async () => {
    await data.writeBackend('atomic-prism', TAG, 'linux-cpu-x64')
    const target = join(data.layout.provider('atomic-prism').backendsDir, TAG, 'linux-cpu-x64')
    await writeFile(join(target, 'build', 'bin', 'llama-server'), 'previous')
    const fixture = join(data.root, 'prism-fixture')
    await mkdir(join(fixture, `llama-${TAG}`), { recursive: true })
    await writeFile(join(fixture, `llama-${TAG}`, 'llama-server'), 'new')
    const downloader = {
      download: vi.fn(async (_t: string, given: Array<{ save_path: string }>) => {
        await tarCreate({ gzip: true, cwd: fixture, file: given[0]!.save_path }, [`llama-${TAG}`])
      }),
    }
    const verify = async () => {
      throw new Error('did not report build 10754')
    }
    await expect(
      prism(downloader as never, { platform: 'linux', verify }).install(TAG, 'linux-cpu-x64', {
        taskId: 't',
        force: true,
      })
    ).rejects.toThrow(/launch check .*Keeping the current backend/)
    expect(await readFile(join(target, 'build', 'bin', 'llama-server'), 'utf8')).toBe('previous')
  })
})

describe('verifyPrismBackendBinary', () => {
  it.skipIf(process.platform === 'win32')('accepts the build the tag names and nothing else', async () => {
    const staging = join(data.root, 'prism-launch')
    await mkdir(join(staging, 'build', 'bin'), { recursive: true })
    await writeFile(
      join(staging, 'build', 'bin', 'llama-server'),
      '#!/bin/sh\necho "version: 10754 (2459f68)" >&2\n'
    )
    await expect(verifyPrismBackendBinary(staging, 'prism-b10754-2459f68', 'linux')).resolves.toBeUndefined()
    await expect(verifyPrismBackendBinary(staging, 'prism-b10755-2459f68', 'linux')).rejects.toThrow(
      /did not report build 10755/
    )
  })
  it('refuses a tag that is not a PrismML tag', async () => {
    await expect(verifyPrismBackendBinary(data.root, 'b6325', 'linux')).rejects.toThrow(
      /not a PrismML release tag/
    )
  })
  it.skipIf(process.platform === 'win32')(
    'says how the server failed: its exit code and what it printed',
    async () => {
      const staging = join(data.root, 'prism-crash')
      await mkdir(join(staging, 'build', 'bin'), { recursive: true })
      await writeFile(
        join(staging, 'build', 'bin', 'llama-server'),
        '#!/bin/sh\necho "dyld: Library not loaded: @rpath/libllama.0.dylib" >&2\nexit 6\n'
      )
      await expect(verifyPrismBackendBinary(staging, 'prism-b10754-2459f68', 'linux')).rejects.toThrow(
        /exit code 6\): dyld: Library not loaded/
      )
    }
  )
  it.skipIf(process.platform === 'win32')('says a server that took too long timed out', async () => {
    const staging = join(data.root, 'prism-slow')
    await mkdir(join(staging, 'build', 'bin'), { recursive: true })
    await writeFile(join(staging, 'build', 'bin', 'llama-server'), '#!/bin/sh\nsleep 5\n')
    await expect(verifyPrismBackendBinary(staging, 'prism-b10754-2459f68', 'linux', 200)).rejects.toThrow(
      /signal SIGTERM, timed out/
    )
  })
  it('waits long enough for a first run that compiles its Metal shaders', () => {
    expect(PRISM_LAUNCH_CHECK_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
  })
})

describe('mergeCompanionIntoBin', () => {
  it.each([
    ['a flat archive', 'cudart64_12.dll'],
    ['an archive with one top directory', 'cudart-llama-bin-win-cuda-12.4-x64/cudart64_12.dll'],
  ])('puts %s beside llama-server', async (_label, entry) => {
    const staging = join(data.root, `companion-${entry.length}`)
    await mkdir(join(staging, 'build', 'bin'), { recursive: true })
    const archive = join(staging, 'c.zip')
    await writeFile(archive, storedZip(entry, Buffer.from('dll')))
    await mergeCompanionIntoBin(staging, archive)
    expect(await readdir(join(staging, 'build', 'bin'))).toEqual(['cudart64_12.dll'])
    expect((await readdir(staging)).sort()).toEqual(['build', 'c.zip'])
  })
})

describe('remove', () => {
  it('deletes a pack and says whether there was one', async () => {
    await data.writeBackend('llamacpp-upstream', 'b6325', 'macos-arm64')
    const s = service(fakeDownloader())

    expect(await s.remove('b6325', 'macos-arm64')).toBe(true)
    expect(await s.listInstalled()).toEqual([])

    expect(await s.remove('b6325', 'macos-arm64'), 'removing twice is not an error').toBe(false)
  })

  it('refuses the selected pack and ids that escape the backends directory', async () => {
    await data.writeBackend('llamacpp-upstream', 'b6325', 'macos-arm64')
    const s = service(fakeDownloader())

    await expect(s.remove('b6325', 'macos-arm64', 'b6325/macos-arm64')).rejects.toThrow(/currently selected/)
    await expect(s.remove('..', 'llamacpp-upstream')).rejects.toThrow(/Invalid backend pack/)
    expect(await s.listInstalled()).toHaveLength(1)
  })
})

describe('remove under the provider lock', () => {
  const pack = (version: string, backend: string) =>
    join(data.layout.provider('llamacpp-upstream').backendsDir, version, backend)

  function guarded(over: Partial<ConstructorParameters<typeof BackendService>[0]> = {}) {
    return new BackendService({
      layout: data.layout,
      provider: 'llamacpp-upstream',
      downloader: fakeDownloader() as never,
      readManifest: async () => MANIFEST,
      platform: 'darwin',
      now: () => 1,
      verifyMacBackend: async () => {},
      ...over,
    })
  }

  it('refuses a pack a session, the decision model or the embedding model runs from', async () => {
    await data.writeBackend('llamacpp-upstream', 'b6100', 'macos-arm64')
    const s = guarded({
      host: { exclusive: (fn) => fn(), inUse: async () => [pack('b6100', 'macos-arm64')] },
    })

    await expect(s.remove('b6100', 'macos-arm64', 'b6325/macos-arm64')).rejects.toMatchObject({
      code: 'BACKEND_IN_USE',
    })
    expect(await s.listInstalled()).toHaveLength(1)
  })

  it("refuses the installer's pack, with the reason in details", async () => {
    const resources = join(data.root, 'resources')
    await mkdir(join(resources, 'bin'), { recursive: true })
    await mkdir(join(resources, 'llamacpp-backend-upstream'), { recursive: true })
    await writeFile(join(resources, 'llamacpp-backend-upstream', 'version.txt'), 'b6100\n')
    await writeFile(join(resources, 'llamacpp-backend-upstream', 'backend.txt'), 'macos-arm64\n')
    await data.writeBackend('llamacpp-upstream', 'b6100', 'macos-arm64')
    const s = guarded({ resourcesDir: join(resources, 'bin') })

    await expect(s.remove('b6100', 'macos-arm64')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      details: 'bundled',
    })
    expect(await s.bundledPack()).toEqual({ version: 'b6100', backend: 'macos-arm64' })
    expect(await s.listInstalled()).toHaveLength(1)
  })

  it('refuses the active pack as INVALID_REQUEST when asked to, reading the selection inside the lock', async () => {
    await data.writeBackend('llamacpp-upstream', 'b6100', 'macos-arm64')
    let selected = 'b6325/macos-arm64'
    const s = guarded({
      host: {
        exclusive: async (fn) => {
          selected = 'b6100/macos-arm64'
          return fn()
        },
        inUse: async () => [],
      },
    })
    await expect(
      s.remove('b6100', 'macos-arm64', () => selected, { refuseActiveAs: 'INVALID_REQUEST' })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST', details: 'active' })
  })

  it('waits for the load in flight before deleting', async () => {
    await data.writeBackend('llamacpp-upstream', 'b6100', 'macos-arm64')
    let release!: () => void
    const loading = new Promise<void>((resolve) => (release = resolve))
    const steps: string[] = []
    const s = guarded({
      host: {
        exclusive: async (fn) => {
          await loading
          steps.push('load finished')
          return fn()
        },
        inUse: async () => [],
      },
    })
    const removal = s.remove('b6100', 'macos-arm64').then((removed) => {
      steps.push('removed')
      return removed
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await s.listInstalled()).toHaveLength(1)
    release()
    expect(await removal).toBe(true)
    expect(steps).toEqual(['load finished', 'removed'])
  })

  it('refuses a removal or an install while an update or activation of the provider runs', async () => {
    await data.writeBackend('llamacpp-upstream', 'b6100', 'macos-arm64')
    const s = guarded()
    let finish!: () => void
    const operation = s.operate(
      'update',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    await expect(s.remove('b6100', 'macos-arm64')).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_IN_PROGRESS',
    })
    await expect(s.install('b6325', 'macos-arm64', { taskId: 't' })).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_IN_PROGRESS',
    })
    await expect(s.operate('activate', async () => {})).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_IN_PROGRESS',
    })
    finish()
    await operation
    expect(await s.remove('b6100', 'macos-arm64')).toBe(true)
  })

  it('lets the operation that holds the provider install', async () => {
    await data.writeBackend('llamacpp-upstream', 'b6325', 'macos-arm64')
    const s = guarded()
    const result = await s.operate('update', (operation) =>
      s.install('b6325', 'macos-arm64', { taskId: 't', operation })
    )
    expect(result).toMatchObject({ version: 'b6325', installed: false })
  })
})

describe('what the service says it changed (change unify-engine-lifecycle, 3.7)', () => {
  /** A downloader that writes an upstream Linux pack archive. */
  const packDownloader = () => ({
    download: vi.fn(async (_task: string, items: Array<{ save_path: string }>) => {
      const fixture = join(data.root, 'pack-fixture')
      await mkdir(join(fixture, 'build', 'bin'), { recursive: true })
      await writeFile(join(fixture, 'build', 'bin', 'llama-server'), '#!/bin/sh\nexit 0\n')
      for (const item of items) await tarCreate({ gzip: true, cwd: fixture, file: item.save_path }, ['build'])
    }),
  })

  it('reports an install and a removal, and nothing for an install an update makes', async () => {
    const reasons: string[] = []
    const s = new BackendService({
      layout: data.layout,
      provider: 'llamacpp-upstream',
      downloader: packDownloader() as never,
      readManifest: async () => null,
      platform: 'linux',
      now: () => 1,
      onChanged: (reason) => reasons.push(reason),
    })
    expect((await s.install('b6325', 'linux-cpu-x64', { taskId: 't' })).installed).toBe(true)
    expect((await s.install('b6325', 'linux-cpu-x64', { taskId: 't' })).installed).toBe(false)
    expect(await s.remove('b6325', 'linux-cpu-x64')).toBe(true)
    expect(await s.remove('b6325', 'linux-cpu-x64')).toBe(false)
    await s.operate('update', (operation) => s.install('b6400', 'linux-cpu-x64', { taskId: 'u', operation }))
    expect(reasons).toEqual(['install', 'uninstall'])
  })
})

describe('what the manifest gives the download', () => {
  it('falls back to the published CDN when there is no manifest at all', async () => {
    const downloader = fakeDownloader()
    const urls: string[] = []
    downloader.download.mockImplementation(
      async (_t: string, items: ReadonlyArray<Record<string, unknown>>) => {
        urls.push(...items.map((i) => String(i.url)))
        throw new Error('stop here')
      }
    )
    const s = new BackendService({
      layout: data.layout,
      provider: 'llamacpp-upstream',
      downloader: downloader as never,
      readManifest: async () => null,
      platform: 'darwin',
    })

    await s.install('b6325', 'macos-arm64', { taskId: 't' }).catch(() => {})

    expect(urls[0] ?? '', 'a missing manifest is not a missing download').toMatch(/^https?:\/\//)
  })
})

describe('the optimal-backend record', () => {
  const gpu = {
    schemaVersion: 1,
    provider: 'llamacpp-upstream',
    detectedAt: 1_700_000_000,
    detectionKind: 'gpu',
    currentBackend: 'b6325/macos-arm64',
    // The parser insists these agree: `recommendedBackend`'s type is the ideal backend id.
    idealBackendId: 'macos-arm64',
    recommendedBackend: 'b6325/macos-arm64',
    recommendedCategory: 'Metal',
  } as never

  const optimalService = async (provider: 'llamacpp-upstream' | 'llamacpp' = 'llamacpp-upstream') =>
    new BackendService({
      layout: data.layout,
      provider,
      downloader: fakeDownloader() as never,
      readManifest: async () => MANIFEST,
      optimalStore: await OptimalBackendStore.open(data.layout.core.optimalBackend),
    })

  it('is absent until something detects one', async () => {
    expect(await (await optimalService()).getOptimalCache()).toEqual({ revision: 0, optimal: null })
  })

  it('survives being written and read back by another instance', async () => {
    // It lives beside the data it describes rather than in the webview's localStorage, so the CLI
    // and a second app process see the same answer.
    await (await optimalService()).setOptimalCache(gpu, 0)

    expect(await (await optimalService()).getOptimalCache()).toMatchObject({
      revision: 1,
      optimal: { detectionKind: 'gpu', idealBackendId: 'macos-arm64' },
    })
  })

  it('forgets a detection when asked, rather than keeping a stale recommendation', async () => {
    // "Find optimal backend" that finds nothing must clear it: otherwise the app keeps recommending
    // a backend for hardware that is no longer in the machine.
    const s = await optimalService()
    await s.setOptimalCache(gpu, 0)

    await s.setOptimalCache(null, 1)

    expect(await s.getOptimalCache()).toEqual({ revision: 2, optimal: null })
  })

  it('accepts a TurboQuant record only for the TurboQuant provider', async () => {
    const turboquant = {
      schemaVersion: 1,
      provider: 'llamacpp',
      detectedAt: 1,
      detectionKind: 'gpu',
      currentBackend: 'b1-1.0.0/linux-x64-cpu',
      idealBackendId: 'linux-x64-cuda-13.3',
      recommendedBackend: 'b1-1.0.0/linux-x64-cuda-13.3',
      recommendedCategory: 'CUDA 13',
    } as never
    await expect((await optimalService()).setOptimalCache(turboquant, 0)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    const s = await optimalService('llamacpp')
    await expect(
      s.setOptimalCache({ ...(turboquant as object), recommendedBackend: 'a/b/c' } as never, 0)
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect((await s.setOptimalCache(turboquant, 0)).status).toBe('updated')
    expect((await (await optimalService('llamacpp')).getOptimalCache()).optimal).toMatchObject({
      provider: 'llamacpp',
    })
  })

  it('keeps one provider’s record out of another’s', async () => {
    const upstream = await optimalService()
    await upstream.setOptimalCache(gpu, 0)
    const other = await optimalService('llamacpp')
    expect(await other.getOptimalCache(), 'the two providers can be on different builds').toEqual({
      revision: 0,
      optimal: null,
    })
    expect((await upstream.getOptimalCache()).optimal).not.toBeNull()
  })

  it('treats an unreadable file as no detection rather than failing every read', async () => {
    await mkdir(join(data.layout.core.optimalBackend, '..'), { recursive: true })
    await writeFile(data.layout.core.optimalBackend, '{ half written')

    expect(await (await optimalService()).getOptimalCache()).toEqual({ revision: 0, optimal: null })
  })

  it('drops one unreadable record without losing the others', async () => {
    await mkdir(join(data.layout.core.optimalBackend, '..'), { recursive: true })
    await writeFile(
      data.layout.core.optimalBackend,
      JSON.stringify({ 'llamacpp-upstream': gpu, 'llamacpp': { nonsense: true } })
    )

    expect((await (await optimalService()).getOptimalCache()).optimal).not.toBeNull()
  })
})
