/**
 * One GPU list from several partial views: nvidia-smi (driver version, compute capability, VRAM —
 * authoritative for NVIDIA), the PCI enumeration (sysfs on Linux, CIM + registry on Windows — every
 * vendor's device id and, for the others, VRAM) and Vulkan (vulkaninfo's exact device type, or only
 * the ICD registrations). Each GPU appears once; the selectors then read `nvidia_info`, `vendor`,
 * `driver_version`, `total_memory` and `vulkan_info.device_id` / `device_type` from it.
 *
 * Pure. `hardware/` never imports from `backend/`; the selectors' expectations are asserted in the test.
 */

import type { CpuInfo, GpuInfo, OsType, SystemInfo, VulkanGpuInfo } from '../contracts/index.js'
import { vendorName } from './drm-sysfs.js'
import type { SysfsGpu } from './drm-sysfs.js'
import { guessDeviceType } from './vulkan.js'
import type { VulkanDevice } from './vulkan.js'
import type { WindowsAdapter } from './windows-video.js'

/** An nvidia-smi row as a `GpuInfo`, with the bus id it is matched to the PCI enumeration by. */
export interface NvidiaSmiGpu {
  gpu: GpuInfo
  /** sysfs spelling (`0000:01:00.0`); absent when the tool did not report it. */
  busId?: string
}

export interface MergeInput {
  nvidia: NvidiaSmiGpu[]
  /** Linux `SysfsGpu` rows or Windows `WindowsAdapter` rows, never mixed. */
  pci: Array<SysfsGpu | WindowsAdapter>
  /** `vulkaninfo --summary` devices, empty when the tool is not installed. */
  vulkan: VulkanDevice[]
  /** Vendors with a registered ICD (`NVIDIA`, `AMD`, `Intel`). */
  icdVendors: Set<string>
  /** `false` when the loader is known to be missing (no `vulkan-1.dll`); a registered ICD is then useless. */
  loaderPresent: boolean
}

