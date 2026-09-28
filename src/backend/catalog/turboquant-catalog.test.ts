import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { readTurboquantIndexedAsset, TURBOQUANT_RELEASE_INDEX_URL } from '../turboquant.js'
import { TurboquantCatalogService, turboquantReleaseIndexCachePath } from './turboquant-catalog.js'
import type { TurboquantCatalogServiceDeps } from './turboquant-catalog.js'
import {
  TURBOQUANT_LATEST_RELEASE_URL,
  TURBOQUANT_LEGACY_MANIFEST_URL,
  TURBOQUANT_RELEASE_INDEX_TTL_MS,
  turboquantCatalogToBackends,
} from './turboquant-index.js'

const LATEST = 'b10269-1.4.0'
const PREVIOUS = 'b10018-1.3.0'
const TAG_PAGE = `https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/tag/${LATEST}`
const variants = (ids: string[]) =>
  ids.map((id) => ({ id, asset: `llama-turboquant-${id}.${id.startsWith('windows-') ? 'zip' : 'tar.gz'}` }))
const RELEASE_INDEX = {
  schema_version: 1,
  latest: LATEST,
  releases: [
    {
      tag: LATEST,
      prerelease: false,
      variants: variants(['linux-x64-cpu', 'linux-x64-vulkan', 'macos-arm64']),
    },
    { tag: PREVIOUS, prerelease: false, variants: variants(['linux-x64-vulkan', 'macos-arm64']) },
    { tag: 'dev-latest', prerelease: true, variants: variants(['linux-x64-vulkan']) },
  ],
}
const LEGACY_MANIFEST = {
  commit: '5bc5c248d',
  backends: [{ id: 'linux-x64-vulkan', tag: PREVIOUS, asset: 'llama-turboquant-linux-x64-vulkan.tar.gz' }],
}
const LINUX_IDS = ['linux-x64-cpu', 'linux-x64-vulkan']

type Handler = (init?: RequestInit) => Response | Promise<Response>
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } })
/** A fetch that followed the redirect itself and only exposes the landing URL. */
const followed = (url: string) =>
  ({ ok: true, status: 200, url, headers: new Headers(), body: null }) as unknown as Response
const offline = () => {
  throw new Error('offline')
}

let data: TmpDataFolder
let clock: number
let calls: string[]
let proxies: unknown[]
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-tq-catalog-')
  clock = 1_700_000_000_000
  calls = []
  proxies = []
})
afterEach(() => data.cleanup())

function service(routes: Record<string, Handler>, extra: Partial<TurboquantCatalogServiceDeps> = {}) {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push(url)
    const handler = routes[url]
    if (!handler) throw new Error(`unrouted ${url}`)
    return handler(init)
  }
  const log = vi.fn<(level: 'info' | 'warn', message: string) => void>()
  const svc = new TurboquantCatalogService({
    layout: data.layout,
    fetchFor: (proxy) => {
      proxies.push(proxy)
      return fetchImpl
    },
    now: () => clock,
    platform: 'linux',
    timeoutMs: 500,
    log,
    ...extra,
  })
  return { svc, log }
}

describe('turboquantReleaseIndexCachePath', () => {
  it("is the extension's <data>/llamacpp/release-index.cache.json", () => {
    expect(turboquantReleaseIndexCachePath(data.layout)).toBe(
      join(data.root, 'llamacpp', 'release-index.cache.json')
    )
  })
})

