/**
 * Archive names, download URLs and the cudart companion. Port of
 * `extensions/llamacpp-upstream-extension/src/backend.ts` (`getBackendArchiveName`,
 * `getBackendDownloadUrl`, `resolveBackendArchiveSource`, `friendlyBackendLabel`,
 * `requiredDiskSpaceForBackend`, `getCudart*`, `getCudaToolkitVersion`). The build-time duplicate
 * in `scripts/resolve-upstream-backend.mjs` (`assetNameFor`, `pickSource`) gives the same answers;
 * `archive.test.ts` proves it so the script can be deleted later.
 *
 * Pure: `resolveBackendArchiveSource` takes the manifest as data instead of fetching it.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import { matchWindowsCudaBackend } from './cuda-family.js'
import type { BackendArchiveSource, UpstreamManifest } from '../types.js'
import { stripBom } from '../version.js'

/**
 * Un-mirrored fallback: the official ggml-org/llama.cpp release stream. Deliberately not the
 * janhq mirror and not the TurboQuant fork.
 */
export const GGML_ORG_DOWNLOAD_BASE = 'https://github.com/ggml-org/llama.cpp/releases/download'

/**
 * Internal Linux backend id → ggml-org asset infix (between `bin-` and `.tar.gz`). Upstream calls
 * its Linux builds `ubuntu-*`; the app surfaces them as `linux-*`. The whitelist is deliberately
 * narrow (`s390x`, `arm64`, `rocm-*`, `openvino-*`, `vulkan-arm64` are dropped).
 */
export const LINUX_UPSTREAM_ASSET_BY_BACKEND: Readonly<Record<string, string>> = {
  'linux-cpu-x64': 'ubuntu-x64',
  'linux-vulkan-x64': 'ubuntu-vulkan-x64',
}

export const LINUX_BACKEND_BY_UPSTREAM_ASSET: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(LINUX_UPSTREAM_ASSET_BY_BACKEND).map(([k, v]) => [v, k])
)

/**
 * `llama-{tag}-bin-{variant}.{tar.gz|zip}`: macOS and Linux tarballs, Windows zips; Linux ids are
 * translated to their `ubuntu-*` infix.
 */
export function getBackendArchiveName(version: string, backend: string): string {
  const tag = stripBom(version)
  const id = stripBom(backend)
  const linuxInfix = LINUX_UPSTREAM_ASSET_BY_BACKEND[id]
  if (linuxInfix) return `llama-${tag}-bin-${linuxInfix}.tar.gz`
  const extension = id.startsWith('macos-') ? 'tar.gz' : 'zip'
  return `llama-${tag}-bin-${id}.${extension}`
}

/**
 * Download URL on the ggml-org CDN — the un-mirrored shape. Download paths should prefer
 * `resolveBackendArchiveSource`. A literal `latest` tag is an unresolved dropdown sentinel that
 * leaked through (ATO-95) and is rejected rather than turned into a guaranteed-404 URL.
 */
export function getBackendDownloadUrl(version: string, backend: string): string {
  const tag = stripBom(version)
  const id = stripBom(backend)
  if (tag === 'latest') {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      `getBackendDownloadUrl: unresolved 'latest' tag for backend '${id}'. The latest/<backend> sentinel must be resolved to a concrete release tag before download.`
    )
  }
  return `${GGML_ORG_DOWNLOAD_BASE}/${tag}/${getBackendArchiveName(tag, id)}`
}

/**
 * Where to download an archive from and what it must hash to. The manifest's `download_base` (the
 * signed mirror) is used only when the manifest describes *this exact tag* and lists *this exact
 * asset* with a hash and size; anything else — an older tag, an unmirrored tag, no manifest —
 * resolves to the ggml-org CDN without a hash.
 */
