/**
 * Backend categories, priority and update checks. Port of the pure policy in
 * `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs` (`get_backend_category`,
 * `prioritize_backends`, `find_latest_version_for_backend`, `check_backend_for_updates`) and of the
 * decision half of `determineBestBackend` in `extensions/llamacpp-upstream-extension/src/index.ts`.
 *
 * Nothing here reads hardware, disk or network: the probe result (`GpuProbeInfo[]`) and the catalog
 * are parameters.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import { mapOldBackendToNew } from '../catalog/index.js'
import type { BackendVersion, BestBackendResult, GpuProbeInfo, UpdateCheckResult } from '../types.js'
import { compareBackendVersionsForSort } from '../version.js'

// ---------------------------------------------------------------------------------------------
// Categories, priority, updates
// ---------------------------------------------------------------------------------------------

/**
 * Coarse category of a backend id for priority ranking and the "already optimal" comparison.
 * ggml-org Windows names first (`cuda-13.` → `cuda-cu13`, `cuda-12.4`), then legacy janhq /
 * TurboQuant names, `rocm`/`hip` before `vulkan` (a host holding both keeps the ROCm tier), the
 * native CPU name, the legacy CPU buckets, and finally the bare arch. `null` for nothing matching.
 * Verbatim quirk: `avx` is tested before `noavx`, so a `noavx` id categorises as `avx`.
 *
 * The app's `index.ts` carries a second, slightly narrower copy of this function (no `rocm`,
 * `arm64`, `x64` buckets → `'unknown'`); this port keeps only the Rust one, so a ROCm
 * recommendation is labelled `rocm` in the cache record where the app wrote `unknown`.
 */
export function getBackendCategory(backend: string): string | null {
  if (backend.includes('cuda-13.')) return 'cuda-cu13'
  if (backend.includes('cuda-12.4')) return 'cuda-cu12.4'
  if (backend.includes('cuda-13-common_cpus') || backend.includes('cu13.0')) return 'cuda-cu13.0'
  if (backend.includes('cuda-12-common_cpus') || backend.includes('cu12.0')) return 'cuda-cu12.0'
  if (backend.includes('cuda-11-common_cpus') || backend.includes('cu11.7')) return 'cuda-cu11.7'
  if (backend.includes('rocm') || backend.includes('hip')) return 'rocm'
  if (backend.includes('vulkan')) return 'vulkan'
  if (backend.startsWith('win-cpu-')) return 'cpu'
  if (backend.includes('common_cpus')) return 'common_cpus'
  if (backend.includes('avx512')) return 'avx512'
  if (backend.includes('avx2')) return 'avx2'
  if (backend.includes('avx') && !backend.includes('avx2') && !backend.includes('avx512')) return 'avx'
  if (backend.includes('noavx')) return 'noavx'
  if (backend.endsWith('arm64')) return 'arm64'
  if (backend.endsWith('x64')) return 'x64'
  return null
}

/** UI label of a category (app `backendCategoryToLabel`); unknown categories pass through. */
export function backendCategoryToLabel(category: string): string {
  switch (category) {
    case 'cuda-cu13':
    case 'cuda-cu13.0':
      return 'CUDA 13'
    case 'cuda-cu12.4':
    case 'cuda-cu12.0':
      return 'CUDA 12'
    case 'cuda-cu11.7':
      return 'CUDA 11'
    case 'vulkan':
      return 'Vulkan'
    default:
      return category
  }
}

const GPU_FIRST_PRIORITIES = [
  'cuda-cu13',
  'cuda-cu13.0',
  'cuda-cu12.4',
  'cuda-cu12.0',
  'cuda-cu11.7',
  'rocm',
  'vulkan',
  'common_cpus',
  'cpu',
  'avx512',
  'avx2',
  'avx',
  'noavx',
  'arm64',
  'x64',
] as const

