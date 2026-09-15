/**
 * Hardware-gated backend selection. Port of the pure policy in
 * `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs` (`get_supported_features` with its
 * compute-capability and Windows-ROCm gates, `determine_supported_backends`, `list_supported_backends`,
 * `get_backend_category`, `prioritize_backends`, `find_latest_version_for_backend`,
 * `check_backend_for_updates`), of the Windows family-aware filter in the extension's
 * `listSupportedBackends` (`backend.ts`), and of the decision halves of `determineBestBackend`,
 * `detectIdealBackendType`, `tierEnumeratesDevices`, `hasCorroboratingGpu` and the `configureBackends`
 * startup recovery in `extensions/llamacpp-upstream-extension/src/index.ts`.
 *
 * Nothing here reads hardware, disk or network: the probe result (`GpuProbeInfo[]`, cpu extensions),
 * the installed list and the remote catalog are parameters; `--list-devices` is an injected function.
 */

import type { DeviceInfo } from '../contracts/index.js'
import { AtomicCoreError } from '../contracts/index.js'
import { isRocmSupportedPciId } from './amd-rocm-pci-ids.js'
import { friendlyBackendLabel } from './archive.js'
import { isConcreteOfGpuFamily, WIN_ROCM_FAMILY_ID } from './cuda-family.js'
import { mapOldBackendToNew } from './migrate.js'
import type {
  ArchSuffix,
  BackendFeatures,
  BackendOption,
  BackendVersion,
  BestBackendResult,
  GpuProbeInfo,
  IdealBackendResult,
  SupportedFeatures,
  TierHealth,
  TierProbeDeps,
  UpdateCheckResult,
} from './types.js'
import {
  compareBackendVersionsForSort,
  compareVersions,
  isConcreteVersionBackend,
  parseBuildNumber,
  parseRustU32,
  stripBom,
} from './version.js'

// ---------------------------------------------------------------------------------------------
// Feature detection (get_supported_features)
// ---------------------------------------------------------------------------------------------

/**
 * Minimum NVIDIA driver per CUDA tier (https://docs.nvidia.com/deploy/cuda-compatibility/).
 * Windows floors follow the ggml-org native releases (CUDA 12.4 / 13.1; 13.1's documented minimum is
 * 581.15 — `"581"` alone let 581.00–581.14 pre-release drivers through). Linux floors stay aligned
 * with the TurboQuant plugin. Other OSes have no CUDA.
 */
export const CUDA_DRIVER_FLOORS = {
  linux: { cuda11: '450.80.02', cuda12: '525.60.13', cuda13: '580' },
  windows: { cuda11: '452.39', cuda12: '551.61', cuda13: '581.15' },
} as const

/**
 * Lowest compute capability a CUDA-13 build still carries kernels for: CUDA Toolkit 13.0 removed
 * Maxwell (5.x), Pascal (6.x) and Volta (7.0), so Turing (7.5) is the floor. The driver gate cannot
 * catch this on its own — R580 is the last branch still supporting those cards, so they report a
 * driver above the 581.15 floor and previously sailed through to "no kernel image is available".
 */
export const MIN_CUDA13_COMPUTE_CAPABILITY: readonly [number, number] = [7, 5]

/**
 * Smallest GPU worth moving a host off the CPU build for (MiB). Platform-neutral on purpose: ATO-464
 * lowered Linux to 2 GiB with reasoning that is a property of the backend, and Windows kept an
 * inline 6 GiB that told a 4 GB Radeon owner "CPU is optimal" while a 4 GB GeForce got CUDA.
 */
export const GPU_BACKEND_MIN_VRAM_MIB = 2 * 1024

/**
 * NVML `"major.minor"` → `[major, minor]`; a missing minor is 0; unreadable input is `undefined`,
 * which callers treat as "unknown — do not gate" (guessing "too old" would strand a Blackwell host).
 */