function isWindowsAdapter(row: SysfsGpu | WindowsAdapter): row is WindowsAdapter {
  return 'pnpDeviceId' in row
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * nvidia-smi rows first, in their order, then the PCI-only GPUs in enumeration order, then any Vulkan
 * device neither list knew. A PCI NVIDIA device nvidia-smi did not report (nouveau, a driver that is not
 * loaded) is listed with `nvidia_info: null`: the CUDA tiers need the driver version, and there is none.
 */
export function mergeGpus(input: MergeInput): { gpus: GpuInfo[]; warnings: string[] } {
  const warnings: string[] = []
  const gpus: GpuInfo[] = []
  const pci = input.pci.map((row) => ({ row, taken: false }))
  const vulkan = input.vulkan.map((device) => ({ device, taken: false }))

  const takeVulkan = (pick: (device: VulkanDevice) => boolean): VulkanDevice | undefined => {
    const entry = vulkan.find((e) => !e.taken && pick(e.device))
    if (entry) entry.taken = true
    return entry?.device
  }
  const takePci = (
    pick: (row: SysfsGpu | WindowsAdapter) => boolean
  ): SysfsGpu | WindowsAdapter | undefined => {
    const entry = pci.find((e) => !e.taken && pick(e.row))
    if (entry) entry.taken = true
    return entry?.row
  }
  const vulkanFromDevice = (device: VulkanDevice): VulkanGpuInfo => ({
    index: device.index,
    device_type: device.deviceType,
    api_version: device.apiVersion,
    device_id: device.deviceId,
  })
  const vulkanFromIcd = (
    position: number,
    vendor: string,
    deviceId: number,
    vramTotalMiB: number | undefined,
    adapterHasIcd: boolean
  ): VulkanGpuInfo | null => {
    if (!input.loaderPresent) return null
    if (!adapterHasIcd && !input.icdVendors.has(vendor)) return null
    return {
      index: position,
      device_type: guessDeviceType({
        vendor,
        deviceId,
        ...(vramTotalMiB !== undefined ? { vramTotalMiB } : {}),
      }),
      api_version: '',
      device_id: deviceId,
    }
  }

  for (const { gpu, busId } of input.nvidia) {
    const matched =
      (busId ? takePci((row) => !isWindowsAdapter(row) && row.busId === busId) : undefined) ??
      takePci((row) => isWindowsAdapter(row) && row.vendorId === 0x10de && sameName(row.name, gpu.name))
    const deviceId = matched?.deviceId
    const device =
      deviceId !== undefined
        ? takeVulkan((d) => d.vendorId === 0x10de && d.deviceId === deviceId)
        : takeVulkan((d) => d.vendorId === 0x10de && sameName(d.deviceName, gpu.name))
    const vramTotalMiB = matched?.vramTotalMiB
    const merged: GpuInfo = {
      ...gpu,
      total_memory: gpu.total_memory > 0 ? gpu.total_memory : (vramTotalMiB ?? 0),
      uuid: gpu.uuid !== '' ? gpu.uuid : matched ? opaqueId(matched) : `nvidia-${gpus.length}`,
      vulkan_info: device
        ? vulkanFromDevice(device)
        : vulkanFromIcd(
            gpus.length,
            'NVIDIA',
            deviceId ?? 0,
            vramTotalMiB,
            matched !== undefined && isWindowsAdapter(matched) && matched.vulkanDriver
          ),
    }
    gpus.push(merged)
  }

  for (const entry of pci) {
    if (entry.taken) continue
    entry.taken = true
    const row = entry.row
    const vendor = vendorName(row.vendorId)
    const device = takeVulkan((d) => d.vendorId === row.vendorId && d.deviceId === row.deviceId)
    const windows = isWindowsAdapter(row) ? row : undefined
    const name =
      windows?.name ?? device?.deviceName ?? `${vendor} GPU 0x${row.deviceId.toString(16).padStart(4, '0')}`
    if (row.vendorId === 0x10de)
      warnings.push(
        `${name}: NVIDIA GPU without an nvidia-smi answer; driver version and compute capability unknown`
      )
    gpus.push({
      name,
      total_memory: row.vramTotalMiB ?? 0,
      vendor,
      uuid: opaqueId(row),
      driver_version: windows?.driverVersion ?? device?.driverVersion ?? '',
      nvidia_info: null,
      vulkan_info: device
        ? vulkanFromDevice(device)
        : vulkanFromIcd(gpus.length, vendor, row.deviceId, row.vramTotalMiB, windows?.vulkanDriver ?? false),
    })
  }

  for (const entry of vulkan) {
    if (entry.taken) continue
    entry.taken = true
    const device = entry.device
    const vendor = vendorName(device.vendorId)
    warnings.push(`${device.deviceName || vendor}: enumerated by Vulkan only; no PCI record for it`)
    gpus.push({
      name: device.deviceName || `${vendor} GPU 0x${device.deviceId.toString(16).padStart(4, '0')}`,
      total_memory: 0,
      vendor,
      uuid: `vulkan-${device.index}`,
      driver_version: device.driverVersion,
      nvidia_info: null,
      vulkan_info: vulkanFromDevice(device),
    })
  }

  return { gpus, warnings }
}

/** The stable id of a non-NVIDIA GPU: the PNP instance on Windows, the PCI bus id (or DRM node) on Linux. */
function opaqueId(row: SysfsGpu | WindowsAdapter): string {
  return isWindowsAdapter(row) ? row.pnpDeviceId : (row.busId ?? row.card)
}

export interface AssembleInput {
  cpu: {
    name: string
    coreCount: number
    /** Rust spelling, `x86_64` / `arm64`. */
    arch: string
    /** Plugin-spelled flags, or `undefined` when the probe could not read them. */
    extensions: string[] | undefined
  }
  osType: OsType
  osName: string
  totalMemoryMiB: number
  gpus: GpuInfo[]
}

/** The `SystemInfo` the core serves; `extensions_known` is the one field the plugin never had. */
export function assembleSystemInfo(input: AssembleInput): SystemInfo {
  const cpu: CpuInfo = {
    name: input.cpu.name,
    core_count: input.cpu.coreCount,
    arch: input.cpu.arch,
    extensions: input.cpu.extensions ? [...input.cpu.extensions] : [],
    extensions_known: input.cpu.extensions !== undefined,
  }
  return {
    cpu,
    os_type: input.osType,
    os_name: input.osName,
    total_memory: input.totalMemoryMiB,
    gpus: input.gpus,
  }
}
