/**
 * The legacy backend index: `atomic-chat-conf/backends/manifest.json`, one upstream tag. Port of
 * the manifest half of `extensions/llamacpp-upstream-extension/src/backend.ts`
 * (`parseManifestForPlatform`, `fetchManifestWithFallbacks`). This core reads the release list
 * (`upstream-releases.ts`) and falls back to this file only when the list is not one it reads; the
 * parser below reads each listed release, and the transports serve every conf manifest.
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
 *   - `getSystemInfo()` becomes `osType` / `arch` parameters.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import { linuxBackendForUpstreamInfix } from './archive.js'
import type { ArchSuffix, BackendOsType, BackendVersion, UpstreamManifest } from '../types.js'

export const LLAMACPP_BACKEND_MANIFEST_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/manifest.json'
export const MANIFEST_FETCH_TIMEOUT_MS = 8_000

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
 * Backends a manifest offers this OS + arch. Windows: the whitelisted `win-*` zips matching the arch
 * (arm64: CPU, OpenCL for Adreno and CUDA 13).
 * Linux: the whitelisted `ubuntu-*` tarballs matching the arch, translated to `linux-*` ids (arm64:
 * CPU, Vulkan and CUDA 13). macOS: only `macos-<arch>`, so an
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
      name === 'win-vulkan-x64' ||
      name === 'win-cpu-arm64' ||
      name === 'win-opencl-adreno-arm64' ||
      /^win-cuda-13\.\d+-arm64$/.test(name)
    for (const asset of assets) {
      const backendName = re.exec(asset.name)?.[1]
      if (!backendName || !isAllowed(backendName)) continue
      if (!backendName.endsWith(`-${archSuffix}`)) continue
      backends.push({ version: tag, backend: backendName, order: 0 })
    }
    return backends
  }

  if (osType === 'linux') {
    const re = new RegExp(`^llama-${escapedTag}-bin-(ubuntu-.+)\\.tar\\.gz$`)
    for (const asset of assets) {
      const infix = re.exec(asset.name)?.[1]
      const backendName = infix ? linuxBackendForUpstreamInfix(infix) : undefined
      if (!backendName || !backendName.endsWith(`-${archSuffix}`)) continue
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
