/**
 * The `llamacpp-upstream` release list, I/O half: fetches conf's release list, keeps it in memory
 * for `UPSTREAM_RELEASES_TTL_MS`, writes the last good copy to
 * `<data>/llamacpp-upstream/releases.cache.json`, and falls back, in order, to:
 *
 *   1. the legacy `backends/manifest.json`, only when the list answered but is not one this core
 *      reads (a 404 before conf publishes it, a newer `schema_version`, a body that is not JSON) —
 *      after a transport failure the legacy fetch would fail the same way, so it is skipped;
 *   2. the disk copy;
 *   3. the bundled baseline.
 *
 * Concurrent callers share one in-flight fetch. Never throws.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DataLayout } from '../../config/index.js'
import type { BackendCatalogSource, ProxyConfig } from '../../contracts/index.js'
import {
  fetchManifestWithFallbacks,
  LLAMACPP_BACKEND_MANIFEST_URL,
  MANIFEST_FETCH_TIMEOUT_MS,
  manifestTransportFromFetch,
} from './manifest.js'
import { UPSTREAM_RELEASES_BASELINE } from './upstream-releases-baseline.js'
import {
  LLAMACPP_UPSTREAM_RELEASES_URL,
  parseUpstreamReleases,
  upstreamCatalogFromLegacyManifest,
} from './upstream-releases.js'
import type { UpstreamReleaseCatalog } from './upstream-releases.js'

export const UPSTREAM_RELEASES_TTL_MS = 60 * 60 * 1000
export const UPSTREAM_RELEASES_CACHE_FILE = 'releases.cache.json'

type ResolvedSource = Extract<
  BackendCatalogSource,
  'live' | 'legacy-manifest' | 'disk-cache' | 'bundled-baseline'
>

export interface UpstreamReleasesCatalog {
  catalog: UpstreamReleaseCatalog
  source: ResolvedSource | Extract<BackendCatalogSource, 'session-cache'>
}

export interface UpstreamReleasesCatalogServiceDeps {
  layout: DataLayout
  fetchFor: (proxy?: ProxyConfig | null) => typeof fetch
  now?: () => number
  timeoutMs?: number
  /** The release list; `file://` is read from disk (the `ATOMIC_LLAMACPP_UPSTREAM_RELEASES_URL` hook). */
  url?: string
  legacyUrl?: string
  baseline?: UpstreamReleaseCatalog
  log?: (level: 'info' | 'warn', message: string) => void
}

export function upstreamReleasesCachePath(layout: DataLayout): string {
  return join(layout.provider('llamacpp-upstream').root, UPSTREAM_RELEASES_CACHE_FILE)
}

type ListRead = { catalog: UpstreamReleaseCatalog } | { answered: boolean; reason: string }

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export class UpstreamReleasesCatalogService {
  private memory: { fetchedAt: number; catalog: UpstreamReleaseCatalog } | null = null
  private inFlight: Promise<UpstreamReleasesCatalog> | null = null

  constructor(private readonly deps: UpstreamReleasesCatalogServiceDeps) {}

  invalidate(): void {
    this.memory = null
  }

  async catalog(
    options: { force?: boolean; proxy?: ProxyConfig | null } = {}
  ): Promise<UpstreamReleasesCatalog> {
    const now = this.deps.now ?? Date.now
    if (!options.force && this.memory && now() - this.memory.fetchedAt < UPSTREAM_RELEASES_TTL_MS) {
      return { catalog: this.memory.catalog, source: 'session-cache' }
    }
    if (this.inFlight) return this.inFlight
    this.inFlight = this.resolve(options.proxy ?? null).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async resolve(proxy: ProxyConfig | null): Promise<UpstreamReleasesCatalog> {
    const now = this.deps.now ?? Date.now
    const remember = (catalog: UpstreamReleaseCatalog, source: ResolvedSource): UpstreamReleasesCatalog => {
      this.memory = { fetchedAt: now(), catalog }
      return { catalog, source }
    }
    const list = await this.readList(proxy)
    if ('catalog' in list) {
      await this.writeDiskCache(list.catalog, now())
      return remember(list.catalog, 'live')
    }
    this.log('warn', `[upstream-releases] release list unavailable: ${list.reason}`)
    if (list.answered) {
      const legacy = await this.readLegacy(proxy)
      if (legacy) return remember(legacy, 'legacy-manifest')
    }
    const cached = await this.readDiskCache()
    if (cached) return remember(cached, 'disk-cache')
    return { catalog: this.deps.baseline ?? UPSTREAM_RELEASES_BASELINE, source: 'bundled-baseline' }
  }

  private async readList(proxy: ProxyConfig | null): Promise<ListRead> {
    const url = this.deps.url ?? LLAMACPP_UPSTREAM_RELEASES_URL
    let text: string
    try {
      if (url.startsWith('file:')) {
        text = await readFile(fileURLToPath(url), 'utf8')
      } else {
        const response = await this.fetch(url, proxy)
        if (!response.ok) return { answered: true, reason: `${url} returned ${response.status}` }
        text = await response.text()
      }
    } catch (err) {
      return { answered: false, reason: message(err) }
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return { answered: true, reason: `${url} is not JSON` }
    }
    const catalog = parseUpstreamReleases(body)
    return catalog ? { catalog } : { answered: true, reason: `${url} is not a release list this core reads` }
  }

  private async readLegacy(proxy: ProxyConfig | null): Promise<UpstreamReleaseCatalog | null> {
    const url = this.deps.legacyUrl ?? LLAMACPP_BACKEND_MANIFEST_URL
    try {
      const response = await this.fetch(url, proxy)
      if (!response.ok) throw new Error(`${url} returned ${response.status}`)
      const catalog = upstreamCatalogFromLegacyManifest(await response.json())
      if (!catalog) throw new Error(`${url} has no tag_name`)
      return catalog
    } catch (err) {
      this.log('warn', `[upstream-releases] legacy manifest unavailable: ${message(err)}`)
      return null
    }
  }

  private async fetch(url: string, proxy: ProxyConfig | null): Promise<Response> {
    const { response } = await fetchManifestWithFallbacks(
      [manifestTransportFromFetch('core fetch', this.deps.fetchFor(proxy))],
      url,
      this.deps.timeoutMs ?? MANIFEST_FETCH_TIMEOUT_MS
    )
    return response
  }

  private async readDiskCache(): Promise<UpstreamReleaseCatalog | null> {
    try {
      const raw = JSON.parse(await readFile(upstreamReleasesCachePath(this.deps.layout), 'utf8')) as unknown
      return raw && typeof raw === 'object'
        ? parseUpstreamReleases((raw as Record<string, unknown>)['manifest'])
        : null
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log('warn', `[upstream-releases] failed to read disk cache: ${String(err)}`)
      }
      return null
    }
  }

  private async writeDiskCache(catalog: UpstreamReleaseCatalog, fetchedAt: number): Promise<void> {
    const path = upstreamReleasesCachePath(this.deps.layout)
    const temporary = `${path}.tmp-${process.pid}-${fetchedAt}`
    try {
      await mkdir(this.deps.layout.provider('llamacpp-upstream').root, { recursive: true })
      await writeFile(temporary, JSON.stringify({ fetched_at: fetchedAt, manifest: catalog }), 'utf8')
      await rename(temporary, path)
    } catch (err) {
      await rm(temporary, { force: true }).catch(() => {})
      this.log('warn', `[upstream-releases] failed to write disk cache: ${String(err)}`)
    }
  }

  private log(level: 'info' | 'warn', text: string): void {
    this.deps.log?.(level, text)
  }
}
