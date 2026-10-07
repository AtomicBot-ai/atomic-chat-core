import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import {
  assetInstallable,
  EngineManifestSource,
  ENGINE_MANIFEST_TTL_MS,
  manifestKinds,
  MLX_MANIFEST_URL,
  parseMlxManifest,
  parseSdcppManifest,
  SDCPP_MANIFEST_URL,
  sdcppAssetUrl,
  mlxAssetUrl,
} from './manifest.js'
import type { MlxManifest, SdcppManifest } from './manifest.js'

const SDCPP = {
  $schema: './sdcpp-schema.json',
  updated_at: '2026-10-07T10:57:22Z',
  upstream_repo: 'AtomicBot-ai/stable-diffusion.cpp',
  tag_name: 'master-883-137f740-a36f1b1a',
  download_base: 'https://github.com/AtomicBot-ai/atomic-chat-conf/releases/download',
  assets: [
    { backend: 'macos-arm64', name: 'sd-mac.zip', sha256: 'a'.repeat(64), size: 10 },
    { backend: 'win-cudart-cu12', name: 'cudart.zip', sha256: 'b'.repeat(64), size: 20, companion: true },
    { backend: 'win-cpu-x64', name: 'sd-win-cpu.zip' },
  ],
}

const MLX = {
  $schema: './mlx-schema.json',
  upstream_repo: 'AtomicBot-ai/mlx-vlm',
  tag_name: 'mlxvlm-macos-arm64-07ba5a1',
  published_at: '2026-08-28T10:38:38Z',
  assets: [
    {
      backend: 'macos-arm64',
      name: 'mlxvlm-mlx-server-macos-arm64.tar.gz',
      sha256: 'c'.repeat(64),
      size: 210514030,
    },
  ],
}

describe('parseSdcppManifest', () => {
  it('keeps the fields of the conf schema and drops the keys it does not know', () => {
    const parsed = parseSdcppManifest(SDCPP)
    expect(parsed).toEqual({
      updated_at: '2026-10-07T10:57:22Z',
      upstream_repo: 'AtomicBot-ai/stable-diffusion.cpp',
      tag_name: 'master-883-137f740-a36f1b1a',
      download_base: 'https://github.com/AtomicBot-ai/atomic-chat-conf/releases/download',
      assets: [
        { backend: 'macos-arm64', name: 'sd-mac.zip', sha256: 'a'.repeat(64), size: 10 },
        { backend: 'win-cudart-cu12', name: 'cudart.zip', sha256: 'b'.repeat(64), size: 20, companion: true },
        { backend: 'win-cpu-x64', name: 'sd-win-cpu.zip' },
      ],
    })
  })

  it('refuses a tag the schema does not allow, a path as an asset name and a manifest with no usable asset', () => {
    expect(() => parseSdcppManifest({ ...SDCPP, tag_name: 'latest' })).toThrow(/tag_name/)
    expect(() => parseSdcppManifest({ ...SDCPP, tag_name: '../master-1-abcdef0' })).toThrow(/tag_name/)
    expect(
      parseSdcppManifest({
        ...SDCPP,
        assets: [...SDCPP.assets, { backend: 'linux-cpu-x64', name: '../x.zip' }],
      }).assets.map((a) => a.backend)
    ).toEqual(['macos-arm64', 'win-cudart-cu12', 'win-cpu-x64'])
    expect(() => parseSdcppManifest({ ...SDCPP, assets: [{ backend: 'x', name: 'a/b.zip' }] })).toThrow(
      /asset/
    )
    expect(() => parseSdcppManifest({ ...SDCPP, download_base: 'http://mirror' })).not.toThrow()
    expect(parseSdcppManifest({ ...SDCPP, download_base: 'http://mirror' }).download_base).toBeUndefined()
  })

  it('marks an asset without sha256 or size as not installable', () => {
    const parsed = parseSdcppManifest(SDCPP)
    expect(parsed.assets.map(assetInstallable)).toEqual([true, true, false])
  })
})

