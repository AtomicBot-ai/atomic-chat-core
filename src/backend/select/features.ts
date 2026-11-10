/**
 * Hardware feature gates and the supported-backend matrix. Port of the pure policy in
 * `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs` (`get_supported_features` with its
 * compute-capability and Windows-ROCm gates, `determine_supported_backends`, `list_supported_backends`)
 * and of the Windows family-aware filter in the extension's `listSupportedBackends` (`backend.ts`).
 *
 * Nothing here reads hardware, disk or network: the probe result (`GpuProbeInfo[]`, cpu extensions),
 * the installed list and the remote catalog are parameters.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import {
  LINUX_ROCM_BACKEND,
  isConcreteOfGpuFamily,
  mapOldBackendToNew,
  WIN_ROCM_FAMILY_ID,
} from '../catalog/index.js'
import type { BackendFeatures, BackendVersion, GpuProbeInfo, SupportedFeatures } from '../types.js'
import { compareBackendVersionsForSort, compareVersions, parseRustU32, stripBom } from '../version.js'
import type { RocmHostProbe } from '../turboquant.js'
import { isRocmSupportedPciId } from './amd-rocm-pci-ids.js'

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

/**
 * Below this compute capability (Turing and older) a Windows CUDA 13 build also needs
 * `WINDOWS_PRE_AMPERE_CUDA13_MIN_DRIVER`. The 13.x builds carry Turing only as PTX, and drivers before
 * R616 refuse that toolchain at load ("the provided PTX was compiled with an unsupported toolchain",
 * in `ggml_cuda_kernel_can_use_pdl`). Windows telemetry over 14 days, CC 7.5 on CUDA 13.x: drivers
 * 581–597 crashed 45 users and loaded 12, 610 crashed 46 and loaded 30, 616/617/621 crashed none of
 * 128. CUDA 12.4 loads on the same cards.
 */
export const CUDA13_DRIVER_GATED_BELOW_COMPUTE_CAPABILITY: readonly [number, number] = [8, 0]
export const WINDOWS_PRE_AMPERE_CUDA13_MIN_DRIVER = '616.00'

/**
 * Whether this card may run a CUDA 13 build with this driver, beyond the system-wide driver floor and
 * the architecture floor. Windows only (Linux has no such data); an unreadable compute capability is
 * not gated, as in `gpuMeetsCuda13ArchFloor`.
 */
export function gpuMeetsCuda13DriverForArch(
  osType: string,
  computeCapability: string | undefined,
  driver: string
): boolean {
  if (osType !== 'windows') return true
  const cc = parseComputeCapability(computeCapability ?? '')
  if (!cc) return true
  const [gateMajor, gateMinor] = CUDA13_DRIVER_GATED_BELOW_COMPUTE_CAPABILITY
  const belowGate = cc[0] < gateMajor || (cc[0] === gateMajor && cc[1] < gateMinor)
  return !belowGate || compareVersions(driver, WINDOWS_PRE_AMPERE_CUDA13_MIN_DRIVER) >= 0
}

export function isAmdGpu(gpu: GpuProbeInfo): boolean {
  return typeof gpu.vendor === 'string' && gpu.vendor.toLowerCase() === 'amd'
}

/** Snapdragon's Adreno, by the probe's vendor or, when the vendor id was not recognised, its name. */
export function isAdrenoGpu(gpu: GpuProbeInfo): boolean {
  if (typeof gpu.vendor === 'string' && gpu.vendor.toLowerCase() === 'qualcomm') return true
  return typeof gpu.name === 'string' && /adreno/i.test(gpu.name)
}

/**
 * The Windows ROCm decision. The upstream archive bundles the HIP backend and matching runtime
 * DLLs; the host still needs a compatible AMD driver. Gate the gfx architecture by PCI device id
 * before launch. A card missing from the reviewed table falls back to Vulkan; the manual picker
 * still offers ROCm.
 */
export function rocmSupportedWindows(hasAmdGpu: boolean, deviceIds: readonly number[]): boolean {
  return hasAmdGpu && deviceIds.some((id) => isRocmSupportedPciId(id))
}

// ubuntu-24-rocm GPU_TARGETS in ggml-org/llama.cpp b11617 release.yml.
// KFD encodes IP major * 10000 + minor * 100 + stepping (gfx90a = 9.0.10).
const UPSTREAM_ROCM_GFX = new Set([
  90008, 90010, 90402, 90500, 100100, 100101, 100102, 100300, 100301, 100302, 100303, 100304, 100305, 100306,
  110000, 110001, 110002, 110003, 110500, 110501, 110502, 120000, 120001,
])