export function parseComputeCapability(raw: string): [number, number] | undefined {
  const parts = raw.trim().split('.')
  const major = parseRustU32((parts[0] ?? '').trim())
  if (major === undefined) return undefined
  const minor = parseRustU32((parts[1] ?? '0').trim()) ?? 0
  return [major, minor]
}

/** Tuple comparison against the floor, so `10.0 ≥ 7.5` holds (a string compare gets Blackwell wrong). */
export function gpuMeetsCuda13ArchFloor(computeCapability: string | undefined): boolean {
  const cc = parseComputeCapability(computeCapability ?? '')
  if (!cc) return true
  const [floorMajor, floorMinor] = MIN_CUDA13_COMPUTE_CAPABILITY
  return cc[0] > floorMajor || (cc[0] === floorMajor && cc[1] >= floorMinor)
}

export function isAmdGpu(gpu: GpuProbeInfo): boolean {
  return typeof gpu.vendor === 'string' && gpu.vendor.toLowerCase() === 'amd'
}

/**
 * The Windows ROCm decision. The upstream archive statically carries HIP inside `ggml-hip.dll`, so
 * an AMD driver is enough; what must be checked is the gfx architecture, and the PCI device id is the
 * only pre-launch signal. Conservative: a card missing from the table falls back to Vulkan — 34.6 MB
 * that works beats ~1 GB that may not — and the manual picker still offers ROCm.
 */
export function rocmSupportedWindows(hasAmdGpu: boolean, deviceIds: readonly number[]): boolean {
  return hasAmdGpu && deviceIds.some((id) => isRocmSupportedPciId(id))
}

/**
 * Which CPU/GPU tiers this host can run. The driver is system-wide, so *any* NVIDIA GPU over a floor
 * enables that CUDA tier; architecture is per-card and must hold for *every* card (llama.cpp
 * offloads across all visible devices), so one sub-7.5 GPU vetoes CUDA 13 for the whole host.
 * Vulkan is on when any GPU carries `vulkan_info`; ROCm only on Windows via the PCI table. On any OS
 * other than linux/windows only the CPU flags are set (no CUDA, no Vulkan — macOS has Metal).
 */
export function getSupportedFeatures(
  osType: string,
  cpuExtensions: readonly string[],
  gpus: readonly GpuProbeInfo[]
): SupportedFeatures {
  const features: SupportedFeatures = {
    avx: cpuExtensions.includes('avx'),
    avx2: cpuExtensions.includes('avx2'),
    avx512: cpuExtensions.includes('avx512'),
    cuda11: false,
    cuda12: false,
    cuda13: false,
    vulkan: false,
    rocm: false,
  }
  const floors = osType === 'linux' || osType === 'windows' ? CUDA_DRIVER_FLOORS[osType] : undefined
  if (!floors) return features

  const amdDeviceIds: number[] = []
  let hasAmdGpu = false
  let allNvidiaMeetCuda13Arch = true
  for (const gpu of gpus) {
    const driver = gpu.driver_version ?? ''
    if (isAmdGpu(gpu)) {
      hasAmdGpu = true
      const deviceId = gpu.vulkan_info?.device_id
      if (typeof deviceId === 'number') amdDeviceIds.push(deviceId)
    }
    const nvidia = gpu.nvidia_info
    if (nvidia) {
      if (compareVersions(driver, floors.cuda11) >= 0) features.cuda11 = true
      if (compareVersions(driver, floors.cuda12) >= 0) features.cuda12 = true
      if (compareVersions(driver, floors.cuda13) >= 0) features.cuda13 = true
      if (!gpuMeetsCuda13ArchFloor(nvidia.compute_capability)) allNvidiaMeetCuda13Arch = false
    }
    if (gpu.vulkan_info) features.vulkan = true
  }
  features.cuda13 = features.cuda13 && allNvidiaMeetCuda13Arch
  if (osType === 'windows') features.rocm = rocmSupportedWindows(hasAmdGpu, amdDeviceIds)
  return features
}

