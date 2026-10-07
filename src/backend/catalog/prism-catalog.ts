/**
 * The `atomic-prism` release catalog, I/O half: fetches the conf manifest, keeps it in memory for
 * `PRISM_MANIFEST_TTL_MS`, writes the last good copy to `<data>/atomic-prism/manifest.cache.json`
 * and falls back to that copy, then to the bundled baseline, when the network is gone. Concurrent
 * callers share one in-flight fetch. Never throws.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DataLayout } from '../../config/index.js'
import type { BackendCatalogSource, ProxyConfig } from '../../contracts/index.js'
import {
  fetchManifestWithFallbacks,
  MANIFEST_FETCH_TIMEOUT_MS,
  manifestTransportFromFetch,
} from './manifest.js'
import { PRISM_MANIFEST_BASELINE } from './prism-manifest-baseline.js'
import { parsePrismManifest, PRISM_MANIFEST_URL } from './prism-manifest.js'
import type { PrismManifest } from './prism-manifest.js'

export const PRISM_MANIFEST_TTL_MS = 60 * 60 * 1000
export const PRISM_MANIFEST_CACHE_FILE = 'manifest.cache.json'

export interface PrismCatalog {
  manifest: PrismManifest
  source: Extract<BackendCatalogSource, 'live' | 'session-cache' | 'disk-cache' | 'bundled-baseline'>
}

export interface PrismCatalogServiceDeps {
  layout: DataLayout
  fetchFor: (proxy?: ProxyConfig | null) => typeof fetch
  now?: () => number
  timeoutMs?: number
  url?: string
  baseline?: PrismManifest
  log?: (level: 'info' | 'warn', message: string) => void
}

export function prismManifestCachePath(layout: DataLayout): string {
  return join(layout.provider('atomic-prism').root, PRISM_MANIFEST_CACHE_FILE)
}

export class PrismCatalogService {
  private memory: { fetchedAt: number; manifest: PrismManifest } | null = null
  private inFlight: Promise<PrismCatalog> | null = null

  constructor(private readonly deps: PrismCatalogServiceDeps) {}

  invalidate(): void {
    this.memory = null
  }

  async catalog(options: { force?: boolean; proxy?: ProxyConfig | null } = {}): Promise<PrismCatalog> {
    const now = this.deps.now ?? Date.now
    if (!options.force && this.memory && now() - this.memory.fetchedAt < PRISM_MANIFEST_TTL_MS) {
      return { manifest: this.memory.manifest, source: 'session-cache' }
    }
    if (this.inFlight) return this.inFlight
    this.inFlight = this.resolve(options.proxy ?? null).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /** The manifest without touching the network: memory, disk, baseline. For the load gate. */
  async cachedManifest(): Promise<PrismManifest> {
    if (this.memory) return this.memory.manifest
    return (await this.readDiskCache()) ?? this.deps.baseline ?? PRISM_MANIFEST_BASELINE
  }

  private async resolve(proxy: ProxyConfig | null): Promise<PrismCatalog> {
    const now = this.deps.now ?? Date.now
    const url = this.deps.url ?? PRISM_MANIFEST_URL
    try {
      const { response } = await fetchManifestWithFallbacks(
        [manifestTransportFromFetch('core fetch', this.deps.fetchFor(proxy))],
        url,
        this.deps.timeoutMs ?? MANIFEST_FETCH_TIMEOUT_MS
      )
      if (!response.ok) throw new Error(`${url} returned ${response.status}`)
      const manifest = parsePrismManifest(await response.json())
      if (!manifest) throw new Error(`${url} is not a Prism manifest this core understands`)
      this.memory = { fetchedAt: now(), manifest }
      await this.writeDiskCache(manifest, now())
      return { manifest, source: 'live' }
    } catch (err) {
      this.log(
        'warn',
        `[prism-catalog] live manifest unavailable: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    const cached = await this.readDiskCache()
    if (cached) {
      this.memory = { fetchedAt: now(), manifest: cached }
      return { manifest: cached, source: 'disk-cache' }
    }
    return { manifest: this.deps.baseline ?? PRISM_MANIFEST_BASELINE, source: 'bundled-baseline' }
  }

  private async readDiskCache(): Promise<PrismManifest | null> {
    try {
      const raw = JSON.parse(await readFile(prismManifestCachePath(this.deps.layout), 'utf8')) as unknown
      const manifest =
        raw && typeof raw === 'object'
          ? parsePrismManifest((raw as Record<string, unknown>)['manifest'])
          : null
      return manifest
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log('warn', `[prism-catalog] failed to read disk cache: ${String(err)}`)
      }
      return null
    }
  }

  private async writeDiskCache(manifest: PrismManifest, fetchedAt: number): Promise<void> {
    const path = prismManifestCachePath(this.deps.layout)
    const temporary = `${path}.tmp-${process.pid}-${fetchedAt}`
    try {
      await mkdir(this.deps.layout.provider('atomic-prism').root, { recursive: true })
      await writeFile(temporary, JSON.stringify({ fetched_at: fetchedAt, manifest }), 'utf8')
      await rename(temporary, path)
    } catch (err) {
      await rm(temporary, { force: true }).catch(() => {})
      this.log('warn', `[prism-catalog] failed to write disk cache: ${String(err)}`)
    }
  }

  private log(level: 'info' | 'warn', message: string): void {
    this.deps.log?.(level, message)
  }
}