describe('TurboquantCatalogService', () => {
  it('resolves the release index, caches it on disk in the shape readTurboquantIndexedAsset reads', async () => {
    const { svc } = service({ [TURBOQUANT_RELEASE_INDEX_URL]: () => json(RELEASE_INDEX) })
    const catalog = await svc.catalog({ appVersion: '1.0.0', supportedIds: LINUX_IDS })
    expect(catalog.source).toBe('index')
    expect(catalog.latest).toBe(LATEST)
    expect(catalog.releases.map((r) => r.tag)).toEqual([LATEST, PREVIOUS])
    expect(turboquantCatalogToBackends(catalog, LINUX_IDS)).toEqual([
      { version: LATEST, backend: 'linux-x64-cpu', order: 0 },
      { version: LATEST, backend: 'linux-x64-vulkan', order: 0 },
      { version: PREVIOUS, backend: 'linux-x64-vulkan', order: 0 },
    ])

    const onDisk = JSON.parse(await readFile(turboquantReleaseIndexCachePath(data.layout), 'utf8'))
    expect(onDisk).toEqual({ fetched_at: clock, catalog })
    expect(await readTurboquantIndexedAsset(data.layout, LATEST, 'linux-x64-vulkan')).toBe(
      'llama-turboquant-linux-x64-vulkan.tar.gz'
    )
    expect(await readTurboquantIndexedAsset(data.layout, PREVIOUS, 'linux-x64-cpu')).toBeUndefined()
  })

  it('serves memory until the TTL, a force, or an invalidate', async () => {
    const { svc } = service({ [TURBOQUANT_RELEASE_INDEX_URL]: () => json(RELEASE_INDEX) })
    const first = await svc.catalog({ supportedIds: LINUX_IDS })
    expect(await svc.catalog({ supportedIds: LINUX_IDS })).toBe(first)
    expect(calls).toHaveLength(1)

    clock += TURBOQUANT_RELEASE_INDEX_TTL_MS - 1
    await svc.catalog({ supportedIds: LINUX_IDS })
    expect(calls).toHaveLength(1)
    clock += 1
    await svc.catalog({ supportedIds: LINUX_IDS })
    expect(calls).toHaveLength(2)

    await svc.catalog({ supportedIds: LINUX_IDS, force: true })
    expect(calls).toHaveLength(3)
    svc.invalidate()
    await svc.catalog({ supportedIds: LINUX_IDS })
    expect(calls).toHaveLength(4)
  })

  it('shares one in-flight fetch between concurrent callers', async () => {
    let release!: (r: Response) => void
    const pending = new Promise<Response>((r) => (release = r))
    const { svc } = service({ [TURBOQUANT_RELEASE_INDEX_URL]: () => pending })
    const a = svc.catalog({ supportedIds: LINUX_IDS })
    const b = svc.catalog({ supportedIds: LINUX_IDS, force: true })
    release(json(RELEASE_INDEX))
    expect(await a).toBe(await b)
    expect(calls).toHaveLength(1)
  })

  it('falls back to the /releases/latest redirect, reading Location under redirect: manual', async () => {
    const { svc } = service({
      [TURBOQUANT_RELEASE_INDEX_URL]: () => json({}, 404),
      [TURBOQUANT_LATEST_RELEASE_URL]: (init) => {
        expect(init?.redirect).toBe('manual')
        return redirect(`/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/tag/${LATEST}`)
      },
    })
    const catalog = await svc.catalog({ supportedIds: ['linux-x64-vulkan', 'linux-x64-rocm'] })
    expect(catalog.source).toBe('redirect')
    expect(catalog.latest).toBe(LATEST)
    expect(turboquantCatalogToBackends(catalog, ['linux-x64-vulkan', 'linux-x64-rocm'])).toEqual([
      { version: LATEST, backend: 'linux-x64-vulkan', order: 0 },
      { version: LATEST, backend: 'linux-x64-rocm', order: 0 },
    ])
    expect(await readTurboquantIndexedAsset(data.layout, LATEST, 'linux-x64-rocm')).toBe(
      'llama-turboquant-linux-x64-rocm.tar.gz'
    )
  })

  it('accepts a fetch that followed the redirect itself and exposes response.url', async () => {
    const { svc } = service({
      [TURBOQUANT_RELEASE_INDEX_URL]: offline,
      [TURBOQUANT_LATEST_RELEASE_URL]: () => followed(TAG_PAGE),
    })
    expect((await svc.catalog({ supportedIds: LINUX_IDS })).source).toBe('redirect')
  })

  it('skips the redirect step with a warning when the fetch exposes neither Location nor url', async () => {
    const { svc, log } = service({
      [TURBOQUANT_RELEASE_INDEX_URL]: offline,
      [TURBOQUANT_LATEST_RELEASE_URL]: () => followed(''),
      [TURBOQUANT_LEGACY_MANIFEST_URL]: () => json(LEGACY_MANIFEST),
    })
    const catalog = await svc.catalog({ supportedIds: LINUX_IDS })
    expect(catalog.source).toBe('legacy-manifest')
    expect(catalog.latest).toBe(PREVIOUS)
    expect(log.mock.calls.some(([level, m]) => level === 'warn' && /without a redirect target/.test(m))).toBe(
      true
    )
  })

  it('refuses a redirect that lands on a prerelease and moves to the legacy manifest', async () => {
    const { svc, log } = service({
      [TURBOQUANT_RELEASE_INDEX_URL]: () => json({}, 404),
      [TURBOQUANT_LATEST_RELEASE_URL]: () =>
        redirect('/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/tag/dev-latest'),
      [TURBOQUANT_LEGACY_MANIFEST_URL]: () => json(LEGACY_MANIFEST),
    })
    expect((await svc.catalog({ supportedIds: LINUX_IDS })).source).toBe('legacy-manifest')
    expect(log.mock.calls.map(([, m]) => m).join('\n')).toMatch(
      /index.json returned 404[\s\S]*non-stable tag 'dev-latest'/
    )
  })

  it('refuses an index written to a schema it cannot read', async () => {
    const { svc } = service({
      [TURBOQUANT_RELEASE_INDEX_URL]: () => json({ ...RELEASE_INDEX, schema_version: 99 }),
      [TURBOQUANT_LATEST_RELEASE_URL]: offline,
      [TURBOQUANT_LEGACY_MANIFEST_URL]: () => json(LEGACY_MANIFEST),
    })
    expect((await svc.catalog({ supportedIds: LINUX_IDS })).source).toBe('legacy-manifest')
  })

  it('serves the last known good index from disk when every source is down', async () => {
    await mkdir(data.layout.provider('llamacpp').root, { recursive: true })
    await writeFile(
      turboquantReleaseIndexCachePath(data.layout),
      JSON.stringify({
        fetched_at: 1,
        catalog: {
          latest: PREVIOUS,
          source: 'index',
          releases: [{ tag: PREVIOUS, prerelease: false, variants: variants(['linux-x64-vulkan']) }],
        },
      })
    )
    const { svc, log } = service({
      [TURBOQUANT_RELEASE_INDEX_URL]: offline,
      [TURBOQUANT_LATEST_RELEASE_URL]: offline,
      [TURBOQUANT_LEGACY_MANIFEST_URL]: offline,
    })
    const catalog = await svc.catalog({ supportedIds: LINUX_IDS })
    expect(catalog.source).toBe('disk-cache')
    expect(turboquantCatalogToBackends(catalog, LINUX_IDS)).toEqual([
      { version: PREVIOUS, backend: 'linux-x64-vulkan', order: 0 },
    ])
    expect(log).toHaveBeenCalledWith('warn', expect.stringMatching(/serving last known good index from disk/))
    // The disk copy is what it was: a failed refresh never rewrites it.
    expect(JSON.parse(await readFile(turboquantReleaseIndexCachePath(data.layout), 'utf8')).fetched_at).toBe(
      1
    )
    // And it is now in memory.
    calls = []
    expect(await svc.catalog({ supportedIds: LINUX_IDS })).toBe(catalog)
    expect(calls).toEqual([])
  })

  it('degrades to an empty catalog when nothing is reachable and no (readable) cache exists', async () => {
    const down = {
      [TURBOQUANT_RELEASE_INDEX_URL]: offline,
      [TURBOQUANT_LATEST_RELEASE_URL]: offline,
      [TURBOQUANT_LEGACY_MANIFEST_URL]: offline,
    }
    expect(await service(down).svc.catalog({ supportedIds: LINUX_IDS })).toEqual({
      latest: null,
      releases: [],
      source: 'none',
    })
    await mkdir(data.layout.provider('llamacpp').root, { recursive: true })
    await writeFile(turboquantReleaseIndexCachePath(data.layout), '{not json')
    const { svc } = service(down)
    expect((await svc.catalog({ supportedIds: LINUX_IDS })).source).toBe('none')
    // An empty answer is not cached: the next call asks again.
    await svc.catalog({ supportedIds: LINUX_IDS })
    expect(calls.length).toBe(9)
  })

  it('hands the request proxy to fetchFor and applies the app version gate', async () => {
    const { svc } = service({
      [TURBOQUANT_RELEASE_INDEX_URL]: () =>
        json({
          ...RELEASE_INDEX,
          releases: [{ ...RELEASE_INDEX.releases[0], min_app_version: '99.0.0' }, RELEASE_INDEX.releases[1]],
        }),
    })
    const proxy = { url: 'http://proxy.local:3128', ignore_ssl: true }
    const catalog = await svc.catalog({ supportedIds: LINUX_IDS, appVersion: '1.2.3', proxy })
    expect(proxies).toEqual([proxy])
    expect(catalog.latest).toBe(PREVIOUS)
    expect(JSON.stringify(catalog)).not.toContain('proxy.local')
  })

  it('gives up on a hanging source within the budget', async () => {
    const { svc } = service(
      {
        [TURBOQUANT_RELEASE_INDEX_URL]: () => new Promise<Response>(() => {}),
        [TURBOQUANT_LATEST_RELEASE_URL]: () => new Promise<Response>(() => {}),
        [TURBOQUANT_LEGACY_MANIFEST_URL]: () => json(LEGACY_MANIFEST),
      },
      { timeoutMs: 20 }
    )
    expect((await svc.catalog({ supportedIds: LINUX_IDS })).source).toBe('legacy-manifest')
  })
})