/** guest-js `normalizeFeatures`: missing flags read as `false`. */
export function normalizeFeatures(features: Partial<BackendFeatures> | null | undefined): BackendFeatures {
  return {
    cuda11: features?.cuda11 || false,
    cuda12: features?.cuda12 || false,
    cuda13: features?.cuda13 || false,
    vulkan: features?.vulkan || false,
    rocm: features?.rocm || false,
  }
}

// ---------------------------------------------------------------------------------------------
// Supported matrix (determine_supported_backends) and catalog merge (list_supported_backends)
// ---------------------------------------------------------------------------------------------

/**
 * Backend ids installable on `<osType>-<arch>` given the detected features. Windows x64 always has
 * CPU, then CUDA 12.4, the *family* ids `win-cuda-13-x64` / `win-rocm-x64` (concrete minors come
 * from the manifest, ATO-105) and Vulkan. Linux x64: CPU, plus Vulkan — the CUDA and ROCm flags are
 * ignored because ggml-org publishes no Linux CUDA/HIP archive (2026-05-28 ADR). arm64 Linux and
 * Windows get a CPU placeholder; macOS its single arch build. Anything else is `INVALID_ARGUMENT`.
 */
export function determineSupportedBackends(
  osType: string,
  arch: string,
  features: BackendFeatures
): string[] {
  const sysType = `${osType}-${arch}`
  const supported: string[] = []
  switch (sysType) {
    case 'windows-x86_64':
      supported.push('win-cpu-x64')
      if (features.cuda12) supported.push('win-cuda-12.4-x64')
      if (features.cuda13) supported.push('win-cuda-13-x64')
      if (features.rocm) supported.push(WIN_ROCM_FAMILY_ID)
      if (features.vulkan) supported.push('win-vulkan-x64')
      break
    case 'windows-aarch64':
    case 'windows-arm64':
      supported.push('win-cpu-arm64')
      break
    case 'linux-x86_64':
    case 'linux-x86':
      supported.push('linux-cpu-x64')
      if (features.vulkan) supported.push('linux-vulkan-x64')
      break
    case 'linux-aarch64':
    case 'linux-arm64':
      supported.push('linux-cpu-arm64')
      break
    case 'macos-x86_64':
    case 'macos-x86':
      supported.push('macos-x64')
      break
    case 'macos-aarch64':
    case 'macos-arm64':
      supported.push('macos-arm64')
      break
    default:
      throw new AtomicCoreError('INVALID_ARGUMENT', `Unsupported system type: ${sysType}`)
  }
  return supported
}

/**
 * Merge the remote catalog with the installed builds, keyed `"<version>|<backend>"`. A local entry
 * replaces the remote one only when its `order` is greater (an installed build carries its mtime,
 * a manifest entry 0). Sorted newest first by `compareBackendVersionsForSort`.
 */
export function listSupportedBackends(
  remote: readonly BackendVersion[],
  local: readonly BackendVersion[]
): BackendVersion[] {
  const merged = new Map<string, BackendVersion>()
  for (const entry of remote) merged.set(`${entry.version}|${entry.backend}`, { ...entry })
  for (const entry of local) {
    const key = `${entry.version}|${entry.backend}`
    const existing = merged.get(key)
    if (!existing) merged.set(key, { ...entry })
    else if ((entry.order ?? 0) > (existing.order ?? 0)) merged.set(key, { ...entry })
  }
  return [...merged.values()].sort(compareBackendVersionsForSort)
}

/**
 * The hardware gate on the merged catalog. Windows keeps only backends whose (normalised) id is in
 * `supportedBackends`, matching concrete CUDA-13 and ROCm assets against their family ids so
 * `win-cuda-13.4-x64` is accepted when `win-cuda-13-x64` is supported and flows downstream unchanged.
 * Every other OS returns the list unfiltered (the manifest parser already applied the arch filter).
 */
