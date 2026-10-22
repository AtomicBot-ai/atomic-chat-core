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
  FOUNDRY_LOCAL_MANIFEST_URL,
  foundryLocalAssetUrl,
  parseFoundryLocalManifest,
  LITERT_LM_MANIFEST_URL,
  parseLiteRtLmManifest,
  SUPPORTED_LITERT_LM_ABI,
} from './manifest.js'
import type { LiteRtLmManifest, MlxManifest, SdcppManifest } from './manifest.js'

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

const FL_ASSET = (platform: string, name: string) => ({ platform, name, size: 100, sha256: 'd'.repeat(64) })
const FL_RELEASE = (tag: string, published_at: string, over: Record<string, unknown> = {}) => ({
  tag,
  published_at,
  min_core_version: '0.18.0',
  c_api_version: 2,
  notes_url: `https://github.com/microsoft/foundry-local/releases/tag/${tag}`,
  assets: [
    FL_ASSET('win-x64', 'foundry-local-win-x64.zip'),
    FL_ASSET('win-arm64', 'foundry-local-win-arm64.zip'),
    FL_ASSET('macos-arm64', 'foundry-local-osx-arm64.tgz'),
    FL_ASSET('linux-x64', 'foundry-local-linux-x64.tgz'),
    FL_ASSET('linux-arm64', 'foundry-local-linux-arm64.tgz'),
  ],
  ...over,
})
const FOUNDRY = (releases: unknown[], over: Record<string, unknown> = {}) => ({
  $schema: './foundry-local-schema.json',
  schema_version: 1,
  upstream_repo: 'microsoft/foundry-local',
  releases,
  ...over,
})
/** A core at 0.18.0 whose host speaks C API 2. */
const FL_HOST = { coreVersion: '0.18.0', cApiVersions: [2] }

