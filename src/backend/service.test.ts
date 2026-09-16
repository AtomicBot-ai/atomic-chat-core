import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { BackendService } from './service.js'
import { OptimalBackendStore } from './optimal-store.js'
import type { UpstreamManifest } from './types.js'

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

describe('remove', () => {
  it('deletes a pack and says whether there was one', async () => {
    await data.writeBackend('llamacpp-upstream', 'b6325', 'macos-arm64')
    const s = service(fakeDownloader())

    expect(await s.remove('b6325', 'macos-arm64')).toBe(true)
    expect(await s.listInstalled()).toEqual([])

    expect(await s.remove('b6325', 'macos-arm64'), 'removing twice is not an error').toBe(false)
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
