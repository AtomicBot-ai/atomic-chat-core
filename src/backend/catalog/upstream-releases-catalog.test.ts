import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { LLAMACPP_BACKEND_MANIFEST_URL } from './manifest.js'
import { UPSTREAM_RELEASES_BASELINE } from './upstream-releases-baseline.js'
import {
  UPSTREAM_RELEASES_TTL_MS,
  UpstreamReleasesCatalogService,
  upstreamReleasesCachePath,
} from './upstream-releases-catalog.js'
import { LLAMACPP_UPSTREAM_RELEASES_URL } from './upstream-releases.js'
import type { UpstreamReleaseCatalog } from './upstream-releases.js'

const LIVE: UpstreamReleaseCatalog = {
  schema_version: 1,
  download_base: 'https://mirror.example/releases',
  releases: [
    {
      tag: 'b20000',
      min_core_version: '0.0.0',
      assets: [
        {
          name: 'llama-b20000-bin-macos-arm64.tar.gz',
          sha256: 'a'.repeat(64),
          size: 10,
          validation: 'approved',
        },
      ],
    },
  ],
}
const LEGACY = {
  tag_name: 'b19000',
  download_base: 'https://mirror.example/releases',
  assets: [{ name: 'llama-b19000-bin-macos-arm64.tar.gz', sha256: 'b'.repeat(64), size: 20 }],
}
const LEGACY_AS_LIST: UpstreamReleaseCatalog = {
  schema_version: 1,
  download_base: LEGACY.download_base,
  releases: [
    {
      tag: 'b19000',
      min_core_version: '0.0.0',
      assets: [{ ...LEGACY.assets[0]!, validation: 'approved' }],
    },
  ],
}

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-upstream-releases-')
})
afterEach(() => data.cleanup())

type Respond = (url: string) => Response | Promise<Response>
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const offline: Respond = () => Promise.reject(new Error('offline'))

function service(respond: Respond, extra: { url?: string; clock?: { now: number } } = {}) {
  const clock = extra.clock ?? { now: 1_000 }
  const urls: string[] = []
  const warnings: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(String(input))
    return respond(String(input))
  }
  const svc = new UpstreamReleasesCatalogService({
    layout: data.layout,
    fetchFor: () => fetchImpl,
    now: () => clock.now,
    ...(extra.url ? { url: extra.url } : {}),
    log: (_level, message) => warnings.push(message),
  })
  return { svc, urls, clock, warnings }
}
const routes =
  (table: Record<string, () => Response | Promise<Response>>): Respond =>
  (url) => {
    const handler = table[url]
    if (!handler) throw new Error(`unrouted ${url}`)
    return handler()
  }
const writeDiskCache = async (catalog: unknown) => {
  await mkdir(data.layout.provider('llamacpp-upstream').root, { recursive: true })
  await writeFile(
    upstreamReleasesCachePath(data.layout),
    JSON.stringify({ fetched_at: 1, manifest: catalog })
  )
}

describe('upstreamReleasesCachePath', () => {
  it('lives next to the upstream packs', () => {
    expect(upstreamReleasesCachePath(data.layout)).toBe(
      join(data.layout.provider('llamacpp-upstream').root, 'releases.cache.json')
    )
  })
})

