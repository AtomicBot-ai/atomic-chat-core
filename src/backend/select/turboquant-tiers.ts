/**
 * Ideal-backend detection and update check for the TurboQuant fork (`llamacpp` provider). Port of
 * the decision half of `detectIdealBackendType` in `extensions/llamacpp-extension/src/index.ts` and
 * of `find_latest_version_for_backend` / `check_backend_for_updates` in
 * `src-tauri/plugins/tauri-plugin-llamacpp/src/backend.rs`.
 *
 * Why it cannot share `tiers.ts`: the fork names its builds differently, publishes Linux CUDA and
 * ROCm builds upstream does not, keeps a 6 GiB VRAM floor where upstream went to 2 GiB, and runs no
 * `--list-devices` tier probe. Nothing here reads hardware, disk or network: the facts and the
 * catalog are parameters.
 */

import type { BackendVersion, GpuProbeInfo, IdealBackendResult, UpdateCheckResult } from '../types.js'
import { AtomicCoreError } from '../../contracts/index.js'
import {
  compareTurboquantBackendsForSort,
  getTurboquantSupportedFeatures,
  mapOldTurboquantBackendToNew,
  TURBOQUANT_GPU_MIN_VRAM_MIB,
} from '../turboquant.js'
import type { RocmHostProbe } from '../turboquant.js'
import { stripBom } from '../version.js'
import { normalizeFeatures } from './features.js'
import { integratedGpuOnly } from './tiers.js'

/** The fork's "any GPU backend in the catalog" test — broader than upstream's, it matches every id. */
export function isTurboquantGpuBackendId(backend: string): boolean {
  return /(cuda-\d|vulkan|rocm)/.test(stripBom(backend))
}

export interface DetectIdealTurboquantBackendInput {
  osType: string
  arch: string
  cpuExtensions: readonly string[]
  gpus: readonly GpuProbeInfo[]
  /** Linux only: the amdkfd / HIP facts behind `features.rocm`; absent = ROCm unsupported. */
  rocm?: RocmHostProbe
  /** The hardware-gated catalog (`listSupportedBackends`); only consulted on Windows and Linux. */
  listAvailableBackends: () => Promise<BackendVersion[]>
  onWarn?: (message: string) => void
}

/**
 * Which fork build this host should ideally run. Windows: CUDA 13 → CUDA 12 → Vulkan (6 GiB, not
 * integrated-only). Linux x64: CUDA 13 → CUDA 12 → ROCm → Vulkan (ROCm and Vulkan share the VRAM
 * and integrated guards). Every pick is a catalog entry, so the id is one the release stream carries.
 * A GPU-capable host whose catalog has no GPU build is `detection-failed` (the release index was
 * unreachable); macOS, arm64 and hosts without a usable tier are `cpu-optimal`. Any thrown error is
 * `detection-failed`. The caller wraps this in its 20 s timeout.
 */