export function resolveBackendArchiveSource(
  version: string,
  backend: string,
  manifest: UpstreamManifest | null | undefined
): BackendArchiveSource {
  const tag = stripBom(version)
  const archiveName = getBackendArchiveName(tag, backend)
  const fallback: BackendArchiveSource = { url: `${GGML_ORG_DOWNLOAD_BASE}/${tag}/${archiveName}` }
  if (!manifest || manifest.tag_name !== tag || !manifest.download_base) return fallback
  const asset = (manifest.assets ?? []).find((a) => a.name === archiveName)
  if (!asset?.sha256 || !asset.size) return fallback
  return { url: `${manifest.download_base}/${tag}/${archiveName}`, sha256: asset.sha256, size: asset.size }
}

/** Short label for the "Latest <variant>" dropdown entries; the raw id for anything unrecognised. */
export function friendlyBackendLabel(backend: string): string {
  const id = stripBom(backend)
  if (id.endsWith('cpu-x64')) return 'CPU'
  if (id.includes('cuda-13')) return 'CUDA 13'
  if (id.includes('cuda-12')) return 'CUDA 12'
  if (id.includes('rocm')) {
    const version = /rocm-(\d+\.\d+)/.exec(id)?.[1]
    return version ? `ROCm ${version} (~1 GB)` : 'ROCm (~1 GB)'
  }
  if (id.includes('vulkan')) return 'Vulkan'
  if (id === 'macos-arm64') return 'Apple Silicon'
  if (id === 'macos-x64') return 'Intel'
  return id
}

/**
 * Unpacked size of the Windows HIP tree (1072 MB on b10809 / ROCm 10.0; `ggml-hip.dll` alone is
 * 896 MB). The reason a free-space precondition exists at all. Re-measure on the next HIP major.
 */
export const WIN_ROCM_UNPACKED_BYTES = 1080 * 1024 * 1024
/** Headroom over archive + unpacked so the check does not green-light a volume landing at zero. */
export const BACKEND_INSTALL_HEADROOM_BYTES = 200 * 1024 * 1024
/** Archive size used when the manifest carries none (232.9 MB measured for b10809 win-rocm-10.0). */
export const WIN_ROCM_ARCHIVE_BYTES_FALLBACK = 250 * 1024 * 1024

/**
 * Bytes that must be free before downloading `backend`, or `null` when no precondition is
 * warranted (every non-HIP archive unpacks well under 300 MB). The archive counts alongside the
 * unpacked tree because it stays in staging until extraction finishes.
 */
export function requiredDiskSpaceForBackend(backend: string, archiveBytes?: number): number | null {
  const id = stripBom(backend)
  if (!id.includes('rocm')) return null
  const archive = archiveBytes && archiveBytes > 0 ? archiveBytes : WIN_ROCM_ARCHIVE_BYTES_FALLBACK
  return archive + WIN_ROCM_UNPACKED_BYTES + BACKEND_INSTALL_HEADROOM_BYTES
}

/**
 * `cudart-llama-bin-win-cuda-<toolkit>-x64.zip`: the CUDA runtime DLLs the main Windows CUDA
 * archive does not carry. Without them `llama-server.exe --list-devices` is empty on hosts without
 * a system-wide toolkit (Atomic-Chat#14). Never mirrored — NVIDIA-signed and ~391 MB each.
 */
export function buildWindowsCudartArchiveName(cudaToolkitVersion: string): string {
  return `cudart-llama-bin-win-cuda-${cudaToolkitVersion}-x64.zip`
}

/** cudart companion URL on the ggml-org CDN, or `null` for a non-CUDA Windows backend. */
export function getCudartDownloadUrl(version: string, backend: string): string | null {
  const toolkit = matchWindowsCudaBackend(backend)
  if (!toolkit) return null
  return `${GGML_ORG_DOWNLOAD_BASE}/${stripBom(version)}/${buildWindowsCudartArchiveName(toolkit)}`
}

/** cudart companion file name, or `null` for a non-CUDA Windows backend. */
export function getCudartArchiveName(backend: string): string | null {
  const toolkit = matchWindowsCudaBackend(backend)
  return toolkit ? buildWindowsCudartArchiveName(toolkit) : null
}

/** CUDA toolkit version (`"13.3"`) `isCudaInstalled` expects for a Windows CUDA backend, else `null`. */
export function getCudaToolkitVersion(backend: string): string | null {
  return matchWindowsCudaBackend(backend)
}
