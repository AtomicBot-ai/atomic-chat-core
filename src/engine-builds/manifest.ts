/**
 * The two conf manifests the engine-builds module installs from: `backends/sdcpp-manifest.json`
 * (stable-diffusion.cpp, which the desktop used to read itself) and `backends/mlx-manifest.json`
 * (the mlx-vlm fork's `mlx-server`). Openspec change `move-sdcpp-mlx-install-to-core`, design D6.
 *
 * The source follows the house pattern of `PrismCatalogService` and `cached-document.ts`: conf main
 * over `fetch` with an 8 s budget and the request's proxy, an `ATOMIC_*_MANIFEST_URL` override that
 * may be `https://` or `file://` (anything else is refused, never guessed at), memory for an hour,
 * then the last accepted document on disk. Unlike the PrismML catalog there is no bundled baseline:
 * without a network nothing can be installed anyway, and a baked-in copy goes stale with every conf
 * release. No document at all is an answer (`manifest: null` with the reason), not an error.
 *
 * Parsing checks the fields of the conf schemas and drops keys it does not know, so an additive conf
 * change never makes a released core fall back to its cache. An asset without `sha256` or `size` is
 * kept — the catalog shows it — but `assetInstallable` says no: nothing unverified is executed.
 */

import { mkdir, readFile as nodeReadFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DataLayout } from '../config/index.js'
import type { ProxyConfig } from '../contracts/index.js'
import { withHardTimeout } from '../backend/index.js'

export const SDCPP_MANIFEST_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/sdcpp-manifest.json'
export const MLX_MANIFEST_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/mlx-manifest.json'
export const ENGINE_MANIFEST_TIMEOUT_MS = 8_000
/** A fetched manifest is reused for this long unless the caller forces a re-read. */
export const ENGINE_MANIFEST_TTL_MS = 60 * 60 * 1000
export const SDCPP_UPSTREAM_REPO = 'leejet/stable-diffusion.cpp'

export interface SdcppAsset {
  backend: string
  name: string
  sha256?: string
  size?: number
  /** The Windows CUDA runtime archive, unpacked beside the CUDA build. */
  companion?: boolean
}

export interface SdcppManifest {
  updated_at?: string
  upstream_repo?: string
  /** `master-<n>-<sha>`, `-a<sha>` for a rebuild by the Atomic fork. */
  tag_name: string
  /** The signed mirror; absent, archives come from the upstream release. */
  download_base?: string
  assets: SdcppAsset[]
}

export interface MlxAsset {
  backend: string
  name: string
  sha256?: string
  size?: number
}

export interface MlxManifest {
  upstream_repo: string
  tag_name: string
  /** `publishedAt` of the GitHub release: the only order MLX builds have. */
  published_at: string
  assets: MlxAsset[]
}

const SDCPP_TAG_RE = /^master-[0-9]+-[0-9a-f]{7}(-a[0-9a-f]{7})?$/
const MLX_TAG_RE = /^mlxvlm-macos-arm64-[0-9a-f]{7,40}$/
const BACKEND_ID_RE = /^[a-z0-9.-]+$/
/** A bare file name: it lands in a download path and a URL. */
const ASSET_NAME_RE = /^[A-Za-z0-9._-]+\.(zip|tar\.gz)$/
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SHA256_RE = /^[0-9a-f]{64}$/
/** RFC 3339 with a zone; `Date.parse` alone accepts far more. */
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const ATOMIC_TAG_SUFFIX_RE = /-a[0-9a-f]{7}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A conf date-time this core can order by: RFC 3339 shape and a real calendar date. */
export function isDateTime(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_TIME_RE.test(value)) return false
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return false
  // `Date.parse('2026-02-30T00:00:00Z')` rolls over to March instead of failing.
  const [y, m, d] = value.slice(0, 10).split('-').map(Number) as [number, number, number]
  const day = new Date(Date.UTC(y, m - 1, d))
  return day.getUTCFullYear() === y && day.getUTCMonth() === m - 1 && day.getUTCDate() === d
}

function sanitizeAsset(raw: unknown): SdcppAsset | null {
  if (!isRecord(raw)) return null
  if (typeof raw['backend'] !== 'string' || !BACKEND_ID_RE.test(raw['backend'])) return null
  if (typeof raw['name'] !== 'string' || !ASSET_NAME_RE.test(raw['name'])) return null
  const sha256 = raw['sha256']
  const size = raw['size']
  return {
    backend: raw['backend'],
    name: raw['name'],
    ...(typeof sha256 === 'string' && SHA256_RE.test(sha256) ? { sha256 } : {}),
    ...(typeof size === 'number' && Number.isSafeInteger(size) && size > 0 ? { size } : {}),
    ...(raw['companion'] === true ? { companion: true } : {}),
  }
}

