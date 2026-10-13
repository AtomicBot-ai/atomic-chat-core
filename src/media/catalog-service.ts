/**
 * The remote media catalog, I/O half: live conf document → memory (`MEDIA_CATALOG_TTL_MS`) →
 * `<data>/atomic-core/media-catalog.cache.json` → the bundled baseline. The newest `catalog_version`
 * of what was found and the baseline wins, so a stale CDN copy never undoes a shipped catalog.
 * `ATOMIC_MEDIA_CATALOG_URL` (a test hook) may name an `https://` or a `file://` document. Concurrent
 * callers share one fetch. Never throws.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MEDIA_CATALOG_BASELINE } from './catalog-baseline.js'
import { MEDIA_CATALOG_URL, parseMediaCatalog } from './catalog.js'
import type { MediaCatalog } from './catalog.js'

export const MEDIA_CATALOG_TTL_MS = 60 * 60 * 1000
export const MEDIA_CATALOG_FETCH_TIMEOUT_MS = 8_000

export type MediaCatalogOrigin = 'live' | 'cache' | 'baseline'

export interface ResolvedMediaCatalog {
  catalog: MediaCatalog
  origin: MediaCatalogOrigin
}

export interface MediaCatalogServiceDeps {
  /** `<data>/atomic-core/media-catalog.cache.json` */
  cachePath: string
  fetch: typeof fetch
  now?: () => number
  url?: string
  baseline?: MediaCatalog
  timeoutMs?: number
  log?: (level: 'info' | 'warn', message: string) => void
}

export class MediaCatalogService {
  private memory: { fetchedAt: number; resolved: ResolvedMediaCatalog } | null = null
  private inFlight: Promise<ResolvedMediaCatalog> | null = null

  constructor(private readonly deps: MediaCatalogServiceDeps) {}

  /** The catalog to offer now; `force` skips the memory copy. */
  async catalog(options: { force?: boolean } = {}): Promise<ResolvedMediaCatalog> {
    const now = this.deps.now ?? Date.now
    if (!options.force && this.memory && now() - this.memory.fetchedAt < MEDIA_CATALOG_TTL_MS)
      return this.memory.resolved
    if (this.inFlight) return this.inFlight
    this.inFlight = this.resolve().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /** Without the network: memory, disk, baseline. */
  async cachedCatalog(): Promise<ResolvedMediaCatalog> {
    if (this.memory) return this.memory.resolved
    return this.newest(await this.readDiskCache(), 'cache')
  }

  private newest(candidate: MediaCatalog | null, origin: MediaCatalogOrigin): ResolvedMediaCatalog {
    const baseline = this.deps.baseline ?? MEDIA_CATALOG_BASELINE
    return candidate && candidate.catalog_version >= baseline.catalog_version
      ? { catalog: candidate, origin }
      : { catalog: baseline, origin: 'baseline' }
  }

  private async fetchDocument(url: string): Promise<unknown> {
    if (url.startsWith('file:')) return JSON.parse(await readFile(fileURLToPath(url), 'utf8')) as unknown
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? MEDIA_CATALOG_FETCH_TIMEOUT_MS)
    try {
      const response = await this.deps.fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'atomic-chat' },
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`${url} returned ${response.status}`)
      return (await response.json()) as unknown
    } finally {
      clearTimeout(timer)
    }
  }

  private async resolve(): Promise<ResolvedMediaCatalog> {
    const now = this.deps.now ?? Date.now
    const url = this.deps.url ?? MEDIA_CATALOG_URL
    try {
      const parsed = parseMediaCatalog(await this.fetchDocument(url))
      if (!parsed) throw new Error(`${url} is not a media catalog this core understands`)
      const resolved = this.newest(parsed, 'live')
      this.memory = { fetchedAt: now(), resolved }
      if (resolved.catalog === parsed) await this.writeDiskCache(parsed, now())
      return resolved
    } catch (err) {
      this.deps.log?.(
        'warn',
        `[media-catalog] live catalog unavailable: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    const resolved = this.newest(await this.readDiskCache(), 'cache')
    this.memory = { fetchedAt: now(), resolved }
    return resolved
  }

  private async readDiskCache(): Promise<MediaCatalog | null> {
    try {
      const raw = JSON.parse(await readFile(this.deps.cachePath, 'utf8')) as unknown
      return raw && typeof raw === 'object'
        ? (parseMediaCatalog((raw as Record<string, unknown>)['catalog']) ?? null)
        : null
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        this.deps.log?.('warn', `[media-catalog] failed to read disk cache: ${String(err)}`)
      return null
    }
  }

  private async writeDiskCache(catalog: MediaCatalog, fetchedAt: number): Promise<void> {
    const path = this.deps.cachePath
    const temporary = `${path}.tmp-${process.pid}-${fetchedAt}`
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(temporary, JSON.stringify({ fetched_at: fetchedAt, catalog }), 'utf8')
      await rename(temporary, path)
    } catch (err) {
      await rm(temporary, { force: true }).catch(() => {})
      this.deps.log?.('warn', `[media-catalog] failed to write disk cache: ${String(err)}`)
    }
  }
}