export function filterBackendsBySupport(
  merged: readonly BackendVersion[],
  supportedBackends: readonly string[],
  osType: string
): BackendVersion[] {
  if (osType !== 'windows') return [...merged]
  const supportedSet = new Set(supportedBackends)
  const cuda13Concrete = /^win-cuda-13\.\d+-(x64|arm64)$/
  const isSupported = (rawBackend: string, normalized: string): boolean => {
    if (supportedSet.has(normalized)) return true
    const m = cuda13Concrete.exec(rawBackend)
    if (m) return supportedSet.has(`win-cuda-13-${m[1]}`)
    if (isConcreteOfGpuFamily(WIN_ROCM_FAMILY_ID, rawBackend)) return supportedSet.has(WIN_ROCM_FAMILY_ID)
    return false
  }
  return merged.filter((b) => isSupported(stripBom(b.backend), mapOldBackendToNew(b.backend)))
}

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

// ---------------------------------------------------------------------------------------------
// Ideal backend detection (determineBestBackend / detectIdealBackendType / tierEnumeratesDevices)
// ---------------------------------------------------------------------------------------------

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

export function hasDiscreteGpu(gpus: readonly GpuProbeInfo[]): boolean {
  return gpus.some((g) => g.vulkan_info?.device_type === 'DiscreteGpu' || !!g.nvidia_info)
}

/**
 * Integrated-only hosts (Intel UHD / AMD Vega iGPU on shared RAM) report plenty of "VRAM" yet run
 * Vulkan far slower than the CPU build, so Vulkan is never the *optimal* pick for them.
 */
export function integratedGpuOnly(gpus: readonly GpuProbeInfo[]): boolean {
  return (
    !hasDiscreteGpu(gpus) &&
    gpus.length > 0 &&
    gpus.every((g) => g.vulkan_info?.device_type === 'IntegratedGpu')
  )
}

/**
 * Whether the hardware probe corroborates that `backendType` could use a GPU here: CUDA needs an
 * NVIDIA GPU, Vulkan any GPU, anything else (CPU) is trivially corroborated so the picker can fall
 * through. Vendor strings as `tauri-plugin-hardware/src/types.rs` serialises them.
 */
export function hasCorroboratingGpu(backendType: string, gpus: readonly GpuProbeInfo[]): boolean {
  if (backendType.includes('cuda')) return gpus.some((g) => g.vendor === 'NVIDIA')
  if (backendType.includes('vulkan')) return gpus.length > 0
  return true
}

/**
 * The decision inside `tierEnumeratesDevices`: not installed → `unverified` (nothing to probe);
 * devices listed → `works`; nothing listed but the probe corroborates a matching GPU → `unverified`
 * (`--list-devices` is known to come back empty on hosts whose inference path uses CUDA fine, ADR
 * 2026-05-26); nothing listed and no corroboration → `broken`, degrade to the next tier.
 */
export function classifyTierProbe(input: {
  installed: boolean
  devices: readonly DeviceInfo[] | null
  corroborated: boolean
}): TierHealth {
  if (!input.installed) return 'unverified'
  if (input.devices && input.devices.length > 0) return 'works'
  return input.corroborated ? 'unverified' : 'broken'
}

/**
 * Non-destructive runtime probe of one GPU tier: find the installed build of that type, run
 * `--list-devices` through `deps.listDevices`, and classify. A throwing `listInstalled` is
 * `unverified`; a throwing probe counts as "no devices". `onLog` receives the app's log lines.
 */