describe('parseFoundryLocalManifest', () => {
  it('reads the manifest conf publishes, .tgz archives included, newest release first', () => {
    const parsed = parseFoundryLocalManifest(
      FOUNDRY([FL_RELEASE('v2.1.0', '2026-09-30T00:43:42Z'), FL_RELEASE('v2.0.0', '2026-08-01T00:00:00Z')]),
      FL_HOST
    )
    expect(parsed.upstream_repo).toBe('microsoft/foundry-local')
    expect(parsed.releases.map((release) => release.tag)).toEqual(['v2.1.0', 'v2.0.0'])
    expect(parsed.releases[0]?.assets.find((asset) => asset.platform === 'macos-arm64')).toEqual({
      platform: 'macos-arm64',
      name: 'foundry-local-osx-arm64.tgz',
      size: 100,
      sha256: 'd'.repeat(64),
    })
  })

  it('drops a field it does not know at every level instead of refusing the document', () => {
    const release = { ...FL_RELEASE('v2.1.0', '2026-09-30T00:43:42Z'), channel: 'stable' }
    release.assets = release.assets.map((asset) => ({ ...asset, signature: 'x' }))
    const parsed = parseFoundryLocalManifest(
      FOUNDRY([release], { updated_at: '2026-10-01T00:00:00Z' }),
      FL_HOST
    )
    expect(Object.keys(parsed)).toEqual(['upstream_repo', 'releases'])
    expect(Object.keys(parsed.releases[0] ?? {})).toEqual([
      'tag',
      'published_at',
      'min_core_version',
      'c_api_version',
      'notes_url',
      'assets',
    ])
    expect(Object.keys(parsed.releases[0]?.assets[0] ?? {})).toEqual(['platform', 'name', 'size', 'sha256'])
  })

  it('keeps the first asset of a platform listed twice in a release', () => {
    const release = FL_RELEASE('v2.1.0', '2026-09-30T00:43:42Z')
    release.assets.push(FL_ASSET('linux-x64', 'foundry-local-linux-x64-other.tgz'))
    const assets = parseFoundryLocalManifest(FOUNDRY([release]), FL_HOST).releases[0]?.assets ?? []
    expect(assets.filter((asset) => asset.platform === 'linux-x64')).toEqual([
      FL_ASSET('linux-x64', 'foundry-local-linux-x64.tgz'),
    ])
  })

  it('skips a release for a newer core or a C API this host does not speak, and keeps the rest', () => {
    const parsed = parseFoundryLocalManifest(
      FOUNDRY([
        FL_RELEASE('v3.0.0', '2026-12-01T00:00:00Z', { min_core_version: '0.19.0' }),
        FL_RELEASE('v2.2.0', '2026-11-01T00:00:00Z', { c_api_version: 3 }),
        FL_RELEASE('v2.1.0', '2026-09-30T00:43:42Z'),
      ]),
      FL_HOST
    )
    expect(parsed.releases.map((release) => release.tag)).toEqual(['v2.1.0'])
  })

  it('skips a malformed release or asset instead of refusing the document', () => {
    const badAsset = FL_RELEASE('v2.1.0', '2026-09-30T00:43:42Z')
    badAsset.assets[0] = { platform: 'win-x64', name: '../evil.zip', size: 1, sha256: 'd'.repeat(64) }
    badAsset.assets[1] = {
      platform: 'freebsd-x64',
      name: 'foundry-local-freebsd-x64.tgz',
      size: 1,
      sha256: 'd'.repeat(64),
    }
    badAsset.assets[2] = { platform: 'macos-arm64', name: 'foundry-local-osx-arm64.tgz', size: 1 } as never
    const parsed = parseFoundryLocalManifest(
      FOUNDRY([
        FL_RELEASE('2.3.0', '2026-12-01T00:00:00Z'),
        FL_RELEASE('v2.2.0', 'yesterday'),
        FL_RELEASE('v2.1.5', '2026-11-01T00:00:00Z', { assets: [] }),
        badAsset,
      ]),
      FL_HOST
    )
    expect(parsed.releases.map((release) => release.tag)).toEqual(['v2.1.0'])
    expect(parsed.releases[0]?.assets.map((asset) => asset.platform)).toEqual(['linux-x64', 'linux-arm64'])
  })

  it('refuses a document of another schema version or repository, or with no release this core can install', () => {
    const release = FL_RELEASE('v2.1.0', '2026-09-30T00:43:42Z')
    expect(() => parseFoundryLocalManifest(FOUNDRY([release], { schema_version: 2 }), FL_HOST)).toThrow(
      /schema_version/
    )
    expect(() =>
      parseFoundryLocalManifest(FOUNDRY([release], { upstream_repo: 'not a repo' }), FL_HOST)
    ).toThrow(/upstream_repo/)
    expect(() =>
      parseFoundryLocalManifest(FOUNDRY([release]), { coreVersion: '0.17.0', cApiVersions: [2] })
    ).toThrow(/no release this core can install/)
  })
})

const PYPI = 'https://files.pythonhosted.org/packages/cd/4d/24cd'
const LR_ASSET = (platform: string, tag = 'macosx_12_0_arm64') => ({
  platform,
  url: `${PYPI}/litert_lm_api-0.18.1-py3-none-${tag}.whl`,
  name: `litert_lm_api-0.18.1-py3-none-${tag}.whl`,
  size: 100,
  sha256: 'e'.repeat(64),
})
const LR_OPENVINO = {
  id: 'openvino',
  platform: 'win-x64',
  version: '2026.4.1',
  url: `${PYPI}/openvino-2026.4.1-22982-cp312-cp312-win_amd64.whl`,
  name: 'openvino-2026.4.1-22982-cp312-cp312-win_amd64.whl',
  size: 200,
  sha256: 'f'.repeat(64),
}
const LR_RELEASE = (version: string, published_at: string, over: Record<string, unknown> = {}) => ({
  version,
  published_at,
  min_core_version: '0.18.0',
  abi: 1,
  notes_url: `https://github.com/google-ai-edge/LiteRT-LM/releases/tag/v${version}`,
  assets: [
    LR_ASSET('macos-arm64'),
    LR_ASSET('linux-x64', 'manylinux_2_27_x86_64'),
    LR_ASSET('linux-arm64', 'manylinux_2_27_aarch64'),
    LR_ASSET('win-x64', 'win_amd64'),
  ],
  accelerators: [LR_OPENVINO],
  ...over,
})
const LITERT = (releases: unknown[], over: Record<string, unknown> = {}) => ({
  $schema: './litert-lm-schema.json',
  schema_version: 1,
  releases,
  ...over,
})
const LR_HOST = { coreVersion: '0.18.6', abis: SUPPORTED_LITERT_LM_ABI }

