/**
 * The backend index: `atomic-chat-conf/backends/manifest.json`. Port of the manifest half of
 * `extensions/llamacpp-upstream-extension/src/backend.ts` (`parseManifestForPlatform`,
 * `fetchManifestWithFallbacks`, `fetchLiveManifest`, `fetchRemoteBackends`).
 *
 * Why a static manifest and not the GitHub API: the unauthenticated API limit (60 req/hr/IP)
 * dead-ended fresh installs on shared/NAT/VPN networks (ATO-199). raw.githubusercontent.com has no
 * per-IP limit and the manifest mirrors the release shape, so the parser is unchanged. Archives come
 * from the manifest's `download_base` (our signed mirror) or, for an unmirrored tag, the ggml-org CDN.
 *
 * Seams replaced by injection:
 *   - the app's four transports (Rust HTTP/1.1 reqwest, WebView `globalThis.fetch`, proxy-aware and
 *     direct `@tauri-apps/plugin-http`) become a `ManifestTransport[]`; the core passes one built
 *     from its own `fetch` via `manifestTransportFromFetch`. Order is preserved as documentation —
 *     the app raced all four with `Promise.any`, and so does `fetchManifestWithFallbacks`.
 *   - the module-level `_cachedManifest` becomes a `ManifestSessionCache` the caller owns.
 *   - `getSystemInfo()` becomes `osType` / `arch` parameters.
 *   - `console.*` becomes optional `onInfo` / `onWarn` callbacks.
 */

import { AtomicCoreError } from '../contracts/index.js'
import { LINUX_BACKEND_BY_UPSTREAM_ASSET } from './archive.js'
import { BUNDLED_MANIFEST_BASELINE } from './bundled-manifest-baseline.js'
import type { ArchSuffix, BackendOsType, BackendVersion, UpstreamManifest } from './types.js'

export const LLAMACPP_BACKEND_MANIFEST_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/manifest.json'
export const MANIFEST_FETCH_TIMEOUT_MS = 8_000

/**
 * Tag of the bundled offline baseline. NOT a pin: a live manifest carrying a newer tag is followed
 * as-is, which is what lets an engine update reach users without an app release.
 */
export const BUNDLED_BASELINE_TAG = BUNDLED_MANIFEST_BASELINE.tag_name

/** One way of fetching the manifest; `timeoutMs` is the hard budget the transport should honour. */
export type ManifestFetch = (url: string, timeoutMs: number) => Promise<Response>

export interface ManifestTransport {
  label: string
  fetch: ManifestFetch
}

/** `x86_64` / `x64` → `x64`; `aarch64` / `arm64` → `arm64`. */
export function archSuffixFor(arch: string): ArchSuffix {
  return arch.includes('aarch64') || arch.includes('arm64') ? 'arm64' : 'x64'
}