export async function tierEnumeratesDevices(
  backendType: string,
  gpus: readonly GpuProbeInfo[],
  deps: TierProbeDeps,
  onLog?: (message: string) => void
): Promise<TierHealth> {
  const log = onLog ?? (() => {})
  let installed: BackendVersion | undefined
  try {
    installed = (await deps.listInstalled()).find((b) => b.backend === backendType)
  } catch (err) {
    log(
      `Tier ${backendType} health-check: listInstalled threw (${err instanceof Error ? err.message : String(err)}); treating as unverified`
    )
    return 'unverified'
  }
  if (!installed) return 'unverified'

  let devices: DeviceInfo[] | null = null
  let probeError: string | null = null
  try {
    devices = await deps.listDevices(installed)
  } catch (err) {
    probeError = err instanceof Error ? err.message : String(err)
  }
  const corroborated = hasCorroboratingGpu(backendType, gpus)
  const verdict = classifyTierProbe({ installed: true, devices, corroborated })
  const reason = probeError ? `--list-devices threw (${probeError})` : '--list-devices returned no devices'
  if (verdict === 'unverified') {
    log(
      `Tier ${backendType} (${installed.version}) ${reason} but NVML/Vulkan corroborates a matching GPU; keeping tier as recommendation (unverified)`
    )
  } else if (verdict === 'broken') {
    log(
      `Tier ${backendType} (${installed.version}) is broken: ${reason} and the hardware plugin sees no matching GPU; degrading recommendation to next tier`
    )
  }
  return verdict
}

/** First tier (top-down) whose probe is not `broken`, or `null`. */
export async function pickFirstWorkingTier(
  tiers: readonly string[],
  probe: (tier: string) => Promise<TierHealth>
): Promise<string | null> {
  for (const tier of tiers) {
    if ((await probe(tier)) !== 'broken') return tier
  }
  return null
}

/**
 * App regex for "any GPU backend in the catalog", kept verbatim. Note the `-` required right after
 * the first digit: `win-cuda-13.3-x64` and `win-rocm-10.0-x64` do NOT match, only Vulkan ids do.
 * It still works because ggml-org always publishes a Vulkan Windows asset next to CUDA.
 */
export function isGpuBackendId(backend: string): boolean {
  return /-(cuda-\d|rocm-\d|vulkan)-/.test(backend)
}

/**
 * Windows GPU tiers in preference order: CUDA 13, CUDA 12, ROCm (VRAM-gated; `features.rocm` is
 * already PCI-gated), Vulkan (VRAM-gated, never on integrated-only hosts). Each tier is the first
 * catalog entry matching its pattern — the catalog is sorted newest first, so that is the newest tag.
 */
export function windowsGpuTiers(
  features: BackendFeatures,
  available: readonly BackendVersion[],
  archSuffix: ArchSuffix,
  gpus: readonly GpuProbeInfo[]
): string[] {
  const pick = (pattern: RegExp): string | null =>
    available.find((b) => pattern.test(b.backend))?.backend ?? null
  const cuda13 = pick(new RegExp(`^win-cuda-13\\.\\d+-${archSuffix}$`))
  const cuda12 = pick(new RegExp(`^win-cuda-12\\.\\d+-${archSuffix}$`))
  const rocm = pick(new RegExp(`^win-rocm-\\d+\\.\\d+-${archSuffix}$`))
  const vulkan = pick(new RegExp(`^win-vulkan-${archSuffix}$`))
  const enoughVram = hasEnoughGpuMemory(gpus)
  const tiers: string[] = []
  if (features.cuda13 && cuda13) tiers.push(cuda13)
  if (features.cuda12 && cuda12) tiers.push(cuda12)
  if (features.rocm && enoughVram && rocm) tiers.push(rocm)
  if (features.vulkan && enoughVram && vulkan && !integratedGpuOnly(gpus)) tiers.push(vulkan)
  return tiers
}

export interface DetectIdealBackendInput {
  osType: string
  arch: string
  cpuExtensions: readonly string[]
  gpus: readonly GpuProbeInfo[]
  /** Windows only: the hardware-gated catalog (`listSupportedBackends` + `filterBackendsBySupport`). */
  listAvailableBackends: () => Promise<BackendVersion[]>
  /** Windows only: `tierEnumeratesDevices` bound to this host. */
  probeTier: (tier: string) => Promise<TierHealth>
  onWarn?: (message: string) => void
}

