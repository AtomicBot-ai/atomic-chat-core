import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { PrismCatalogService, prismManifestCachePath, PRISM_MANIFEST_TTL_MS } from './prism-catalog.js'
import { PRISM_MANIFEST_BASELINE } from './prism-manifest-baseline.js'
import { PRISM_MANIFEST_URL } from './prism-manifest.js'
import type { PrismManifest } from './prism-manifest.js'

const LIVE: PrismManifest = {
  ...PRISM_MANIFEST_BASELINE,
  updated_at: '2026-12-01T00:00:00Z',
  releases: PRISM_MANIFEST_BASELINE.releases.map((r) => ({ ...r, tag: 'prism-b20000-abcdef0' })),
}

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-prism-catalog-')
})
afterEach(() => data.cleanup())

function service(respond: () => Response | Promise<Response>, clock = { now: 1_000 }) {
  const urls: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(String(input))
    return respond()
  }
  const svc = new PrismCatalogService({
    layout: data.layout,
    fetchFor: () => fetchImpl,
    now: () => clock.now,
  })
  return { svc, urls, clock }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('prismManifestCachePath', () => {
  it('lives next to the Prism packs', () => {
    expect(prismManifestCachePath(data.layout)).toBe(
      join(data.layout.provider('atomic-prism').root, 'manifest.cache.json')
    )
  })
})

describe('PrismCatalogService', () => {
  it('fetches the live manifest, writes the disk cache and serves memory until the TTL ends', async () => {
    const { svc, urls, clock } = service(() => json(LIVE))
    expect(await svc.catalog()).toEqual({ manifest: LIVE, source: 'live' })
    expect(urls).toEqual([PRISM_MANIFEST_URL])
    const cached = JSON.parse(await readFile(prismManifestCachePath(data.layout), 'utf8'))
    expect(cached.manifest).toEqual(LIVE)

    expect((await svc.catalog()).source).toBe('session-cache')
    clock.now += PRISM_MANIFEST_TTL_MS
    expect((await svc.catalog()).source).toBe('live')
    expect((await svc.catalog({ force: true })).source).toBe('live')
    expect(urls).toHaveLength(3)
  })

  it('shares one in-flight fetch', async () => {
    const { svc, urls } = service(() => json(LIVE))
    await Promise.all([svc.catalog(), svc.catalog(), svc.catalog()])
    expect(urls).toHaveLength(1)
  })

  it('falls back to the disk cache when offline', async () => {
    await mkdir(data.layout.provider('atomic-prism').root, { recursive: true })
    await writeFile(prismManifestCachePath(data.layout), JSON.stringify({ fetched_at: 1, manifest: LIVE }))
    const { svc } = service(() => {
      throw new Error('offline')
    })
    expect(await svc.catalog()).toEqual({ manifest: LIVE, source: 'disk-cache' })
  })

  it.each([
    ['offline', () => Promise.reject(new Error('offline'))],
    ['a 500', () => json({}, 500)],
    ['a document this core does not understand', () => json({ schema_version: 2, releases: [] })],
  ])('serves the bundled baseline on %s with no disk cache', async (_label, respond) => {
    const { svc } = service(respond as () => Promise<Response>)
    expect(await svc.catalog()).toEqual({ manifest: PRISM_MANIFEST_BASELINE, source: 'bundled-baseline' })
  })

  it('answers cachedManifest() from memory, disk or baseline without fetching', async () => {
    const { svc, urls } = service(() => json(LIVE))
    expect(await svc.cachedManifest()).toBe(PRISM_MANIFEST_BASELINE)
    await mkdir(data.layout.provider('atomic-prism').root, { recursive: true })
    await writeFile(prismManifestCachePath(data.layout), JSON.stringify({ fetched_at: 1, manifest: LIVE }))
    expect(await svc.cachedManifest()).toEqual(LIVE)
    expect(urls).toEqual([])
    await svc.catalog()
    expect(await svc.cachedManifest()).toEqual(LIVE)
  })

  it('re-fetches after invalidate()', async () => {
    const { svc, urls } = service(() => json(LIVE))
    await svc.catalog()
    svc.invalidate()
    await svc.catalog()
    expect(urls).toHaveLength(2)
  })
})
