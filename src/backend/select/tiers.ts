/**
 * GPU tier probing and ideal-backend detection. Port of the decision halves of
 * `detectIdealBackendType`, `tierEnumeratesDevices` and `hasCorroboratingGpu` in
 * `extensions/llamacpp-upstream-extension/src/index.ts`.
 *
 * Nothing here reads hardware, disk or network: the probe result (`GpuProbeInfo[]`, cpu extensions)
 * and the catalog are parameters; `--list-devices` is an injected function.
 */

import type { DeviceInfo } from '../../contracts/index.js'
import type {
  ArchSuffix,
  BackendFeatures,
  BackendVersion,
  GpuProbeInfo,
  IdealBackendResult,
  TierHealth,
  TierProbeDeps,
} from '../types.js'
import { hasEnoughGpuMemory } from './categories.js'
import { getSupportedFeatures, normalizeFeatures } from './features.js'

// ---------------------------------------------------------------------------------------------
// Ideal backend detection (determineBestBackend / detectIdealBackendType / tierEnumeratesDevices)
// ---------------------------------------------------------------------------------------------

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