/**
 * Which backend this host should ideally run. Windows: the first GPU tier that survives the probe;
 * a GPU-capable host with no GPU backend in the catalog is `detection-failed` (the manifest was
 * unreachable — ggml-org always publishes CUDA + Vulkan Windows assets), otherwise `cpu-optimal`.
 * Linux x64: Vulkan when the loader enumerates a device with ≥ 2 GiB; a GPU the loader cannot see
 * is `detection-failed` (ask again next launch, ATO-464); no accelerator is `cpu-optimal`. macOS and
 * everything else: `cpu-optimal`. Any thrown error is `detection-failed`.
 *
 * The caller wraps this in its 20 s `withTimeout` (timeout → `detection-failed`) and, on Windows,
 * supplies `listAvailableBackends` / `probeTier`.
 */
export async function detectIdealBackendType(input: DetectIdealBackendInput): Promise<IdealBackendResult> {
  const warn = input.onWarn ?? (() => {})
  try {
    const { osType, gpus } = input
    const features = normalizeFeatures(getSupportedFeatures(osType, input.cpuExtensions, gpus))
    const enoughVram = hasEnoughGpuMemory(gpus)
    const integratedOnly = integratedGpuOnly(gpus)
    const archSuffix: ArchSuffix =
      input.arch.includes('aarch64') || input.arch.includes('arm64') ? 'arm64' : 'x64'

    if (osType === 'windows') {
      const available = await input.listAvailableBackends()
      const tiers = windowsGpuTiers(features, available, archSuffix, gpus)
      const picked = await pickFirstWorkingTier(tiers, input.probeTier)
      if (picked) return { kind: 'gpu', backend: picked }

      const gpuCapable =
        features.cuda13 ||
        features.cuda12 ||
        (features.rocm && enoughVram) ||
        (features.vulkan && enoughVram && !integratedOnly)
      const anyGpuBackendAvailable = available.some((b) => isGpuBackendId(b.backend))
      if (gpuCapable && !anyGpuBackendAvailable) {
        warn(
          'detectIdealBackendType: GPU-capable host but no GPU backend in catalog — treating as detection failure (release stream likely unreachable)'
        )
        return { kind: 'detection-failed' }
      }
      return { kind: 'cpu-optimal' }
    }

    if (osType === 'linux') {
      const anyVulkanDevice = enoughVram
      if (features.vulkan && archSuffix === 'x64' && anyVulkanDevice) {
        return { kind: 'gpu', backend: 'linux-vulkan-x64' }
      }
      if (!features.vulkan && archSuffix === 'x64' && gpus.length > 0) {
        return { kind: 'detection-failed' }
      }
      return { kind: 'cpu-optimal' }
    }

    return { kind: 'cpu-optimal' }
  } catch (err) {
    warn(`detectIdealBackendType failed: ${err instanceof Error ? err.message : String(err)}`)
    return { kind: 'detection-failed' }
  }
}

// ---------------------------------------------------------------------------------------------
// configureBackends startup decisions (index.ts:1070-1660), extracted from the settings/UI plumbing
// ---------------------------------------------------------------------------------------------

/** Persisted `version_backend` is unusable: empty, `none`, or not `<version>/<backend>`. */
export function isPersistedVersionBackendMissing(versionBackend: string | undefined | null): boolean {
  const vb = versionBackend || ''
  return !vb || vb === 'none' || !vb.includes('/')
}

/**
 * When the persisted `version_backend` was lost (wiped WebView storage, factory reset) but builds
 * are still on disk, pick the best installed one so the user's GPU backend survives the restart
 * instead of silently re-pinning the bundled CPU build. `null` when nothing usable is installed.
 */
export function recoverVersionBackendFromDisk(
  installed: readonly BackendVersion[],
  gpus: readonly GpuProbeInfo[]
): string | null {
  if (installed.length === 0) return null
  const recovered = determineBestBackend(installed, gpus)
  return recovered.includes('/') ? recovered : null
}

/**
 * Apply the bundled build over the persisted value when that value is still not a concrete
 * `<tag>/<backend>` after recovery — including the unresolved `latest/<backend>` sentinel, which
 * an `includes('/')` check let through and left pinned in a retry loop (ATO-124).
 */
