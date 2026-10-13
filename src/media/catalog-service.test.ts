import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MEDIA_CATALOG_BASELINE } from './catalog-baseline.js'
import { MediaCatalogService, MEDIA_CATALOG_TTL_MS } from './catalog-service.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-media-catalog-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const newer = (version = MEDIA_CATALOG_BASELINE.catalog_version + 1) => ({
  schema_version: 1,
  catalog_version: version,
  dialects: {},
  providers: {
    acme: {
      image: { api: 'openai-images', models: [{ id: 'm', name: 'M', workflows: ['create'], params: {} }] },
    },
  },
})

function fetchAnswering(body: unknown, status = 200) {
  let calls = 0
  const fetchImpl = (async () => {
    calls += 1
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return { fetch: fetchImpl, calls: () => calls }
}

describe('MediaCatalogService', () => {
  it('takes a newer live catalog, caches it on disk and in memory', async () => {
    const live = fetchAnswering(newer())
    let now = 0
    const service = new MediaCatalogService({
      cachePath: join(dir, 'c.json'),
      fetch: live.fetch,
      now: () => now,
    })
    expect((await service.catalog()).origin).toBe('live')
    expect(Object.keys((await service.catalog()).catalog.providers)).toEqual(['acme'])
    expect(live.calls()).toBe(1)
    now = MEDIA_CATALOG_TTL_MS + 1
    await service.catalog()
    expect(live.calls()).toBe(2)
    expect(JSON.parse(await readFile(join(dir, 'c.json'), 'utf8'))).toMatchObject({
      catalog: { catalog_version: newer().catalog_version },
    })
  })

  it('keeps the baseline over an older live document', async () => {
    const service = new MediaCatalogService({
      cachePath: join(dir, 'c.json'),
      fetch: fetchAnswering(newer(0 + 1)).fetch,
      baseline: { ...MEDIA_CATALOG_BASELINE, catalog_version: 5 },
    })
    expect((await service.catalog()).origin).toBe('baseline')
  })

  it('falls back to the disk cache, then the baseline, when the network fails', async () => {
    await writeFile(join(dir, 'c.json'), JSON.stringify({ fetched_at: 1, catalog: newer() }))
    const down = fetchAnswering({}, 503)
    const cached = new MediaCatalogService({ cachePath: join(dir, 'c.json'), fetch: down.fetch })
    expect((await cached.catalog()).origin).toBe('cache')
    const empty = new MediaCatalogService({ cachePath: join(dir, 'none.json'), fetch: down.fetch })
    expect((await empty.catalog()).origin).toBe('baseline')
    expect((await empty.cachedCatalog()).origin).toBe('baseline')
  })

  it('reads a file:// test hook without the network', async () => {
    const path = join(dir, 'media.json')
    await writeFile(path, JSON.stringify(newer()))
    const offline = fetchAnswering({}, 500)
    const service = new MediaCatalogService({
      cachePath: join(dir, 'c.json'),
      fetch: offline.fetch,
      url: pathToFileURL(path).toString(),
    })
    expect((await service.catalog()).origin).toBe('live')
    expect(offline.calls()).toBe(0)
  })
})