describe('parseMlxManifest', () => {
  it('reads the manifest conf publishes', () => {
    expect(parseMlxManifest(MLX)).toEqual({
      upstream_repo: 'AtomicBot-ai/mlx-vlm',
      tag_name: 'mlxvlm-macos-arm64-07ba5a1',
      published_at: '2026-08-28T10:38:38Z',
      assets: [MLX.assets[0]],
    })
  })

  it('refuses a document without a usable date, tag or repository: its order would be unknown', () => {
    expect(() => parseMlxManifest({ ...MLX, published_at: 'yesterday' })).toThrow(/published_at/)
    expect(() => parseMlxManifest({ ...MLX, published_at: '2026-13-45T00:00:00Z' })).toThrow(/published_at/)
    expect(() => parseMlxManifest({ ...MLX, tag_name: 'latest' })).toThrow(/tag_name/)
    expect(() => parseMlxManifest({ ...MLX, upstream_repo: 'nope' })).toThrow(/upstream_repo/)
    expect(() => parseMlxManifest({ ...MLX, assets: [] })).toThrow(/asset/)
  })

  it('keeps an asset without sha256 visible but not installable', () => {
    const { sha256: _sha, ...bare } = MLX.assets[0]!
    const parsed = parseMlxManifest({ ...MLX, assets: [bare] })
    expect(parsed.assets).toHaveLength(1)
    expect(assetInstallable(parsed.assets[0]!)).toBe(false)
  })
})

describe('asset URLs', () => {
  it('downloads sd.cpp from the mirror, or from the upstream release without the Atomic suffix', () => {
    const manifest = parseSdcppManifest(SDCPP)
    expect(sdcppAssetUrl(manifest, manifest.assets[0]!)).toBe(
      'https://github.com/AtomicBot-ai/atomic-chat-conf/releases/download/master-883-137f740-a36f1b1a/sd-mac.zip'
    )
    const { download_base: _base, ...upstream } = manifest
    expect(sdcppAssetUrl(upstream, manifest.assets[0]!)).toBe(
      'https://github.com/AtomicBot-ai/stable-diffusion.cpp/releases/download/master-883-137f740/sd-mac.zip'
    )
  })

  it('downloads MLX from the release of upstream_repo', () => {
    const manifest = parseMlxManifest(MLX)
    expect(mlxAssetUrl(manifest, manifest.assets[0]!)).toBe(
      'https://github.com/AtomicBot-ai/mlx-vlm/releases/download/mlxvlm-macos-arm64-07ba5a1/mlxvlm-mlx-server-macos-arm64.tar.gz'
    )
  })
})

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-engine-manifest-')
})
afterEach(() => data.cleanup())

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function source<T>(
  kind: 'sd-cpp' | 'mlx',
  respond: (url: string) => Response | Promise<Response>,
  opts: { env?: Record<string, string>; clock?: { now: number } } = {}
) {
  const clock = opts.clock ?? { now: 1_000 }
  const urls: string[] = []
  const proxies: unknown[] = []
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(String(input))
    return respond(String(input))
  }
  const src = new EngineManifestSource<T>(manifestKinds(data.layout)[kind] as never, {
    env: opts.env ?? {},
    fetchFor: (proxy) => {
      proxies.push(proxy ?? null)
      return fetchImpl
    },
    now: () => clock.now,
  })
  return { src, urls, proxies, clock }
}