/**
 * Which CPU/GPU tiers this host can run. The driver is system-wide, so *any* NVIDIA GPU over a floor
 * enables that CUDA tier; architecture is per-card and must hold for *every* card (llama.cpp
 * offloads across all visible devices), so one sub-7.5 GPU vetoes CUDA 13 for the whole host, and on
 * Windows so does one pre-Ampere GPU on a driver before R616 (`gpuMeetsCuda13DriverForArch`).
 * Vulkan is on when any GPU carries `vulkan_info`; ROCm via the Windows PCI table or the Linux HIP and KFD probe; OpenCL
 * only on Windows with an Adreno GPU (the only OpenCL build ggml-org ships is for Adreno). On any OS
 * other than linux/windows only the CPU flags are set (no CUDA, no Vulkan — macOS has Metal).
 */
export function getSupportedFeatures(
  osType: string,
  cpuExtensions: readonly string[],
  gpus: readonly GpuProbeInfo[],
  rocm?: RocmHostProbe
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
  // Set only when true: every other host keeps the exact shape of the Rust `SupportedFeatures`.
  if (osType === 'windows' && gpus.some(isAdrenoGpu)) features.opencl = true

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
      if (!gpuMeetsCuda13DriverForArch(osType, nvidia.compute_capability, driver))
        allNvidiaMeetCuda13Arch = false
    }
    if (gpu.vulkan_info) features.vulkan = true
  }
  features.cuda13 = features.cuda13 && allNvidiaMeetCuda13Arch
  if (osType === 'windows') features.rocm = rocmSupportedWindows(hasAmdGpu, amdDeviceIds)
  if (osType === 'linux' && hasAmdGpu && rocm?.hasRuntime)
    features.rocm =
      rocm.gfxTargetVersions.length > 0 &&
      rocm.gfxTargetVersions.every((target) => UPSTREAM_ROCM_GFX.has(target))
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
    ...(features?.opencl ? { opencl: true } : {}),
  }
}

// ---------------------------------------------------------------------------------------------
// Supported matrix (determine_supported_backends) and catalog merge (list_supported_backends)
// ---------------------------------------------------------------------------------------------

/**
 * Backend ids installable on `<osType>-<arch>` given the detected features. Windows x64 always has
 * CPU, then CUDA 12.4, the *family* ids `win-cuda-13-x64` / `win-rocm-x64` (concrete minors come
 * from the manifest, ATO-105) and Vulkan. Windows arm64: CPU, OpenCL on an Adreno GPU, the
 * `win-cuda-13-arm64` family and Vulkan. Linux x64: CPU, the `linux-cuda-12-x64` /
 * `linux-cuda-13-x64` families, the supported ROCm build and Vulkan. Linux arm64: CPU, Vulkan and
 * the `linux-cuda-13-arm64` family (NVIDIA GB10 / Grace hosts); the Snapdragon build is not
 * offered. macOS its single arch build. Anything else is `INVALID_ARGUMENT`.
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
      if (features.opencl) supported.push('win-opencl-adreno-arm64')
      if (features.cuda13) supported.push('win-cuda-13-arm64')
      if (features.vulkan) supported.push('win-vulkan-arm64')
      break
    case 'linux-x86_64':
    case 'linux-x86':
      supported.push('linux-cpu-x64')
      if (features.cuda12) supported.push('linux-cuda-12-x64')
      if (features.cuda13) supported.push('linux-cuda-13-x64')
      if (features.rocm) supported.push(LINUX_ROCM_BACKEND)
      if (features.vulkan) supported.push('linux-vulkan-x64')
      break
    case 'linux-aarch64':
    case 'linux-arm64':
      supported.push('linux-cpu-arm64')
      if (features.vulkan) supported.push('linux-vulkan-arm64')
      if (features.cuda13) supported.push('linux-cuda-13-arm64')
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
 * Linux gates ROCm on support for the published build and CUDA (x64 12/13, arm64 13) on its family
 * id: CUDA ranks above every other category, so an unfiltered entry would be recommended to a host
 * without an NVIDIA GPU or below the driver floor. Every other OS returns the list unfiltered (the
 * manifest parser already applied the arch filter).
 */
export function filterBackendsBySupport(
  merged: readonly BackendVersion[],
  supportedBackends: readonly string[],
  osType: string
): BackendVersion[] {
  const supportedSet = new Set(supportedBackends)
  if (osType === 'linux') {
    return merged.filter((b) => {
      const raw = stripBom(b.backend)
      if (/^(linux|ubuntu)-rocm-/.test(raw))
        return mapOldBackendToNew(raw) === LINUX_ROCM_BACKEND && supportedSet.has(LINUX_ROCM_BACKEND)
      const m = /^linux-cuda-(\d+)\.\d+-(x64|arm64)$/.exec(raw)
      return !m || supportedSet.has(`linux-cuda-${m[1]}-${m[2]}`)
    })
  }
  if (osType !== 'windows') return [...merged]
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
