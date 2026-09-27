import { describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import {
  catalogFromLatestRedirect,
  compareSemver,
  EMPTY_TURBOQUANT_CATALOG,
  parseCachedTurboquantCatalog,
  parseLegacyTurboquantManifest,
  parseTurboquantReleaseIndex,
  satisfiesMinAppVersion,
  TURBOQUANT_INDEX_SCHEMA_VERSION,
  TURBOQUANT_LATEST_RELEASE_URL,
  TURBOQUANT_LEGACY_MANIFEST_URL,
  TURBOQUANT_RELEASE_INDEX_TTL_MS,
  turboquantCatalogToBackends,
} from './turboquant-index.js'
import type { TurboquantCatalog } from './turboquant-index.js'

// Mirrors the extension's backend.test.ts fixtures.
const LATEST = 'b10269-1.4.0'
const PREVIOUS = 'b10018-1.3.0'
const variants = (ids: string[]) =>
  ids.map((id) => ({
    id,
    asset: `llama-turboquant-${id}.${id.startsWith('windows-') ? 'zip' : 'tar.gz'}`,
  }))
const RELEASE_INDEX = {
  schema_version: 1,
  latest: LATEST,
  releases: [
    {
      tag: LATEST,
      prerelease: false,
      title: `TurboQuant ${LATEST}`,
      highlights: ['DeepSeek V4 Flash support'],
      variants: variants([
        'windows-x64-cpu',
        'windows-x64-cuda-12.4',
        'windows-x64-cuda-13.3',
        'windows-x64-vulkan',
        'linux-x64-cpu',
        'linux-x64-cuda-12.4',
        'linux-x64-cuda-13.3',
        'linux-x64-rocm',
        'linux-x64-vulkan',
        'macos-arm64',
      ]),
    },
    { tag: PREVIOUS, prerelease: false, variants: variants(['linux-x64-vulkan', 'macos-arm64']) },
    { tag: 'dev-latest', prerelease: true, variants: variants(['linux-x64-vulkan', 'macos-arm64']) },
    {
      tag: 'turboquant-linux-x64-vulkan-d86eb0b',
      prerelease: true,
      variants: variants(['linux-x64-vulkan']),
    },
  ],
}
const LEGACY_MANIFEST = {
  commit: '5bc5c248d',
  backends: [
    { id: 'linux-x64-vulkan', tag: PREVIOUS, asset: 'llama-turboquant-linux-x64-vulkan.tar.gz' },
    { id: 'macos-arm64', tag: PREVIOUS, asset: 'llama-turboquant-macos-arm64.tar.gz' },
    { id: 'linux-x64-vulkan', tag: 'dev-latest', asset: 'x' },
    { id: 7, tag: PREVIOUS },
  ],
}

describe('constants', () => {
  it('keeps the URLs, schema and TTL the extension used', () => {
    expect(TURBOQUANT_LATEST_RELEASE_URL).toBe(
      'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/latest'
    )
    expect(TURBOQUANT_LEGACY_MANIFEST_URL).toBe(
      'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/turboquant-manifest.json'
    )
    expect(TURBOQUANT_INDEX_SCHEMA_VERSION).toBe(1)
    expect(TURBOQUANT_RELEASE_INDEX_TTL_MS).toBe(3_600_000)
    expect(EMPTY_TURBOQUANT_CATALOG).toEqual({ latest: null, releases: [], source: 'none' })
  })
})

describe('compareSemver / satisfiesMinAppVersion', () => {
  it.each([
    ['1.3.0', '1.2.0', 1],
    ['1.2.0', '1.2.0', 0],
    ['1.2.9', '1.3.0', -1],
    ['v2.0.0', '1.99.99', 1],
    ['1.3.0-beta.2', '1.3.0', 0],
    ['1.3', '1.3.0', 0],
    ['\uFEFF1.4.0 ', '1.3.0', 1],
    ['x', '0.0.1', -1],
  ])('compareSemver(%j, %j) has the sign of %d', (a, b, sign) => {
    expect(Math.sign(compareSemver(a, b))).toBe(sign)
  })

  it('lets a new enough app through and holds an old one back', () => {
    expect(satisfiesMinAppVersion('1.2.0', '1.3.0')).toBe(true)
    expect(satisfiesMinAppVersion('1.2.0', '1.2.0')).toBe(true)
    expect(satisfiesMinAppVersion('1.3.0', '1.2.9')).toBe(false)
    expect(satisfiesMinAppVersion('1.3.0', '1.3.0-beta.2')).toBe(true)
  })

  it('passes when the requirement or the app version is unknown', () => {
    expect(satisfiesMinAppVersion(undefined, '1.0.0')).toBe(true)
    expect(satisfiesMinAppVersion('not-a-version', '1.0.0')).toBe(true)
    expect(satisfiesMinAppVersion('9.9.9', null)).toBe(true)
    expect(satisfiesMinAppVersion('9.9.9', undefined)).toBe(true)
    expect(satisfiesMinAppVersion(5 as unknown as string, '1.0.0')).toBe(true)
  })
})

describe('parseTurboquantReleaseIndex', () => {
  it('keeps only stable, app-compatible releases with variants, newest first, with the notes', () => {
    const catalog = parseTurboquantReleaseIndex(RELEASE_INDEX, '1.0.0')
    expect(catalog?.source).toBe('index')
    expect(catalog?.latest).toBe(LATEST)
    expect(catalog?.releases.map((r) => r.tag)).toEqual([LATEST, PREVIOUS])
    expect(catalog?.releases[0]).toMatchObject({
      tag: LATEST,
      title: `TurboQuant ${LATEST}`,
      highlights: ['DeepSeek V4 Flash support'],
    })
  })

  it('sorts by the tag, not by document order', () => {
    const shuffled = { releases: [RELEASE_INDEX.releases[1], RELEASE_INDEX.releases[0]] }
    expect(parseTurboquantReleaseIndex(shuffled, null)?.releases.map((r) => r.tag)).toEqual([
      LATEST,
      PREVIOUS,
    ])
  })

  it('hides a release that demands a newer app and keeps the rest, saying so', () => {
    const info = vi.fn()
    const catalog = parseTurboquantReleaseIndex(
      {
        ...RELEASE_INDEX,
        releases: [
          { ...RELEASE_INDEX.releases[0], min_app_version: '99.0.0' },
          { ...RELEASE_INDEX.releases[1], min_app_version: '0.9.0' },
        ],
      },
      '1.0.0',
      info
    )
    expect(catalog?.releases.map((r) => r.tag)).toEqual([PREVIOUS])
    expect(catalog?.latest).toBe(PREVIOUS)
    expect(catalog?.releases[0]?.min_app_version).toBe('0.9.0')
    expect(info).toHaveBeenCalledWith(
      `[fetchStableIndex] skipping ${LATEST}: needs app >= 99.0.0, running 1.0.0`
    )
  })

  it('ignores fields reserved for the split-artifact stage', () => {
    const catalog = parseTurboquantReleaseIndex(
      {
        ...RELEASE_INDEX,
        channels: { nightly: 'dev-latest' },
        releases: [
          {
            ...RELEASE_INDEX.releases[0],
            signing: { keyid: 'unknown-to-this-client' },
            variants: [
              {
                id: 'linux-x64-vulkan',
                asset: 'llama-turboquant-linux-x64-vulkan.tar.gz',
                parts: [{ name: 'part-000', size: 31457280 }],
                requires: { gfx: ['gfx1100'], driver_min: '560.0' },
              },
            ],
          },
        ],
      },
      '1.0.0'
    )
    expect(catalog?.releases[0]?.variants).toEqual([
      {
        id: 'linux-x64-vulkan',
        asset: 'llama-turboquant-linux-x64-vulkan.tar.gz',
        size: undefined,
        sha256: undefined,
      },
    ])
  })

  it('keeps the usable entries of a half-broken index', () => {
    const catalog = parseTurboquantReleaseIndex(
      {
        latest: LATEST,
        releases: [
          { prerelease: false, variants: variants(['linux-x64-vulkan']) },
          { tag: LATEST, prerelease: false, variants: 'not-an-array' },
          { tag: PREVIOUS, prerelease: false, variants: [{ asset: 'x' }] },
          null,
          {
            tag: 'b10300-1.5.0',
            prerelease: false,
            published_at: 42,
            commit: null,
            title: ['not', 'a', 'string'],
            highlights: ['kept', 7, null],
            variants: [{ id: ' linux-x64-vulkan ', asset: 3, size: '10', sha256: 9 }],
          },
        ],
      },
      '1.0.0'
    )
    expect(catalog?.releases).toEqual([
      {
        tag: 'b10300-1.5.0',
        published_at: undefined,
        commit: undefined,
        prerelease: false,
        min_app_version: undefined,
        title: undefined,
        highlights: ['kept'],
        variants: [{ id: 'linux-x64-vulkan', asset: undefined, size: undefined, sha256: undefined }],
      },
    ])
  })

  it('returns null for nothing usable and refuses a schema it cannot read', () => {
    expect(parseTurboquantReleaseIndex({}, null)).toBeNull()
    expect(parseTurboquantReleaseIndex(null, null)).toBeNull()
    expect(parseTurboquantReleaseIndex({ releases: [RELEASE_INDEX.releases[2]] }, null)).toBeNull()
    expect(parseTurboquantReleaseIndex({ ...RELEASE_INDEX, schema_version: 1 }, null)).not.toBeNull()
    expect(parseTurboquantReleaseIndex({ ...RELEASE_INDEX, schema_version: '99' }, null)).not.toBeNull()
    expect(() => parseTurboquantReleaseIndex({ ...RELEASE_INDEX, schema_version: 99 }, null)).toThrow(
      AtomicCoreError
    )
    expect(() => parseTurboquantReleaseIndex({ ...RELEASE_INDEX, schema_version: 99 }, null)).toThrow(
      /schema_version 99 is newer than supported 1/
    )
  })
})

describe('catalogFromLatestRedirect', () => {
  const base = 'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/tag/'
  it('synthesises one release for the supported ids from the asset naming', () => {
    expect(
      catalogFromLatestRedirect(`${base}${LATEST}`, ['linux-x64-vulkan', 'linux-x64-rocm'], 'linux')
    ).toEqual({
      latest: LATEST,
      source: 'redirect',
      releases: [
        {
          tag: LATEST,
          prerelease: false,
          variants: [
            { id: 'linux-x64-vulkan', asset: 'llama-turboquant-linux-x64-vulkan.tar.gz' },
            { id: 'linux-x64-rocm', asset: 'llama-turboquant-linux-x64-rocm.tar.gz' },
          ],
        },
      ],
    })
    expect(
      catalogFromLatestRedirect(`${base}${encodeURIComponent(LATEST)}?x=1#frag`, ['windows-x64-cpu'], 'win32')
        ?.releases[0]?.variants
    ).toEqual([{ id: 'windows-x64-cpu', asset: 'llama-turboquant-windows-x64-cpu.zip' }])
  })
  it('yields null when the host supports nothing, and refuses non-tag or prerelease landings', () => {
    expect(catalogFromLatestRedirect(`${base}${LATEST}`, [])).toBeNull()
    expect(() => catalogFromLatestRedirect('', ['x'])).toThrow(/no final URL/)
    expect(() => catalogFromLatestRedirect('https://github.com/AtomicBot-ai/x/releases', ['x'])).toThrow(
      AtomicCoreError
    )
    expect(() => catalogFromLatestRedirect(`${base}dev-latest`, ['x'])).toThrow(/non-stable tag 'dev-latest'/)
  })
})

describe('parseLegacyTurboquantManifest', () => {
  it('groups stable entries by tag and drops the rest', () => {
    expect(parseLegacyTurboquantManifest(LEGACY_MANIFEST)).toEqual({
      latest: PREVIOUS,
      source: 'legacy-manifest',
      releases: [
        {
          tag: PREVIOUS,
          prerelease: false,
          commit: '5bc5c248d',
          variants: [
            { id: 'linux-x64-vulkan', asset: 'llama-turboquant-linux-x64-vulkan.tar.gz' },
            { id: 'macos-arm64', asset: 'llama-turboquant-macos-arm64.tar.gz' },
          ],
        },
      ],
    })
  })
  it('orders several tags newest first and returns null for nothing stable', () => {
    const two = {
      backends: [
        { id: 'macos-arm64', tag: PREVIOUS },
        { id: 'macos-arm64', tag: LATEST },
      ],
    }
    expect(parseLegacyTurboquantManifest(two)?.releases.map((r) => r.tag)).toEqual([LATEST, PREVIOUS])
    expect(parseLegacyTurboquantManifest(two)?.releases[0]?.variants[0]?.asset).toBeUndefined()
    expect(parseLegacyTurboquantManifest({ backends: [{ id: 'x', tag: 'dev-latest' }] })).toBeNull()
    expect(parseLegacyTurboquantManifest({})).toBeNull()
    expect(parseLegacyTurboquantManifest(undefined)).toBeNull()
  })
})

describe('turboquantCatalogToBackends', () => {
  const catalog = parseTurboquantReleaseIndex(RELEASE_INDEX, '1.0.0') as TurboquantCatalog
  it('returns only index variants the hardware supports, in catalog order', () => {
    expect(turboquantCatalogToBackends(catalog, ['windows-x64-cpu', 'windows-x64-cuda-13.3'])).toEqual([
      { version: LATEST, backend: 'windows-x64-cpu', order: 0 },
      { version: LATEST, backend: 'windows-x64-cuda-13.3', order: 0 },
    ])
    expect(turboquantCatalogToBackends(catalog, ['linux-x64-cuda-11.7', 'linux-x64-vulkan'])).toEqual([
      { version: LATEST, backend: 'linux-x64-vulkan', order: 0 },
      { version: PREVIOUS, backend: 'linux-x64-vulkan', order: 0 },
    ])
    expect(turboquantCatalogToBackends(catalog, ['macos-arm64']).map((b) => b.version)).toEqual([
      LATEST,
      PREVIOUS,
    ])
  })
  it('is empty for an undetectable host or an empty catalog', () => {
    expect(turboquantCatalogToBackends(catalog, [])).toEqual([])
    expect(turboquantCatalogToBackends(EMPTY_TURBOQUANT_CATALOG, ['macos-arm64'])).toEqual([])
  })
})

describe('parseCachedTurboquantCatalog', () => {
  it("reads the extension's { fetched_at, catalog } file and rejects anything else", () => {
    const cached = {
      fetched_at: 5,
      catalog: { latest: PREVIOUS, source: 'index', releases: [{ tag: PREVIOUS, variants: [] }] },
    }
    expect(parseCachedTurboquantCatalog(JSON.stringify(cached))).toEqual(cached)
    expect(parseCachedTurboquantCatalog(`\uFEFF${JSON.stringify(cached)}`)).toEqual(cached)
    expect(parseCachedTurboquantCatalog(JSON.stringify({ catalog: { releases: [] } }))).toEqual({
      fetched_at: 0,
      catalog: { latest: null, releases: [], source: 'none' },
    })
    expect(parseCachedTurboquantCatalog('')).toBeNull()
    expect(parseCachedTurboquantCatalog(null)).toBeNull()
    expect(parseCachedTurboquantCatalog('{')).toBeNull()
    expect(parseCachedTurboquantCatalog('null')).toBeNull()
    expect(parseCachedTurboquantCatalog(JSON.stringify({ catalog: { releases: 'x' } }))).toBeNull()
    expect(parseCachedTurboquantCatalog(JSON.stringify({ fetched_at: 1 }))).toBeNull()
  })
})