export function shouldApplyBundledBackend(versionBackendAfterRecovery: string | undefined | null): boolean {
  return !isConcreteVersionBackend(versionBackendAfterRecovery ?? '')
}

/**
 * Backend ids behind the static "Latest <variant>" dropdown entries, unfiltered by hardware on
 * purpose (a manual override). Windows offers the minor-less CUDA / ROCm family ids; Linux CPU and
 * Vulkan; macOS only `macos-arm64`, and only when the bundled (or current) build is that arch — an
 * Intel host gets no sentinel because `latest/macos-x64` resolves to nothing.
 */
export function staticLatestVariants(osType: string, macHostVersionBackend?: string | null): string[] {
  if (osType === 'windows')
    return ['win-cpu-x64', 'win-cuda-12-x64', 'win-cuda-13-x64', WIN_ROCM_FAMILY_ID, 'win-vulkan-x64']
  if (osType === 'linux') return ['linux-cpu-x64', 'linux-vulkan-x64']
  if (osType === 'macos') {
    const variant = stripBom(macHostVersionBackend ?? '')
      .split('/')[1]
      ?.trim()
    return variant === 'macos-arm64' ? [variant] : []
  }
  return []
}

/** `latest/<backend>` sentinels with their "Latest <label>" names. */
export function latestBackendOptions(variants: readonly string[]): BackendOption[] {
  return variants.map((backend) => ({
    value: `latest/${backend}`,
    name: `Latest ${friendlyBackendLabel(backend)}`,
  }))
}

/**
 * Force-switch to the bundled build only when it is a *newer* release tag of the *same* type
 * (app update bumped the engine). Comparing, not assuming: the bundled build is reported on every
 * launch, so "the strings differ" would drag a runtime-updated user back to the installer's tag.
 */
export function isBundledNewerSameType(
  bundled: string | undefined | null,
  effective: string | undefined | null
): boolean {
  if (!bundled || !effective || !effective.includes('/')) return false
  const [bundledVersion, bundledType] = bundled.split('/')
  const [currentVersion, currentType] = effective.split('/')
  const bundledBuild = parseBuildNumber(stripBom(bundledVersion ?? ''))
  const currentBuild = parseBuildNumber(stripBom(currentVersion ?? ''))
  return (
    effective !== bundled &&
    bundledType === currentType &&
    bundledBuild !== null &&
    currentBuild !== null &&
    bundledBuild > currentBuild
  )
}

/**
 * The auto-upgrade candidate: `best` when it differs from `effective` and is of the same backend
 * type, else `null`. The caller must still check the candidate is installed on disk before
 * switching — pointing config at a build that is not downloaded yet is exactly the CUDA→CPU
 * regression this guards against.
 */
export function sameTypeUpgradeCandidate(
  effective: string | undefined | null,
  best: string | undefined | null
): string | null {
  if (!effective || !best || effective === best || !effective.includes('/')) return null
  const currentType = effective.split('/')[1]?.trim()
  const bestType = best.split('/')[1]?.trim()
  if (!currentType || !bestType || currentType !== bestType) return null
  return best
}

/**
 * Fresh install or a saved backend that is genuinely gone: empty / `none` / malformed, or absent
 * from the catalog *and* not installed. Absent-but-installed is kept (the catalog comes partly from
 * a remote fetch that can fail or truncate; resetting on that alone regressed CUDA→CPU on restart).
 */
export function savedBackendVanished(
  effective: string | undefined | null,
  versionBackends: readonly BackendVersion[],
  savedVbIsInstalled: boolean
): boolean {
  const vb = effective || ''
  const savedNotInList =
    !!vb && vb.includes('/') && !versionBackends.some((e) => `${e.version}/${e.backend}` === vb)
  return !vb || vb === 'none' || !vb.includes('/') || (savedNotInList && !savedVbIsInstalled)
}
