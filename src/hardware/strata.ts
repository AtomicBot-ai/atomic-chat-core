import type { SystemInfo } from '../contracts/index.js'
import { AMD_ROCM_WINDOWS_PCI_IDS } from '../backend/index.js'
import type { StrataDevice, StrataHostFacts } from '../runtime/strata/index.js'

export interface StrataHostDetails {
  osVersion?: string
  distribution?: string
  glibcVersion?: string
  /** Read from the device tree, not guessed from an sm_121 accelerator. */
  spark?: boolean
}

/** Extra Strata gates derived from the same measured hardware shown to app and CLI. */
export function strataHostFacts(info: SystemInfo, details: StrataHostDetails = {}): StrataHostFacts {
  const ramBytes = info.total_memory * 2 ** 20
  const arch = info.cpu.arch === 'x86_64' ? 'x64' : info.cpu.arch === 'aarch64' ? 'arm64' : info.cpu.arch
  const osVersion =
    details.osVersion ??
    (info.os_type === 'macos' ? /^macOS (\d+(?:\.\d+)*)$/.exec(info.os_name)?.[1] : undefined)
  const devices: StrataDevice[] = []
  if (info.os_type === 'macos' && arch === 'arm64' && ramBytes > 0)
    devices.push({
      id: 'apple:0',
      vendor: 'apple',
      architecture: 'apple-gpu',
      ordinal: 0,
      memoryBytes: ramBytes,
      unified: true,
    })
  for (const gpu of info.gpus) {
    const vendor = gpu.vendor.toLowerCase()
    if (!['nvidia', 'amd', 'intel'].includes(vendor)) continue
    let architecture: string | undefined, family: string | undefined
    const pci = gpu.vulkan_info?.device_id
    if (vendor === 'nvidia' && /^\d+\.\d+$/.test(gpu.nvidia_info?.compute_capability ?? '')) {
      architecture = 'sm_' + gpu.nvidia_info!.compute_capability.replace('.', '')
      if (details.spark && architecture === 'sm_121') family = 'dgx-spark'
    }
    if (vendor === 'amd') {
      architecture = AMD_ROCM_WINDOWS_PCI_IDS.find(([id]) => id === pci)?.[1]
      if (pci === 0x1586) family = 'strix-halo'
      if (pci === 0x7551) family = 'radeon-ai-pro-r9700'
    }
    // Discrete Arc PCI families. Integrated Intel GPUs must not qualify here.
    if (
      vendor === 'intel' &&
      gpu.vulkan_info?.device_type === 'DiscreteGpu' &&
      pci !== undefined &&
      ((pci >= 0x5690 && pci <= 0x56c1) || (pci >= 0xe200 && pci <= 0xe2ff))
    )
      architecture = 'intel-arc'
    const unified = family === 'strix-halo' || family === 'dgx-spark'
    const memory = unified
      ? Math.min(ramBytes, (gpu.shared_memory ?? gpu.total_memory) * 2 ** 20)
      : gpu.total_memory * 2 ** 20
    devices.push({
      // The hardware wire strips GPU- from real NVIDIA UUIDs. Residency uses the managed-engine ID.
      id:
        vendor === 'nvidia' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(gpu.uuid)
          ? 'GPU-' + gpu.uuid
          : gpu.uuid,
      name: gpu.name,
      vendor: vendor as StrataDevice['vendor'],
      ...(vendor === 'nvidia' && Number.isSafeInteger(gpu.nvidia_info?.index)
        ? { ordinal: gpu.nvidia_info!.index! }
        : {}),
      ...(architecture ? { architecture } : {}),
      ...(family ? { family } : {}),
      ...(gpu.driver_version ? { driverVersion: gpu.driver_version } : {}),
      unified,
      memoryBytes: memory,
    })
  }
  return {
    os: info.os_type,
    arch,
    ramBytes,
    devices,
    ...(osVersion ? { osVersion } : {}),
    ...(details.distribution ? { distribution: details.distribution } : {}),
    ...(details.glibcVersion ? { glibcVersion: details.glibcVersion } : {}),
    ...(info.cpu.extensions_known
      ? {
          cpuFeatures: info.cpu.extensions.map(
            (flag) => ({ asimddp: 'dotprod', asimdhp: 'fp16' })[flag as 'asimddp' | 'asimdhp'] ?? flag
          ),
        }
      : {}),
  }
}
