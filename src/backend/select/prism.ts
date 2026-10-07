/**
 * Which PrismML build fits this host — the `atomic-prism` provider's half of `select/`, pure.
 *
 * Backend ids are the stable ones of `atomic-chat-conf/backends/atomic-prism-manifest.json`
 * (`macos-arm64`, `linux-cuda-13.3-x64`, `win-hip-radeon-x64`, …). The order is the plan's:
 *   - macOS arm64: Metal (the `macos-arm64` pack); macOS x64: its single CPU pack;
 *   - Windows/Linux with NVIDIA: CUDA 13.3 / 12.x by driver and architecture → Vulkan → CPU;
 *   - AMD: ROCm (Linux, amdkfd + runtime) / HIP (Windows, PCI table) → Vulkan → CPU;
 *   - Windows/Linux arm64: deferred, nothing offered.
 * Driver floors and the CUDA 13 architecture floor are the other providers' (`features.ts`); Linux
 * ROCm uses the fork's host probe. Which assets are offered at all (`approved` vs `candidate`,
 * `min_core_version`, `withdrawn`) is the catalog's decision, not this module's.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import { rocmSupportedLinux } from '../turboquant.js'
import type { RocmHostProbe } from '../turboquant.js'
import type {
  BackendFeatures,
  BackendVersion,
  GpuProbeInfo,
  IdealBackendResult,
  SupportedFeatures,
  UpdateCheckResult,
} from '../types.js'
import { stripBom } from '../version.js'
import { prismTagBuild } from '../catalog/index.js'
import { getSupportedFeatures, isAmdGpu, normalizeFeatures } from './features.js'
import { integratedGpuOnly } from './tiers.js'

/** Below this much VRAM a Vulkan or ROCm offload is not worth it; CUDA is always preferred. */
export const PRISM_GPU_MIN_VRAM_MIB = 2 * 1024

/**
 * Supported features: the shared CUDA/Vulkan/Windows-ROCm rules, plus Linux ROCm from the host
 * probe (PrismML publishes a Linux ROCm 7.2 build, ggml-org does not).
 */
export function getPrismSupportedFeatures(
  osType: string,
  cpuExtensions: readonly string[],
  gpus: readonly GpuProbeInfo[],
  rocm: RocmHostProbe = { gfxTargetVersions: [], hasRuntime: false }
): SupportedFeatures {
  const features = getSupportedFeatures(osType, cpuExtensions, gpus)
  delete features.opencl
  if (osType === 'linux') features.rocm = rocmSupportedLinux(gpus.some(isAmdGpu), rocm)
  return features
}

/** Backend ids PrismML publishes for `<osType>-<arch>` that this host's features allow. */
export function determinePrismSupportedBackends(
  osType: string,
  arch: string,
  features: BackendFeatures
): string[] {
  const sysType = `${osType}-${arch}`
  switch (sysType) {
    case 'macos-aarch64':
    case 'macos-arm64':
      return ['macos-arm64']
    case 'macos-x86_64':
    case 'macos-x86':
      return ['macos-x64']
    case 'linux-x86_64':
    case 'linux-x86': {
      const out = ['linux-cpu-x64']
      if (features.cuda12) out.push('linux-cuda-12.4-x64', 'linux-cuda-12.8-x64')
      if (features.cuda13) out.push('linux-cuda-13.3-x64')
      if (features.rocm) out.push('linux-rocm-7.2-x64')
      if (features.vulkan) out.push('linux-vulkan-x64')
      return out
    }
    case 'windows-x86_64':
    case 'windows-x86': {
      const out = ['win-cpu-x64']
      if (features.cuda12) out.push('win-cuda-12.4-x64')
      if (features.cuda13) out.push('win-cuda-13.3-x64')
      if (features.rocm) out.push('win-hip-radeon-x64')
      if (features.vulkan) out.push('win-vulkan-x64')
      return out
    }
    case 'linux-aarch64':
    case 'linux-arm64':
    case 'windows-aarch64':
    case 'windows-arm64':
      return []
    default:
      throw new AtomicCoreError('INVALID_ARGUMENT', `Unsupported system type: ${sysType}`)
  }
}