describe('UpstreamReleasesCatalogService', () => {
  it('fetches the live list, writes the disk cache and serves memory until the TTL ends', async () => {
    const { svc, urls, clock } = service(() => json(LIVE))
    expect(await svc.catalog()).toEqual({ catalog: LIVE, source: 'live' })
    expect(urls).toEqual([LLAMACPP_UPSTREAM_RELEASES_URL])
    const cached = JSON.parse(await readFile(upstreamReleasesCachePath(data.layout), 'utf8'))
    expect(cached.manifest).toEqual(LIVE)

    expect(await svc.catalog()).toEqual({ catalog: LIVE, source: 'session-cache' })
    clock.now += UPSTREAM_RELEASES_TTL_MS
    expect((await svc.catalog()).source).toBe('live')
    expect((await svc.catalog({ force: true })).source).toBe('live')
    expect(urls).toHaveLength(3)
  })

  it('shares one in-flight fetch and re-fetches after invalidate()', async () => {
    const { svc, urls } = service(() => json(LIVE))
    await Promise.all([svc.catalog(), svc.catalog(), svc.catalog()])
    expect(urls).toHaveLength(1)
    svc.invalidate()
    await svc.catalog()
    expect(urls).toHaveLength(2)
  })

  it.each([
    ['a 404 (conf has not published the list)', () => json({}, 404)],
    ['a newer schema', () => json({ schema_version: 2, releases: [] })],
    ['a body that is not JSON', () => new Response('<html>captive portal</html>')],
  ])('reads the legacy manifest on %s, and keeps it for the TTL', async (_label, list) => {
    const { svc, urls, warnings } = service(
      routes({ [LLAMACPP_UPSTREAM_RELEASES_URL]: list, [LLAMACPP_BACKEND_MANIFEST_URL]: () => json(LEGACY) })
    )
    expect(await svc.catalog()).toEqual({ catalog: LEGACY_AS_LIST, source: 'legacy-manifest' })
    expect(urls).toEqual([LLAMACPP_UPSTREAM_RELEASES_URL, LLAMACPP_BACKEND_MANIFEST_URL])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/^\[upstream-releases\] release list unavailable: /)
    expect((await svc.catalog()).source).toBe('session-cache')
    // The legacy manifest is never written as the list's last good copy.
    await expect(readFile(upstreamReleasesCachePath(data.layout), 'utf8')).rejects.toThrow()
  })

  it('skips the legacy manifest after a transport failure and serves the disk copy', async () => {
    await writeDiskCache(LIVE)
    const { svc, urls, warnings } = service(offline)
    expect(await svc.catalog()).toEqual({ catalog: LIVE, source: 'disk-cache' })
    expect(urls).toEqual([LLAMACPP_UPSTREAM_RELEASES_URL])
    expect(warnings).toEqual([
      expect.stringMatching(/release list unavailable: All manifest fetch attempts failed/),
    ])
    // Kept in memory: an offline core does not retry on every call.
    expect((await svc.catalog()).source).toBe('session-cache')
  })

  it('falls through a failing legacy manifest to the disk copy', async () => {
    await writeDiskCache(LIVE)
    const { svc, warnings } = service(
      routes({
        [LLAMACPP_UPSTREAM_RELEASES_URL]: () => json({}, 404),
        [LLAMACPP_BACKEND_MANIFEST_URL]: () => json({}, 404),
      })
    )
    expect(await svc.catalog()).toEqual({ catalog: LIVE, source: 'disk-cache' })
    expect(warnings[1]).toBe(
      `[upstream-releases] legacy manifest unavailable: ${LLAMACPP_BACKEND_MANIFEST_URL} returned 404`
    )
  })

  it.each([
    ['offline', offline],
    [
      'a legacy manifest without a tag',
      routes({
        [LLAMACPP_UPSTREAM_RELEASES_URL]: () => json({}, 404),
        [LLAMACPP_BACKEND_MANIFEST_URL]: () => json({ assets: [] }),
      }),
    ],
  ])(
    'serves the bundled baseline on %s with no disk cache, and retries next time',
    async (_label, respond) => {
      const { svc, urls } = service(respond)
      expect(await svc.catalog()).toEqual({ catalog: UPSTREAM_RELEASES_BASELINE, source: 'bundled-baseline' })
      const before = urls.length
      await svc.catalog()
      expect(urls.length).toBeGreaterThan(before)
    }
  )

  it('ignores a disk cache it cannot read and warns about anything but a missing file', async () => {
    await writeDiskCache({ schema_version: 2 })
    const { svc } = service(offline)
    expect((await svc.catalog()).source).toBe('bundled-baseline')

    await writeFile(upstreamReleasesCachePath(data.layout), '{')
    const broken = service(offline)
    expect((await broken.svc.catalog()).source).toBe('bundled-baseline')
    expect(broken.warnings.some((w) => w.includes('failed to read disk cache'))).toBe(true)
  })

  it('warns and still serves the live list when the disk cache cannot be written', async () => {
    // A non-empty folder where the cache file goes: the rename onto it fails on every OS (a
    // read-only folder would not do on Windows, where the mode bits do not stop a write).
    await mkdir(join(upstreamReleasesCachePath(data.layout), 'occupied'), { recursive: true })
    const { svc, warnings } = service(() => json(LIVE))
    expect(await svc.catalog()).toEqual({ catalog: LIVE, source: 'live' })
    expect(warnings.some((w) => w.includes('failed to write disk cache'))).toBe(true)
  })

  it('reads a file:// list from disk (the test hook)', async () => {
    const path = join(data.root, 'releases.json')
    await writeFile(path, JSON.stringify(LIVE))
    const { svc, urls } = service(offline, { url: pathToFileURL(path).href })
    expect(await svc.catalog()).toEqual({ catalog: LIVE, source: 'live' })
    expect(urls).toEqual([])

    // A missing file is a failed read, not an answer: the copy the first read left on disk serves.
    const missing = service(offline, { url: pathToFileURL(join(data.root, 'nope.json')).href })
    expect((await missing.svc.catalog()).source).toBe('disk-cache')
    expect(missing.urls).toEqual([])
  })
})