describe('EngineManifestSource', () => {
  it('reads conf main, caches the accepted document on disk and serves memory until the TTL ends', async () => {
    const { src, urls, clock } = source<SdcppManifest>('sd-cpp', () => json(SDCPP))
    const first = await src.read()
    expect(first).toEqual({
      manifest: parseSdcppManifest(SDCPP),
      source: 'remote',
      fetched_at: 1_000,
      error: null,
    })
    expect(urls).toEqual([SDCPP_MANIFEST_URL])
    const onDisk = JSON.parse(
      await readFile(join(data.layout.diffusion.root, 'sdcpp-manifest.cache.json'), 'utf8')
    )
    expect(onDisk).toEqual({ fetched_at: 1_000, manifest: parseSdcppManifest(SDCPP) })

    clock.now += 10
    expect((await src.read()).fetched_at).toBe(1_000)
    clock.now += ENGINE_MANIFEST_TTL_MS
    await src.read()
    await src.read({ force: true })
    expect(urls).toHaveLength(3)
  })

  it('passes the request proxy to the fetch', async () => {
    const { src, proxies } = source<MlxManifest>('mlx', () => json(MLX))
    const proxy = { url: 'http://proxy.local:3128' }
    await src.read({ proxy })
    expect(proxies).toEqual([proxy])
  })

  it('answers from the disk cache without a network, naming the fetch error', async () => {
    const cacheFile = join(data.layout.provider('mlx').root, 'mlx-manifest.cache.json')
    await mkdir(dirname(cacheFile), { recursive: true })
    await writeFile(cacheFile, JSON.stringify({ fetched_at: 7, manifest: MLX }))
    const { src, urls } = source<MlxManifest>('mlx', () => {
      throw new TypeError('fetch failed')
    })
    const result = await src.read()
    expect(urls).toEqual([MLX_MANIFEST_URL])
    expect(result.manifest?.tag_name).toBe('mlxvlm-macos-arm64-07ba5a1')
    expect(result.source).toBe('cache')
    expect(result.fetched_at).toBe(7)
    expect(result.error).toMatch(/fetch failed/)
  })

  it('answers null with the reason when there is neither a network nor a cache', async () => {
    const { src } = source<MlxManifest>('mlx', () => new Response('nope', { status: 503 }))
    const result = await src.read()
    expect(result).toEqual({
      manifest: null,
      source: null,
      fetched_at: null,
      error: expect.stringMatching(/503/),
    })
  })

  it('keeps the previously accepted document when conf publishes a broken one', async () => {
    let body: unknown = SDCPP
    const { src } = source<SdcppManifest>('sd-cpp', () => json(body))
    await src.read()
    body = { ...SDCPP, tag_name: 'latest' }
    const result = await src.read({ force: true })
    expect(result.manifest?.tag_name).toBe('master-883-137f740-a36f1b1a')
    expect(result.source).toBe('cache')
    expect(result.error).toMatch(/tag_name/)
    const onDisk = JSON.parse(
      await readFile(join(data.layout.diffusion.root, 'sdcpp-manifest.cache.json'), 'utf8')
    )
    expect(onDisk.manifest.tag_name).toBe('master-883-137f740-a36f1b1a')
  })

  it('reads a file:// override without the network, and refuses any other scheme', async () => {
    const file = join(data.root, 'mlx-manifest.json')
    await writeFile(file, JSON.stringify({ ...MLX, published_at: '2026-10-02T00:00:00Z' }))
    const local = source<MlxManifest>('mlx', () => json(MLX), {
      env: { ATOMIC_MLX_MANIFEST_URL: pathToFileURL(file).href },
    })
    const result = await local.src.read()
    expect(local.urls).toEqual([])
    expect(result.manifest?.published_at).toBe('2026-10-02T00:00:00Z')
    expect(result.source).toBe('remote')

    const plain = source<SdcppManifest>('sd-cpp', () => json(SDCPP), {
      env: { ATOMIC_SDCPP_MANIFEST_URL: 'http://example.test/sdcpp.json' },
    })
    const refused = await plain.src.read()
    expect(plain.urls).toEqual([])
    expect(refused.manifest).toBeNull()
    expect(refused.error).toMatch(/file:\/\/ nor https:\/\//)
  })

  it('fetches an https:// override instead of conf main', async () => {
    const url = 'https://example.test/sdcpp-manifest.staging.json'
    const { src, urls } = source<SdcppManifest>('sd-cpp', () => json(SDCPP), {
      env: { ATOMIC_SDCPP_MANIFEST_URL: url },
    })
    await src.read()
    expect(urls).toEqual([url])
  })

  it('reads the cache alone without touching the network', async () => {
    const { src, urls } = source<SdcppManifest>('sd-cpp', () => json(SDCPP))
    expect(await src.cached()).toBeNull()
    await src.read()
    expect((await src.cached())?.tag_name).toBe('master-883-137f740-a36f1b1a')
    expect(urls).toHaveLength(1)
  })
})