const LOW_VRAM_PRIORITIES = [
  'cuda-cu13',
  'cuda-cu13.0',
  'cuda-cu12.4',
  'cuda-cu12.0',
  'cuda-cu11.7',
  'common_cpus',
  'cpu',
  'avx512',
  'avx2',
  'avx',
  'noavx',
  'arm64',
  'x64',
  'rocm',
  'vulkan',
] as const

/**
 * Best backend by category priority. CUDA tiers always lead (they carry no VRAM gate); with enough
 * GPU memory ROCm and Vulkan come next, otherwise they rank below every CPU bucket. Within a
 * category the newest build wins. No category matching → the first entry. Empty → `INVALID_ARGUMENT`.
 */
export function prioritizeBackends(
  versionBackends: readonly BackendVersion[],
  hasEnoughGpuMemory: boolean
): BestBackendResult {
  if (versionBackends.length === 0) throw new AtomicCoreError('INVALID_ARGUMENT', 'No backends available')
  const priorities: readonly string[] = hasEnoughGpuMemory ? GPU_FIRST_PRIORITIES : LOW_VRAM_PRIORITIES
  for (const category of priorities) {
    const matching = versionBackends.filter((vb) => getBackendCategory(vb.backend) === category)
    const best = matching.sort(compareBackendVersionsForSort)[0]
    if (best) {
      return {
        backend_string: `${best.version}/${best.backend}`,
        version: best.version,
        backend_type: best.backend,
      }
    }
  }
  const fallback = versionBackends[0] as BackendVersion
  return {
    backend_string: `${fallback.version}/${fallback.backend}`,
    version: fallback.version,
    backend_type: fallback.backend,
  }
}

/**
 * Newest `<version>/<backend>` whose normalised id equals `backendType` (so a legacy id and its
 * current equivalent both match), or `null`. The original backend spelling is kept in the result.
 */
export function findLatestVersionForBackend(
  versionBackends: readonly BackendVersion[],
  backendType: string
): string | null {
  const matching = versionBackends.filter((vb) => mapOldBackendToNew(vb.backend) === backendType)
  const best = matching.sort(compareBackendVersionsForSort)[0]
  return best ? `${best.version}/${best.backend}` : null
}

/**
 * Whether a newer build of the current backend's (normalised) type exists. `new_version` is `"0"`
 * and `target_backend` `null` when nothing newer or nothing at all is listed.
 */
export function checkBackendForUpdates(
  currentBackendString: string,
  versionBackends: readonly BackendVersion[]
): UpdateCheckResult {
  const parts = currentBackendString.split('/')
  if (parts.length !== 2) {
    throw new AtomicCoreError('INVALID_ARGUMENT', `Invalid current backend format: ${currentBackendString}`)
  }
  const effectiveType = mapOldBackendToNew(parts[1] ?? '')
  const target = findLatestVersionForBackend(versionBackends, effectiveType)
  if (target === null || target === currentBackendString) {
    return { update_needed: false, new_version: '0', target_backend: null }
  }
  return { update_needed: true, new_version: target.split('/')[0] ?? '', target_backend: target }
}

/**
 * Smallest GPU worth moving a host off the CPU build for (MiB). Platform-neutral on purpose: ATO-464
 * lowered Linux to 2 GiB with reasoning that is a property of the backend, and Windows kept an
 * inline 6 GiB that told a 4 GB Radeon owner "CPU is optimal" while a 4 GB GeForce got CUDA.
 */
export const GPU_BACKEND_MIN_VRAM_MIB = 2 * 1024

export function hasEnoughGpuMemory(gpus: readonly GpuProbeInfo[]): boolean {
  return gpus.some((g) => (g.total_memory ?? 0) >= GPU_BACKEND_MIN_VRAM_MIB)
}

/** `prioritizeBackends` under the VRAM gate; `''` for an empty catalog (app `determineBestBackend`). */
export function determineBestBackend(
  versionBackends: readonly BackendVersion[],
  gpus: readonly GpuProbeInfo[]
): string {
  if (versionBackends.length === 0) return ''
  return prioritizeBackends(versionBackends, hasEnoughGpuMemory(gpus)).backend_string
}