export function isSupportedBackendOs(osType: string): osType is BackendOsType {
  return osType === 'windows' || osType === 'linux' || osType === 'macos'
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Backends a manifest offers this OS + arch. Windows: the whitelisted `win-*` zips matching the arch.
 * Linux: x64 only, `ubuntu-*` tarballs translated to `linux-*` ids. macOS: only `macos-<arch>`, so an
 * Intel host is never offered the arm64 build the manifest lists (macOS is passed through
 * `listSupportedBackends` unfiltered, so the arch filter has to happen here). Every entry has
 * `order: 0` — a manifest entry never outranks an installed one by install time.
 */
export function parseManifestForPlatform(
  release: UpstreamManifest,
  osType: string,
  archSuffix: ArchSuffix
): BackendVersion[] {
  const tag = release.tag_name
  if (!tag) return []
  const assets = release.assets ?? []
  const escapedTag = escapeRegExp(tag)
  const backends: BackendVersion[] = []

  if (osType === 'windows') {
    const re = new RegExp(`^llama-${escapedTag}-bin-(win-.+)\\.zip$`)
    const isAllowed = (name: string): boolean =>
      name === 'win-cpu-x64' ||
      /^win-cuda-12\.\d+-x64$/.test(name) ||
      /^win-cuda-13\.\d+-x64$/.test(name) ||
      /^win-rocm-\d+\.\d+-x64$/.test(name) ||
      name === 'win-vulkan-x64'
    for (const asset of assets) {
      const backendName = re.exec(asset.name)?.[1]
      if (!backendName || !isAllowed(backendName)) continue
      if (!backendName.endsWith(`-${archSuffix}`)) continue
      backends.push({ version: tag, backend: backendName, order: 0 })
    }
    return backends
  }

  if (osType === 'linux') {
    if (archSuffix !== 'x64') return []
    const re = new RegExp(`^llama-${escapedTag}-bin-(ubuntu-.+)\\.tar\\.gz$`)
    for (const asset of assets) {
      const infix = re.exec(asset.name)?.[1]
      const backendName = infix ? LINUX_BACKEND_BY_UPSTREAM_ASSET[infix] : undefined
      if (!backendName) continue
      backends.push({ version: tag, backend: backendName, order: 0 })
    }
    return backends
  }

  if (osType === 'macos') {
    const re = new RegExp(`^llama-${escapedTag}-bin-(macos-.+)\\.tar\\.gz$`)
    for (const asset of assets) {
      const backendName = re.exec(asset.name)?.[1]
      if (backendName !== `macos-${archSuffix}`) continue
      backends.push({ version: tag, backend: backendName, order: 0 })
    }
    return backends
  }

  return []
}

/**
 * Hard `Promise` timeout around a transport. The app needed this because some `plugin-http` paths
 * ignored `AbortSignal`, letting the outer 20 s detection guard fire first; a core transport built on
 * `fetch` may honour the signal but the belt-and-braces guard costs nothing.
 */
export function withHardTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => {
    handle = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (handle !== undefined) clearTimeout(handle)
  })
}

/** A transport over a `fetch`-compatible function with an abort-on-timeout and the app's headers. */
export function manifestTransportFromFetch(
  label: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string> = { 'Accept': 'application/json', 'User-Agent': 'atomic-chat' }
): ManifestTransport {
  return {
    label,
    fetch: (url, timeoutMs) => {
      const controller = new AbortController()
      const request = fetchImpl(url, { headers, signal: controller.signal })
      return withHardTimeout(request, timeoutMs, `${label} timed out after ${timeoutMs}ms`).catch(
        (err: unknown) => {
          controller.abort()
          throw err
        }
      )
    },
  }
}

/**
 * Race every transport (`Promise.any`) and return the first response, labelled. All failing raises
 * `IO_ERROR` whose message carries each transport's reason, labelled, so a log line explains which
 * path stalled (ATO-243: the Linux h2 stall against Fastly).
 */
export async function fetchManifestWithFallbacks(
  transports: readonly ManifestTransport[],
  url: string = LLAMACPP_BACKEND_MANIFEST_URL,
  timeoutMs: number = MANIFEST_FETCH_TIMEOUT_MS
): Promise<{ label: string; response: Response }> {
  if (transports.length === 0) {
    throw new AtomicCoreError('IO_ERROR', 'All manifest fetch attempts failed: no transports configured')
  }
  const wrapped = transports.map(({ label, fetch }) =>
    Promise.resolve()
      .then(() => fetch(url, timeoutMs))
      .then((response) => ({ label, response }))
      .catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err)
        throw new Error(`${label}: ${reason}`)
      })
  )
  try {
    return await Promise.any(wrapped)
  } catch (aggregate) {
    const reasons =
      aggregate instanceof AggregateError
        ? aggregate.errors.map((e) => (e instanceof Error ? e.message : String(e))).join(' | ')
        : aggregate instanceof Error
          ? aggregate.message
          : String(aggregate)
    throw new AtomicCoreError('IO_ERROR', `All manifest fetch attempts failed: ${reasons}`)
  }
}

/**
 * In-memory manifest for one session. Populated ONLY by a genuinely successful live fetch, so a
 * later transient stall can reuse the last good manifest. The bundled baseline is never stored:
 * caching it would pin the session to a stale snapshot even after the network recovers (the
 * ATO-243 cache-poisoning regression).
 */