/** Category of a Prism backend id, for the optimal record and the priority table. */
export function getPrismBackendCategory(backend: string): string | null {
  const id = stripBom(backend)
  if (/-cuda-13(\.\d+)?-/.test(id)) return 'cuda-cu13.0'
  if (/-cuda-12(\.\d+)?-/.test(id)) return 'cuda-cu12.0'
  if (id.includes('-rocm-') || id.includes('-hip-')) return 'rocm'
  if (id.includes('-vulkan-')) return 'vulkan'
  if (id.includes('-cpu-')) return 'common_cpus'
  if (id === 'macos-arm64') return 'arm64'
  if (id === 'macos-x64') return 'x64'
  return null
}

/** CUDA minor version of an id (`12.8` → 8), so the newer toolkit wins inside one family. */
function cudaMinor(backend: string): number {
  const match = /-cuda-\d+\.(\d+)-/.exec(backend)
  return match ? Number(match[1]) : 0
}

/** Newest build first, then the newer CUDA minor, then install order, then the id. */
export function comparePrismBackendsForSort(left: BackendVersion, right: BackendVersion): number {
  const l = prismTagBuild(stripBom(left.version))
  const r = prismTagBuild(stripBom(right.version))
  if (l !== null && r !== null && l !== r) return r - l
  if (l !== null && r === null) return -1
  if (l === null && r !== null) return 1
  const minor = cudaMinor(right.backend) - cudaMinor(left.backend)
  if (minor !== 0) return minor
  const order = (right.order ?? 0) - (left.order ?? 0)
  if (order !== 0) return order
  return left.backend < right.backend ? -1 : left.backend > right.backend ? 1 : 0
}

/** Remote + installed, de-duplicated by `<tag>/<id>`, newest first. */
export function mergePrismBackends(
  remote: readonly BackendVersion[],
  local: readonly BackendVersion[]
): BackendVersion[] {
  const byKey = new Map<string, BackendVersion>()
  for (const entry of [...local, ...remote]) {
    const key = `${stripBom(entry.version)}/${stripBom(entry.backend)}`
    if (!byKey.has(key)) byKey.set(key, entry)
  }
  return [...byKey.values()].sort(comparePrismBackendsForSort)
}

export function filterPrismBackendsBySupport(
  backends: readonly BackendVersion[],
  supported: readonly string[]
): BackendVersion[] {
  const set = new Set(supported)
  return backends.filter((b) => set.has(stripBom(b.backend)))
}

const PRIORITY_ENOUGH_VRAM = ['cuda-cu13.0', 'cuda-cu12.0', 'rocm', 'vulkan', 'arm64', 'common_cpus', 'x64']
const PRIORITY_LOW_VRAM = ['cuda-cu13.0', 'cuda-cu12.0', 'arm64', 'common_cpus', 'x64', 'rocm', 'vulkan']

/** The newest build of the first category present; `''` for an empty list. */
export function determineBestPrismBackend(
  backends: readonly BackendVersion[],
  gpus: readonly GpuProbeInfo[]
): string {
  if (backends.length === 0) return ''
  const enough =
    gpus.some((gpu) => (gpu.total_memory ?? 0) >= PRISM_GPU_MIN_VRAM_MIB) && !integratedGpuOnly(gpus)
  for (const category of enough ? PRIORITY_ENOUGH_VRAM : PRIORITY_LOW_VRAM) {
    const best = backends
      .filter((b) => getPrismBackendCategory(b.backend) === category)
      .sort(comparePrismBackendsForSort)[0]
    if (best) return `${stripBom(best.version)}/${stripBom(best.backend)}`
  }
  const fallback = backends[0] as BackendVersion
  return `${stripBom(fallback.version)}/${stripBom(fallback.backend)}`
}