/** Assets that parse, one per backend id; `null` when none is usable. */
function sanitizeAssets(raw: unknown): SdcppAsset[] {
  if (!Array.isArray(raw)) throw new Error('the manifest has no assets array')
  const out: SdcppAsset[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const asset = sanitizeAsset(item)
    if (!asset || seen.has(asset.backend)) continue
    seen.add(asset.backend)
    out.push(asset)
  }
  if (out.length === 0) throw new Error('the manifest lists no usable asset')
  return out
}

/** `backends/sdcpp-manifest.json`, or throw why it is not one. */
export function parseSdcppManifest(data: unknown): SdcppManifest {
  if (!isRecord(data)) throw new Error('the sd.cpp manifest is not an object')
  const tag = data['tag_name']
  if (typeof tag !== 'string' || !SDCPP_TAG_RE.test(tag))
    throw new Error(`the sd.cpp manifest has no valid tag_name (${JSON.stringify(tag)})`)
  const assets = sanitizeAssets(data['assets'])
  const repo = data['upstream_repo']
  const base = data['download_base']
  const updated = data['updated_at']
  return {
    ...(typeof updated === 'string' ? { updated_at: updated } : {}),
    ...(typeof repo === 'string' && REPO_RE.test(repo) ? { upstream_repo: repo } : {}),
    tag_name: tag,
    ...(typeof base === 'string' && /^https:\/\/\S+$/.test(base)
      ? { download_base: base.replace(/\/+$/, '') }
      : {}),
    assets,
  }
}

/** `backends/mlx-manifest.json`, or throw why it is not one. */
export function parseMlxManifest(data: unknown): MlxManifest {
  if (!isRecord(data)) throw new Error('the MLX manifest is not an object')
  const tag = data['tag_name']
  if (typeof tag !== 'string' || !MLX_TAG_RE.test(tag))
    throw new Error(`the MLX manifest has no valid tag_name (${JSON.stringify(tag)})`)
  const repo = data['upstream_repo']
  if (typeof repo !== 'string' || !REPO_RE.test(repo))
    throw new Error(`the MLX manifest has no valid upstream_repo (${JSON.stringify(repo)})`)
  const published = data['published_at']
  // conf's ajv runs without formats (conf ruling 1.2): the date is checked here.
  if (!isDateTime(published))
    throw new Error(`the MLX manifest has no valid published_at (${JSON.stringify(published)})`)
  const assets = sanitizeAssets(data['assets']).map(({ companion: _companion, ...asset }) => asset)
  return { upstream_repo: repo, tag_name: tag, published_at: published, assets }
}

/** An asset core may download and run: pinned by both `sha256` and `size`. */
export function assetInstallable(asset: { sha256?: string; size?: number }): boolean {
  return typeof asset.sha256 === 'string' && typeof asset.size === 'number'
}

/** The mirror when the manifest names one, else the upstream release (which never carries `-a<sha>`). */
export function sdcppAssetUrl(manifest: SdcppManifest, asset: SdcppAsset): string {
  if (manifest.download_base) return `${manifest.download_base}/${manifest.tag_name}/${asset.name}`
  const repo = manifest.upstream_repo ?? SDCPP_UPSTREAM_REPO
  return `https://github.com/${repo}/releases/download/${manifest.tag_name.replace(ATOMIC_TAG_SUFFIX_RE, '')}/${asset.name}`
}

export function mlxAssetUrl(manifest: MlxManifest, asset: MlxAsset): string {
  return `https://github.com/${manifest.upstream_repo}/releases/download/${manifest.tag_name}/${asset.name}`
}

/** Which manifest: everything that differs between the two engines. */
export interface ManifestKind<T> {
  label: string
  url: string
  urlEnv: string
  parse(data: unknown): T
  cacheFile: string
}

export function manifestKinds(layout: DataLayout): {
  'sd-cpp': ManifestKind<SdcppManifest>
  'mlx': ManifestKind<MlxManifest>
} {
  return {
    'sd-cpp': {
      label: 'sd.cpp manifest',
      url: SDCPP_MANIFEST_URL,
      urlEnv: 'ATOMIC_SDCPP_MANIFEST_URL',
      parse: parseSdcppManifest,
      cacheFile: join(layout.diffusion.root, 'sdcpp-manifest.cache.json'),
    },
    'mlx': {
      label: 'MLX manifest',
      url: MLX_MANIFEST_URL,
      urlEnv: 'ATOMIC_MLX_MANIFEST_URL',
      parse: parseMlxManifest,
      cacheFile: join(layout.provider('mlx').root, 'mlx-manifest.cache.json'),
    },
  }
}

/** What a read found. `source` is `null` exactly when `manifest` is. */
export interface ManifestRead<T> {
  manifest: T | null
  source: 'remote' | 'cache' | null
  /** Milliseconds since the epoch at which the document in hand was fetched. */
  fetched_at: number | null
  /** Why the configured source gave nothing acceptable this time; `null` on a fresh read. */
  error: string | null
}

