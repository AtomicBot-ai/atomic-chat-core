/**
 * The TurboQuant fork's release catalog, I/O half: `fetchStableIndex` of
 * `extensions/llamacpp-extension/src/backend.ts` as a service the advisor owns.
 *
 * Sources are tried in order — the release-asset `index.json`, the `/releases/latest` redirect, the
 * legacy atomic-chat-conf manifest — and the first usable answer wins, is kept in memory for
 * `TURBOQUANT_RELEASE_INDEX_TTL_MS` and written to `<data>/llamacpp/release-index.cache.json` in the
 * exact `{ fetched_at, catalog }` shape the extension wrote, so `readTurboquantIndexedAsset` (and an
 * older app) keep reading it. When every source fails, the last good catalog is read back from disk
 * so an offline launch still sees the releases it saw yesterday; only a cold, never-online install
 * ends up with an empty catalog. Concurrent callers share one in-flight fetch.
 *
 * Seams replaced by injection: the app's three transports become one `fetch` per proxy policy
 * (`fetchFor`), `Date.now` becomes `now`, `IS_WINDOWS` becomes `platform`, `console.*` becomes `log`.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DataLayout } from '../../config/index.js'
import type { ProxyConfig } from '../../contracts/index.js'
import { TURBOQUANT_RELEASE_INDEX_CACHE_FILE, TURBOQUANT_RELEASE_INDEX_URL } from '../turboquant.js'
import {
  fetchManifestWithFallbacks,
  MANIFEST_FETCH_TIMEOUT_MS,
  manifestTransportFromFetch,
  withHardTimeout,
} from './manifest.js'
import {
  catalogFromLatestRedirect,
  EMPTY_TURBOQUANT_CATALOG,
  parseCachedTurboquantCatalog,
  parseLegacyTurboquantManifest,
  parseTurboquantReleaseIndex,
  TURBOQUANT_LATEST_RELEASE_URL,
  TURBOQUANT_LEGACY_MANIFEST_URL,
  TURBOQUANT_RELEASE_INDEX_TTL_MS,
} from './turboquant-index.js'
import type { CachedTurboquantCatalog, TurboquantCatalog } from './turboquant-index.js'

export interface TurboquantCatalogServiceDeps {
  layout: DataLayout
  /** The `fetch` to use for a request carrying this proxy policy (`policyFetchFor` in the core). */
  fetchFor: (proxy?: ProxyConfig | null) => typeof fetch
  now?: () => number
  /** Decides `.zip` vs `.tar.gz` for ids without a platform prefix in the redirect step. */
  platform?: NodeJS.Platform
  /** Per-request budget, the extension's 8 s. */
  timeoutMs?: number
  log?: (level: 'info' | 'warn', message: string) => void
}

export interface TurboquantCatalogOptions {
  /** Bypass the memory TTL (the user asked); the in-flight fetch, if any, is still shared. */
  force?: boolean
  /** The app's version for the `min_app_version` gate; absent or `null` = any. */
  appVersion?: string | null
  /** The ids this host can run; the redirect step synthesises its variants from them. */
  supportedIds: readonly string[]
  proxy?: ProxyConfig | null
}

/** Where the disk copy of the last good index lives, the extension's path. */
export function turboquantReleaseIndexCachePath(layout: DataLayout): string {
  return join(layout.provider('llamacpp').root, TURBOQUANT_RELEASE_INDEX_CACHE_FILE)
}

export class TurboquantCatalogService {
  private memory: CachedTurboquantCatalog | null = null
  private inFlight: Promise<TurboquantCatalog> | null = null

  constructor(private readonly deps: TurboquantCatalogServiceDeps) {}

  /** Drops the cached index so the next read hits the network. */
  invalidate(): void {
    this.memory = null
  }