export function findLatestPrismVersionForBackend(
  list: readonly BackendVersion[],
  backendType: string
): string | null {
  const best = list.filter((b) => stripBom(b.backend) === backendType).sort(comparePrismBackendsForSort)[0]
  return best ? `${stripBom(best.version)}/${stripBom(best.backend)}` : null
}

/**
 * A newer build of the same backend id. Builds compare by the number in `prism-b<build>-…`; a
 * current tag that is not a Prism tag is treated as older than any listed one.
 */
export function checkPrismBackendForUpdates(
  current: string,
  list: readonly BackendVersion[]
): UpdateCheckResult {
  const parts = stripBom(current).split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new AtomicCoreError('INVALID_ARGUMENT', `Invalid current backend format: ${current}`)
  }
  const [tag, backend] = parts as [string, string]
  const none: UpdateCheckResult = { update_needed: false, new_version: '0', target_backend: null }
  const target = findLatestPrismVersionForBackend(list, backend)
  if (!target) return none
  const targetTag = target.split('/')[0] ?? ''
  const currentBuild = prismTagBuild(tag) ?? -1
  const targetBuild = prismTagBuild(targetTag) ?? -1
  if (targetBuild <= currentBuild) return none
  return { update_needed: true, new_version: targetTag, target_backend: target }
}

/**
 * The ideal Prism backend type. macOS has nothing to detect (the advisor answers `mac` first); on
 * Windows/Linux the first runnable GPU family in the plan's order wins. A GPU-capable host with no
 * GPU build offered is `cpu-optimal`, not a failure: the catalog always has the bundled baseline, so
 * "nothing offered" means "nothing approved for this GPU yet", and a later recheck will recommend it.
 */
export async function detectIdealPrismBackendType(input: {
  osType: string
  arch: string
  cpuExtensions: readonly string[]
  gpus: readonly GpuProbeInfo[]
  rocm?: RocmHostProbe
  listAvailableBackends: () => Promise<BackendVersion[]>
  onWarn?: (message: string) => void
}): Promise<IdealBackendResult> {
  const { osType, gpus } = input
  if (osType !== 'windows' && osType !== 'linux') return { kind: 'cpu-optimal' }
  try {
    const features = normalizeFeatures(
      getPrismSupportedFeatures(osType, input.cpuExtensions, gpus, input.rocm)
    )
    const catalog = await input.listAvailableBackends()
    const ids = new Set(catalog.map((b) => stripBom(b.backend)))
    const pick = (...candidates: string[]) => candidates.find((id) => ids.has(id)) ?? null
    const worthIt =
      gpus.some((gpu) => (gpu.total_memory ?? 0) >= PRISM_GPU_MIN_VRAM_MIB) && !integratedGpuOnly(gpus)
    const prefix = osType === 'windows' ? 'win' : 'linux'
    const cuda13 = pick(`${prefix}-cuda-13.3-x64`)
    const cuda12 =
      osType === 'windows' ? pick('win-cuda-12.4-x64') : pick('linux-cuda-12.8-x64', 'linux-cuda-12.4-x64')
    const amd = pick(osType === 'windows' ? 'win-hip-radeon-x64' : 'linux-rocm-7.2-x64')
    const vulkan = pick(`${prefix}-vulkan-x64`)

    if (features.cuda13 && cuda13) return { kind: 'gpu', backend: cuda13 }
    if (features.cuda12 && cuda12) return { kind: 'gpu', backend: cuda12 }
    if (features.rocm && worthIt && amd) return { kind: 'gpu', backend: amd }
    if (features.vulkan && worthIt && vulkan) return { kind: 'gpu', backend: vulkan }
    return { kind: 'cpu-optimal' }
  } catch (err) {
    input.onWarn?.(`detectIdealPrismBackendType: ${err instanceof Error ? err.message : String(err)}`)
    return { kind: 'detection-failed' }
  }
}