export class ManifestSessionCache {
  private manifest: UpstreamManifest | null = null

  get(): UpstreamManifest | null {
    return this.manifest
  }

  set(manifest: UpstreamManifest): void {
    this.manifest = manifest
  }

  clear(): void {
    this.manifest = null
  }
}

export interface FetchLiveManifestOptions {
  transports: readonly ManifestTransport[]
  cache: ManifestSessionCache
  url?: string
  timeoutMs?: number
  onInfo?: (message: string) => void
  onWarn?: (message: string) => void
}

/**
 * Fetch the live manifest and cache it for the session, or `null` when it could not be obtained
 * (transport failure, non-2xx, unparseable body, missing `tag_name`). Callers fall back to
 * `BUNDLED_MANIFEST_BASELINE` themselves, keeping the "baseline is never cached" invariant visible.
 * A tag differing from the bundled baseline is followed: the manifest is authoritative.
 */
export async function fetchLiveManifest(options: FetchLiveManifestOptions): Promise<UpstreamManifest | null> {
  const url = options.url ?? LLAMACPP_BACKEND_MANIFEST_URL
  const info = options.onInfo ?? (() => {})
  const warn = options.onWarn ?? (() => {})
  try {
    info(`[fetchRemoteBackends] Fetching ${url}...`)
    const { label, response } = await fetchManifestWithFallbacks(options.transports, url, options.timeoutMs)
    info(`[fetchRemoteBackends] Manifest fetch succeeded via ${label}`)
    if (!response.ok) {
      warn(
        `[fetchRemoteBackends] Backend manifest returned ${response.status}; using bundled baseline (not cached, will retry next call)`
      )
      return null
    }
    const release = (await response.json()) as UpstreamManifest
    if (!release || typeof release.tag_name !== 'string' || !release.tag_name) {
      warn(
        '[fetchRemoteBackends] Manifest missing tag_name; using bundled baseline (not cached, will retry next call)'
      )
      return null
    }
    if (release.tag_name !== BUNDLED_BASELINE_TAG) {
      info(
        `[fetchRemoteBackends] Manifest tag ${release.tag_name} differs from the bundled baseline ${BUNDLED_BASELINE_TAG}; following the manifest`
      )
    }
    options.cache.set(release)
    return release
  } catch (err) {
    warn(
      `[fetchRemoteBackends] All manifest fetch transports failed; falling back to bundled baseline (not cached, will retry next call). ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return null
  }
}

export interface FetchRemoteBackendsOptions extends FetchLiveManifestOptions {
  osType: string
  arch: string
  /** "Check for engine updates": drop the session cache so a tag published meanwhile is seen. */
  force?: boolean
  /** Offline fallback; defaults to the compiled-in baseline. */
  baseline?: UpstreamManifest
}

/**
 * Backend builds available to this host: the session-cached manifest, else a live fetch, else the
 * bundled baseline. Never throws and never returns the baseline through the cache. `[]` for an OS
 * outside windows/linux/macos, for Linux on arm64 and for an Intel Mac.
 */
export async function fetchRemoteBackends(options: FetchRemoteBackendsOptions): Promise<BackendVersion[]> {
  const { osType, arch, cache } = options
  if (!isSupportedBackendOs(osType)) return []
  const archSuffix = archSuffixFor(arch)
  const info = options.onInfo ?? (() => {})

  if (options.force) {
    cache.clear()
  } else {
    const cached = cache.get()
    if (cached) {
      info('[fetchRemoteBackends] Using in-memory manifest cache')
      return parseManifestForPlatform(cached, osType, archSuffix)
    }
  }

  const live = await fetchLiveManifest(options)
  if (!live)
    return parseManifestForPlatform(options.baseline ?? BUNDLED_MANIFEST_BASELINE, osType, archSuffix)

  const backends = parseManifestForPlatform(live, osType, archSuffix)
  info(
    `[fetchRemoteBackends] Found ${backends.length} remote backends for ${osType}-${archSuffix}: ${backends
      .map((b) => b.backend)
      .join(', ')}`
  )
  return backends
}
