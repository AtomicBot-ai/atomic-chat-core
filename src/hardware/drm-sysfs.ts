/**
 * Linux GPUs from sysfs: `/sys/class/drm/card<N>/device/{vendor,device,mem_info_vram_total,boot_vga}`
 * plus the `device` and `driver` symlinks for the PCI bus id and the kernel driver. This sees every
 * PCI GPU the kernel bound a DRM driver to — AMD, Intel and NVIDIA alike — without any vendor tool.
 *
 * Pure: file contents in, `SysfsGpu` out. The walk itself is in `probe-linux.ts`.
 */

/** PCI vendor ids as sysfs prints them (`0x10de`). Qualcomm's is the one Vulkan reports for Adreno. */
export const PCI_VENDOR = { NVIDIA: 0x10de, AMD: 0x1002, INTEL: 0x8086, QUALCOMM: 0x5143 } as const

/** The plugin's vendor spelling, `Unknown (vendor_id: N)` for anyone else. */
export function vendorName(vendorId: number): string {
  if (vendorId === PCI_VENDOR.NVIDIA) return 'NVIDIA'
  if (vendorId === PCI_VENDOR.AMD) return 'AMD'
  if (vendorId === PCI_VENDOR.INTEL) return 'Intel'
  if (vendorId === PCI_VENDOR.QUALCOMM) return 'Qualcomm'
  return `Unknown (vendor_id: ${vendorId})`
}

/** `0x10de\n` → 4318; `undefined` for anything that is not a hex number. */
export function parseHexId(text: string): number | undefined {
  const trimmed = text.trim().replace(/^0x/i, '')
  if (!/^[0-9a-f]{1,8}$/i.test(trimmed)) return undefined
  return Number.parseInt(trimmed, 16)
}

/** `card0`, `card1`, … — not `card0-DP-1` (a connector) and not `renderD128`. */
export function isCardNode(name: string): boolean {
  return /^card\d+$/.test(name)
}

export interface SysfsGpu {
  /** The DRM node name, `card0`. */
  card: string
  /** `0000:01:00.0`, from the `device` symlink; absent for a non-PCI device (a virtual GPU). */
  busId?: string
  vendorId: number
  deviceId: number
  /** The kernel driver bound to the device (`amdgpu`, `i915`, `nvidia`, `nouveau`); absent when unbound. */
  driver?: string
  /** `mem_info_vram_total` in MiB; only `amdgpu` exposes it. */
  vramTotalMiB?: number
  /** The GPU the firmware booted with, when the kernel says. */
  bootVga?: boolean
}

export interface SysfsGpuFiles {
  card: string
  /** Contents of `device/vendor`. */
  vendor: string
  /** Contents of `device/device`. */
  device: string
  /** Contents of `device/mem_info_vram_total`, bytes. */
  vramTotal?: string
  /** Contents of `device/boot_vga`, `0` or `1`. */
  bootVga?: string
  /** Target of the `device` symlink (`../../../0000:01:00.0`). */
  deviceLink?: string
  /** Target of the `device/driver` symlink (`../../../../bus/pci/drivers/amdgpu`). */
  driverLink?: string
}

const PCI_BUS_ID = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]$/i

/** One card's files → `SysfsGpu`; `undefined` when the vendor or device id is unreadable. */
export function sysfsGpuFromFiles(files: SysfsGpuFiles): SysfsGpu | undefined {
  const vendorId = parseHexId(files.vendor)
  const deviceId = parseHexId(files.device)
  if (vendorId === undefined || deviceId === undefined) return undefined
  const gpu: SysfsGpu = { card: files.card, vendorId, deviceId }
  const busId = lastSegment(files.deviceLink)
  if (busId && PCI_BUS_ID.test(busId)) gpu.busId = busId.toLowerCase()
  const driver = lastSegment(files.driverLink)
  if (driver) gpu.driver = driver
  if (files.vramTotal !== undefined) {
    const bytes = Number(files.vramTotal.trim())
    if (Number.isFinite(bytes) && bytes > 0) gpu.vramTotalMiB = Math.floor(bytes / 2 ** 20)
  }
  if (files.bootVga !== undefined) {
    const value = files.bootVga.trim()
    if (value === '1') gpu.bootVga = true
    else if (value === '0') gpu.bootVga = false
  }
  return gpu
}

function lastSegment(link: string | undefined): string | undefined {
  if (link === undefined) return undefined
  const segment = link.trim().split('/').filter(Boolean).pop()
  return segment === undefined || segment === '' ? undefined : segment
}