export async function detectIdealTurboquantBackendType(
  input: DetectIdealTurboquantBackendInput
): Promise<IdealBackendResult> {
  const warn = input.onWarn ?? (() => {})
  try {
    const { osType, gpus } = input
    const features = normalizeFeatures(
      getTurboquantSupportedFeatures(osType, input.cpuExtensions, gpus, input.rocm)
    )
    const hasEnoughVram = gpus.some((gpu) => (gpu.total_memory ?? 0) >= TURBOQUANT_GPU_MIN_VRAM_MIB)
    const integratedOnly = integratedGpuOnly(gpus)
    const archSuffix = input.arch.includes('aarch64') || input.arch.includes('arm64') ? 'arm64' : 'x64'

    if (osType !== 'windows' && osType !== 'linux') return { kind: 'cpu-optimal' }

    const catalog = await input.listAvailableBackends()
    const pick = (pattern: RegExp): string | null => {
      const hit = catalog.find((b) => pattern.test(stripBom(b.backend)))
      return hit ? stripBom(hit.backend) : null
    }
    const anyGpuBackendAvailable = catalog.some((b) => isTurboquantGpuBackendId(b.backend))

    if (osType === 'windows') {
      const cuda13 = pick(new RegExp(`^windows-${archSuffix}-cuda-13(\\.\\d+)?$`))
      const cuda12 = pick(new RegExp(`^windows-${archSuffix}-cuda-12(\\.\\d+)?$`))
      const vulkan = pick(new RegExp(`^windows-${archSuffix}-vulkan$`))

      if (features.cuda13 && cuda13) return { kind: 'gpu', backend: cuda13 }
      if (features.cuda12 && cuda12) return { kind: 'gpu', backend: cuda12 }
      if (features.vulkan && hasEnoughVram && vulkan && !integratedOnly)
        return { kind: 'gpu', backend: vulkan }

      const gpuCapable =
        features.cuda13 || features.cuda12 || (features.vulkan && hasEnoughVram && !integratedOnly)
      if (gpuCapable && !anyGpuBackendAvailable) {
        warn(
          'detectIdealBackendType: GPU-capable Windows host but no turboquant GPU backend in catalog — treating as detection failure (manifest likely unreachable)'
        )
        return { kind: 'detection-failed' }
      }
      return { kind: 'cpu-optimal' }
    }

    if (archSuffix === 'x64') {
      const cuda13 = pick(/^linux-x64-cuda-13(\.\d+)?$/)
      const cuda12 = pick(/^linux-x64-cuda-12(\.\d+)?$/)
      const rocm = pick(/^linux-x64-rocm$/)
      const vulkan = pick(/^linux-x64-vulkan$/)
      const gpuWorthIt = hasEnoughVram && !integratedOnly

      if (features.cuda13 && cuda13) return { kind: 'gpu', backend: cuda13 }
      if (features.cuda12 && cuda12) return { kind: 'gpu', backend: cuda12 }
      if (features.rocm && gpuWorthIt && rocm) return { kind: 'gpu', backend: rocm }
      if (features.vulkan && gpuWorthIt && vulkan) return { kind: 'gpu', backend: vulkan }

      const gpuCapable =
        features.cuda13 || features.cuda12 || ((features.rocm || features.vulkan) && gpuWorthIt)
      if (gpuCapable && !anyGpuBackendAvailable) {
        warn(
          'detectIdealBackendType: GPU-capable Linux host but no turboquant GPU backend in catalog — treating as detection failure (manifest likely unreachable)'
        )
        return { kind: 'detection-failed' }
      }
    }
    return { kind: 'cpu-optimal' }
  } catch (err) {
    warn(`detectIdealBackendType failed: ${err instanceof Error ? err.message : String(err)}`)
    return { kind: 'detection-failed' }
  }
}

/**
 * Newest `<version>/<backend>` whose normalised fork id equals `backendType`, or `null`. The
 * original backend spelling is kept in the result (Rust `find_latest_version_for_backend`).
 */
export function findLatestTurboquantVersionForBackend(
  versionBackends: readonly BackendVersion[],
  backendType: string
): string | null {
  const matching = versionBackends.filter((vb) => mapOldTurboquantBackendToNew(vb.backend) === backendType)
  const best = [...matching].sort(compareTurboquantBackendsForSort)[0]
  return best ? `${best.version}/${best.backend}` : null
}

/**
 * Whether a newer build of the current backend's (normalised) fork type exists. `new_version` is
 * `"0"` and `target_backend` `null` when nothing newer or nothing at all is listed.
 */
export function checkTurboquantBackendForUpdates(
  currentBackendString: string,
  versionBackends: readonly BackendVersion[]
): UpdateCheckResult {
  const parts = currentBackendString.split('/')
  if (parts.length !== 2) {
    throw new AtomicCoreError('INVALID_ARGUMENT', `Invalid current backend format: ${currentBackendString}`)
  }
  const effectiveType = mapOldTurboquantBackendToNew(parts[1] ?? '')
  const target = findLatestTurboquantVersionForBackend(versionBackends, effectiveType)
  if (target === null || target === currentBackendString) {
    return { update_needed: false, new_version: '0', target_backend: null }
  }
  return { update_needed: true, new_version: target.split('/')[0] ?? '', target_backend: target }
}