export interface EngineManifestSourceDeps {
  env: Record<string, string | undefined>
  /** A `fetch` honouring the request's proxy policy. */
  fetchFor: (proxy?: ProxyConfig | null) => typeof fetch
  /** Reads a `file://` override. */
  readFile?: (path: string) => Promise<string>
  now?: () => number
  timeoutMs?: number
  log?: (level: 'info' | 'warn', message: string) => void
}

export interface ManifestReadOptions {
  /** Re-read the source even when memory holds a fresh copy. */
  force?: boolean
  proxy?: ProxyConfig | null
}

export class EngineManifestSource<T> {
  /** Only a document the source itself gave; a cache fallback is retried on the next read. */
  private memory: { fetchedAt: number; manifest: T } | null = null
  private inFlight: Promise<ManifestRead<T>> | null = null

  constructor(
    private readonly kind: ManifestKind<T>,
    private readonly deps: EngineManifestSourceDeps
  ) {}

  async read(options: ManifestReadOptions = {}): Promise<ManifestRead<T>> {
    const now = this.deps.now ?? Date.now
    if (!options.force && this.memory && now() - this.memory.fetchedAt < ENGINE_MANIFEST_TTL_MS)
      return {
        manifest: this.memory.manifest,
        source: 'remote',
        fetched_at: this.memory.fetchedAt,
        error: null,
      }
    if (this.inFlight) return this.inFlight
    this.inFlight = this.resolve(options.proxy ?? null).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /** The last accepted document on disk, without touching the source. */
  async cached(): Promise<T | null> {
    return (await this.readCache())?.manifest ?? null
  }

  private sourceUrl(): string {
    const override = this.deps.env[this.kind.urlEnv]?.trim()
    return override ? override : this.kind.url
  }

  private async resolve(proxy: ProxyConfig | null): Promise<ManifestRead<T>> {
    const now = this.deps.now ?? Date.now
    const url = this.sourceUrl()
    let error: string
    try {
      const manifest = this.kind.parse(JSON.parse(await this.fetchText(url, proxy)))
      const fetchedAt = now()
      this.memory = { fetchedAt, manifest }
      await this.writeCache(manifest, fetchedAt)
      return { manifest, source: 'remote', fetched_at: fetchedAt, error: null }
    } catch (e) {
      error = `${this.kind.label} from ${url}: ${e instanceof Error ? e.message : String(e)}`
    }
    const cached = await this.readCache()
    this.deps.log?.(
      'warn',
      `${error}; ${cached ? `using the copy fetched at ${new Date(cached.fetchedAt).toISOString()}` : 'none is cached'}`
    )
    if (!cached) return { manifest: null, source: null, fetched_at: null, error }
    return { manifest: cached.manifest, source: 'cache', fetched_at: cached.fetchedAt, error }
  }

  private async fetchText(url: string, proxy: ProxyConfig | null): Promise<string> {
    if (url.startsWith('file://')) return (this.deps.readFile ?? defaultReadFile)(fileURLToPath(url))
    if (!url.startsWith('https://')) throw new Error('the source is neither file:// nor https://')
    const timeoutMs = this.deps.timeoutMs ?? ENGINE_MANIFEST_TIMEOUT_MS
    const controller = new AbortController()
    const request = this.deps.fetchFor(proxy)(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'atomic-chat' },
      signal: controller.signal,
    })
    const response = await withHardTimeout(request, timeoutMs, `timed out after ${timeoutMs}ms`).catch(
      (e: unknown) => {
        controller.abort()
        throw e
      }
    )
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.text()
  }

  private async readCache(): Promise<{ fetchedAt: number; manifest: T } | null> {
    try {
      const raw = JSON.parse(await (this.deps.readFile ?? defaultReadFile)(this.kind.cacheFile)) as unknown
      if (!isRecord(raw) || typeof raw['fetched_at'] !== 'number') return null
      return { fetchedAt: raw['fetched_at'], manifest: this.kind.parse(raw['manifest']) }
    } catch {
      return null
    }
  }

  /** Write-then-rename; a failure only costs the offline fallback, so it is logged, not thrown. */
  private async writeCache(manifest: T, fetchedAt: number): Promise<void> {
    const path = this.kind.cacheFile
    const temporary = `${path}.tmp-${process.pid}-${fetchedAt}`
    try {
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(temporary, JSON.stringify({ fetched_at: fetchedAt, manifest }), 'utf8')
      await rename(temporary, path)
    } catch (e) {
      await rm(temporary, { force: true }).catch(() => {})
      this.deps.log?.('warn', `Could not cache the ${this.kind.label}: ${String(e)}`)
    }
  }
}

const defaultReadFile = (path: string): Promise<string> => nodeReadFile(path, 'utf8')