describe('parseLiteRtLmManifest', () => {
  it('reads the manifest conf publishes, wheels and the OpenVINO accelerator, newest release first', () => {
    const parsed = parseLiteRtLmManifest(
      LITERT([LR_RELEASE('0.17.0', '2026-08-01T00:00:00Z'), LR_RELEASE('0.18.1', '2026-10-19T22:44:33Z')]),
      LR_HOST
    )
    expect(parsed.releases.map((release) => release.version)).toEqual(['0.18.1', '0.17.0'])
    expect(parsed.releases[0]?.assets.find((asset) => asset.platform === 'win-x64')).toEqual(
      LR_ASSET('win-x64', 'win_amd64')
    )
    expect(parsed.releases[0]?.accelerators).toEqual([LR_OPENVINO])
    expect(SUPPORTED_LITERT_LM_ABI).toEqual([1])
  })

  it('drops a field it does not know at every level instead of refusing the document', () => {
    const release = { ...LR_RELEASE('0.18.1', '2026-10-19T22:44:33Z'), channel: 'stable' }
    release.assets = release.assets.map((asset) => ({ ...asset, signature: 'x' }))
    release.accelerators = [{ ...LR_OPENVINO, extra: true } as typeof LR_OPENVINO]
    const parsed = parseLiteRtLmManifest(LITERT([release], { updated_at: 'x' }), LR_HOST)
    expect(Object.keys(parsed)).toEqual(['releases'])
    expect(Object.keys(parsed.releases[0] ?? {})).toEqual([
      'version',
      'published_at',
      'min_core_version',
      'abi',
      'notes_url',
      'assets',
      'accelerators',
    ])
    expect(Object.keys(parsed.releases[0]?.assets[0] ?? {})).toEqual([
      'platform',
      'url',
      'name',
      'size',
      'sha256',
    ])
    expect(Object.keys(parsed.releases[0]?.accelerators[0] ?? {})).toEqual([
      'id',
      'platform',
      'version',
      'url',
      'name',
      'size',
      'sha256',
    ])
  })

  it('skips a release for a newer core or an ABI this core does not bind, and keeps the rest', () => {
    const parsed = parseLiteRtLmManifest(
      LITERT([
        LR_RELEASE('0.19.0', '2026-12-01T00:00:00Z', { min_core_version: '0.19.0' }),
        LR_RELEASE('0.18.2', '2026-11-01T00:00:00Z', { abi: 2 }),
        LR_RELEASE('0.18.1', '2026-10-19T22:44:33Z'),
      ]),
      LR_HOST
    )
    expect(parsed.releases.map((release) => release.version)).toEqual(['0.18.1'])
  })

  it('takes a wheel only from files.pythonhosted.org and skips any asset that is not a pinned wheel', () => {
    const release = LR_RELEASE('0.18.1', '2026-10-19T22:44:33Z')
    release.assets[0] = { ...LR_ASSET('macos-arm64'), url: 'https://example.com/litert_lm_api-0.18.1-x.whl' }
    release.assets[1] = { ...LR_ASSET('linux-x64', 'manylinux_2_27_x86_64'), name: '../x.whl' }
    release.assets[2] = { ...LR_ASSET('linux-arm64', 'manylinux_2_27_aarch64'), sha256: undefined as never }
    release.assets.push({ ...LR_ASSET('freebsd-x64'), platform: 'freebsd-x64' })
    release.accelerators = [{ ...LR_OPENVINO, url: 'http://files.pythonhosted.org/openvino.whl' }]
    const parsed = parseLiteRtLmManifest(LITERT([release]), LR_HOST)
    expect(parsed.releases[0]?.assets.map((asset) => asset.platform)).toEqual(['win-x64'])
    expect(parsed.releases[0]?.accelerators).toEqual([])
  })

  it('keeps an accelerator only as the schema has it: openvino on win-x64, once', () => {
    const release = LR_RELEASE('0.18.1', '2026-10-19T22:44:33Z', {
      accelerators: [
        { ...LR_OPENVINO, platform: 'linux-x64' },
        { ...LR_OPENVINO, id: 'cuda' },
        LR_OPENVINO,
        { ...LR_OPENVINO, version: '2027.0.0' },
      ],
    })
    expect(parseLiteRtLmManifest(LITERT([release]), LR_HOST).releases[0]?.accelerators).toEqual([LR_OPENVINO])
    const without = { ...LR_RELEASE('0.18.1', '2026-10-19T22:44:33Z') } as Record<string, unknown>
    delete without['accelerators']
    expect(parseLiteRtLmManifest(LITERT([without]), LR_HOST).releases[0]?.accelerators).toEqual([])
  })

  it('skips a malformed release and refuses a document with no release left or another schema', () => {
    const parsed = parseLiteRtLmManifest(
      LITERT([
        LR_RELEASE('v0.18.2', '2026-11-01T00:00:00Z'),
        LR_RELEASE('0.18.3', 'yesterday'),
        LR_RELEASE('0.18.4', '2026-11-02T00:00:00Z', { abi: 0 }),
        LR_RELEASE('0.18.5', '2026-11-03T00:00:00Z', { assets: [] }),
        LR_RELEASE('0.18.1', '2026-10-19T22:44:33Z'),
      ]),
      LR_HOST
    )
    expect(parsed.releases.map((release) => release.version)).toEqual(['0.18.1'])
    expect(() => parseLiteRtLmManifest(LITERT([], { schema_version: 2 }), LR_HOST)).toThrow(/schema_version/)
    expect(() =>
      parseLiteRtLmManifest(LITERT([LR_RELEASE('0.18.1', '2026-10-19T22:44:33Z', { abi: 9 })]), LR_HOST)
    ).toThrow(/no release this core can install/)
    expect(() => parseLiteRtLmManifest(LITERT('x' as never), LR_HOST)).toThrow(/releases/)
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

  it('downloads Foundry Local from the GitHub release of upstream_repo', () => {
    const manifest = parseFoundryLocalManifest(
      FOUNDRY([FL_RELEASE('v2.1.0', '2026-09-30T00:43:42Z')]),
      FL_HOST
    )
    const release = manifest.releases[0] as NonNullable<(typeof manifest.releases)[number]>
    const asset = release.assets.find((candidate) => candidate.platform === 'linux-x64')
    expect(foundryLocalAssetUrl(manifest, release, asset as NonNullable<typeof asset>)).toBe(
      'https://github.com/microsoft/foundry-local/releases/download/v2.1.0/foundry-local-linux-x64.tgz'
    )
    expect(FOUNDRY_LOCAL_MANIFEST_URL).toBe(
      'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/foundry-local-manifest.json'
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
  kind: 'sd-cpp' | 'mlx' | 'litert-lm',
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

  it('reads the LiteRT-LM manifest from conf main or ATOMIC_LITERT_LM_MANIFEST_URL and caches it under <data>/litert-lm', async () => {
    const doc = LITERT([LR_RELEASE('0.18.1', '2026-10-19T22:44:33Z')])
    const remote = source<LiteRtLmManifest>('litert-lm', () => json(doc))
    expect((await remote.src.read()).manifest?.releases[0]?.version).toBe('0.18.1')
    expect(remote.urls).toEqual([LITERT_LM_MANIFEST_URL])
    expect(LITERT_LM_MANIFEST_URL).toBe(
      'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/litert-lm-manifest.json'
    )
    const cached = JSON.parse(
      await readFile(join(data.layout.provider('litert-lm').root, 'litert-lm-manifest.cache.json'), 'utf8')
    )
    expect(cached.manifest.releases[0].version).toBe('0.18.1')

    const file = join(data.root, 'litert-lm-manifest.json')
    await writeFile(file, JSON.stringify(LITERT([LR_RELEASE('0.18.2', '2026-11-01T00:00:00Z')])))
    const local = source<LiteRtLmManifest>('litert-lm', () => json(doc), {
      env: { ATOMIC_LITERT_LM_MANIFEST_URL: pathToFileURL(file).href },
    })
    expect((await local.src.read()).manifest?.releases[0]?.version).toBe('0.18.2')
    expect(local.urls).toEqual([])
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