  /** The catalog of installable stable releases, newest first. Never throws. */
  async catalog(options: TurboquantCatalogOptions): Promise<TurboquantCatalog> {
    const now = this.deps.now ?? Date.now
    const fresh = this.memory !== null && now() - this.memory.fetched_at < TURBOQUANT_RELEASE_INDEX_TTL_MS
    if (!options.force && fresh) return (this.memory as CachedTurboquantCatalog).catalog
    if (this.inFlight) return this.inFlight
    this.inFlight = this.resolve(options).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async resolve(options: TurboquantCatalogOptions): Promise<TurboquantCatalog> {
    const now = this.deps.now ?? Date.now
    const log = this.deps.log ?? (() => {})
    const fetchImpl = this.deps.fetchFor(options.proxy ?? null)
    const timeoutMs = this.deps.timeoutMs ?? MANIFEST_FETCH_TIMEOUT_MS
    const appVersion = options.appVersion ?? null
    const steps: Array<{ label: string; run: () => Promise<TurboquantCatalog | null> }> = [
      {
        label: 'release index',
        run: async () => {
          const { response } = await fetchManifestWithFallbacks(
            [manifestTransportFromFetch('core fetch', fetchImpl)],
            TURBOQUANT_RELEASE_INDEX_URL,
            timeoutMs
          )
          if (!response.ok) throw new Error(`index.json returned ${response.status}`)
          return parseTurboquantReleaseIndex(await response.json(), appVersion, (m) => log('info', m))
        },
      },
      {
        label: '/releases/latest redirect',
        run: async () => {
          const finalUrl = await this.resolveLatestRedirect(fetchImpl, timeoutMs)
          if (finalUrl === null) return null
          return catalogFromLatestRedirect(
            finalUrl,
            options.supportedIds,
            this.deps.platform ?? process.platform
          )
        },
      },
      {
        label: 'legacy conf manifest',
        run: async () => {
          const { response } = await fetchManifestWithFallbacks(
            [manifestTransportFromFetch('core fetch', fetchImpl)],
            TURBOQUANT_LEGACY_MANIFEST_URL,
            timeoutMs
          )
          if (!response.ok) throw new Error(`legacy manifest returned ${response.status}`)
          return parseLegacyTurboquantManifest(await response.json())
        },
      },
    ]

    for (const step of steps) {
      try {
        const catalog = await step.run()
        if (catalog && catalog.releases.length > 0) {
          log(
            'info',
            `[fetchStableIndex] resolved ${catalog.releases.length} stable release(s) via ${step.label}, latest ${catalog.latest}`
          )
          this.memory = { fetched_at: now(), catalog }
          await this.writeDiskCache(this.memory)
          return catalog
        }
      } catch (err) {
        log(
          'warn',
          `[fetchStableIndex] ${step.label} failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }

    const cached = await this.readDiskCache()
    if (cached && cached.catalog.releases.length > 0) {
      log('warn', '[fetchStableIndex] all sources unreachable, serving last known good index from disk')
      const catalog: TurboquantCatalog = { ...cached.catalog, source: 'disk-cache' }
      this.memory = { fetched_at: now(), catalog }
      return catalog
    }

    log('warn', '[fetchStableIndex] no release index available, falling back to local backends only')
    return { ...EMPTY_TURBOQUANT_CATALOG, releases: [] }
  }

  /**
   * The URL `/releases/latest` lands on. The request is made with `redirect: 'manual'` and the
   * `Location` header read, because the core's proxy `fetch` builds its `Response` itself and cannot
   * carry `response.url`; a fetch that followed anyway is read through `response.url`. When neither
   * names a URL the step is skipped with a warning rather than guessed.
   */
  private async resolveLatestRedirect(fetchImpl: typeof fetch, timeoutMs: number): Promise<string | null> {
    const controller = new AbortController()
    const request = fetchImpl(TURBOQUANT_LATEST_RELEASE_URL, {
      headers: { 'Accept': 'text/html', 'User-Agent': 'atomic-chat' },
      redirect: 'manual',
      signal: controller.signal,
    })
    const response = await withHardTimeout(
      request,
      timeoutMs,
      `/releases/latest timed out after ${timeoutMs}ms`
    ).catch((err: unknown) => {
      controller.abort()
      throw err
    })
    await response.body?.cancel().catch(() => {})
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      return new URL(location, TURBOQUANT_LATEST_RELEASE_URL).href
    }
    if (typeof response.url === 'string' && response.url && response.url !== TURBOQUANT_LATEST_RELEASE_URL) {
      return response.url
    }
    this.deps.log?.(
      'warn',
      `[fetchStableIndex] /releases/latest answered ${response.status} without a redirect target; skipping this source`
    )
    return null
  }

  private async readDiskCache(): Promise<CachedTurboquantCatalog | null> {
    try {
      const raw = await readFile(turboquantReleaseIndexCachePath(this.deps.layout), 'utf8')
      return parseCachedTurboquantCatalog(raw)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.deps.log?.('warn', `[fetchStableIndex] failed to read disk cache: ${String(err)}`)
      }
      return null
    }
  }

  private async writeDiskCache(payload: CachedTurboquantCatalog): Promise<void> {
    const path = turboquantReleaseIndexCachePath(this.deps.layout)
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
    try {
      await mkdir(this.deps.layout.provider('llamacpp').root, { recursive: true })
      await writeFile(temporary, JSON.stringify(payload), 'utf8')
      await rename(temporary, path)
    } catch (err) {
      await rm(temporary, { force: true }).catch(() => {})
      this.deps.log?.('warn', `[fetchStableIndex] failed to write disk cache: ${String(err)}`)
    }
  }
}
