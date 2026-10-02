/**
 * Vulkan without linking a loader: the ICD registrations the loader would read (`icd.d/*.json` on
 * Linux, `HKLM\SOFTWARE\Khronos\Vulkan\Drivers` on Windows) say which vendors have a Vulkan driver
 * installed; `vulkaninfo --summary`, when the tools package is installed, says exactly which devices
 * enumerate and whether they are discrete or integrated.
 *
 * Pure. When only the ICD is known, `guessDeviceType` gives the best answer it can and says `Unknown`
 * otherwise, which the selectors treat as "not proven integrated".
 */

/** The loader's search order on Linux (`loader_and_layer_interface.md`), user directories included. */
export function linuxIcdDirs(env: NodeJS.ProcessEnv): string[] {
  const dirs = [
    '/usr/share/vulkan/icd.d',
    '/etc/vulkan/icd.d',
    '/usr/local/share/vulkan/icd.d',
    '/usr/local/etc/vulkan/icd.d',
  ]
  const home = env['HOME']
  const dataHome = env['XDG_DATA_HOME'] || (home ? `${home}/.local/share` : undefined)
  if (dataHome) dirs.push(`${dataHome}/vulkan/icd.d`)
  const configHome = env['XDG_CONFIG_HOME'] || (home ? `${home}/.config` : undefined)
  if (configHome) dirs.push(`${configHome}/vulkan/icd.d`)
  for (const dir of (env['XDG_DATA_DIRS'] ?? '').split(':')) if (dir) dirs.push(`${dir}/vulkan/icd.d`)
  return [...new Set(dirs)]
}

/**
 * The vendor an ICD manifest belongs to, from its file name (`nvidia_icd.json`, `radeon_icd.x86_64.json`,
 * `intel_icd.x86_64.json`, Windows `nv-vk64.json` / `amd-vulkan64.json` / `igvk64.json`). Software and
 * pass-through drivers (`lvp_icd`, `virtio_icd`, `dzn_icd`) are nobody's GPU.
 */
export function icdVendorOf(fileName: string): string | undefined {
  const name = fileName.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (/^(nvidia_icd|nv-vk)/.test(name)) return 'NVIDIA'
  if (/^(radeon_icd|amd_icd|amd-vulkan|amd_pro_icd)/.test(name)) return 'AMD'
  if (/^(intel_icd|intel_hasvk|igvk)/.test(name)) return 'Intel'
  if (/^(qcvk|qc_vk|qualcomm|adreno|freedreno_icd)/.test(name)) return 'Qualcomm'
  return undefined
}

export interface VulkanDevice {
  /** `GPUn` in `vulkaninfo --summary`. */
  index: number
  apiVersion: string
  driverVersion: string
  vendorId: number
  deviceId: number
  /** Plugin spelling: `DiscreteGpu`, `IntegratedGpu`, `VirtualGpu`, `Other`, `Unknown`. */
  deviceType: string
  deviceName: string
}

/** `PHYSICAL_DEVICE_TYPE_DISCRETE_GPU` → `DiscreteGpu`, as vulkano serialises `PhysicalDeviceType`. */
export function mapVulkanDeviceType(raw: string): string {
  switch (raw.trim().toUpperCase()) {
    case 'PHYSICAL_DEVICE_TYPE_DISCRETE_GPU':
      return 'DiscreteGpu'
    case 'PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU':
      return 'IntegratedGpu'
    case 'PHYSICAL_DEVICE_TYPE_VIRTUAL_GPU':
      return 'VirtualGpu'
    case 'PHYSICAL_DEVICE_TYPE_CPU':
      return 'Cpu'
    case 'PHYSICAL_DEVICE_TYPE_OTHER':
      return 'Other'
    default:
      return 'Unknown'
  }
}

/**
 * The `GPUn:` blocks of `vulkaninfo --summary`. Software rasterisers (`PHYSICAL_DEVICE_TYPE_CPU`,
 * llvmpipe) are dropped: they are not a GPU the Vulkan backend should be chosen for.
 */
export function parseVulkaninfoSummary(text: string): VulkanDevice[] {
  const devices: VulkanDevice[] = []
  let current: (Partial<VulkanDevice> & { index: number }) | undefined
  const flush = () => {
    if (!current) return
    if (current.vendorId !== undefined && current.deviceId !== undefined && current.deviceType !== 'Cpu') {
      devices.push({
        index: current.index,
        apiVersion: current.apiVersion ?? '',
        driverVersion: current.driverVersion ?? '',
        vendorId: current.vendorId,
        deviceId: current.deviceId,
        deviceType: current.deviceType ?? 'Unknown',
        deviceName: current.deviceName ?? '',
      })
    }
    current = undefined
  }
  for (const line of text.split(/\r?\n/)) {
    const header = /^GPU(\d+):\s*$/.exec(line.trim())
    if (header) {
      flush()
      current = { index: Number(header[1]) }
      continue
    }
    if (!current) continue
    const kv = /^\s*(\w+)\s*=\s*(.*)$/.exec(line)
    if (!kv) {
      // A non-indented line that is not a header ends the device list.
      if (line.trim() !== '' && !/^\s/.test(line)) flush()
      continue
    }
    const value = (kv[2] ?? '').trim()
    switch (kv[1]) {
      case 'apiVersion':
        current.apiVersion = value.split(/\s+/)[0] ?? ''
        break
      case 'driverVersion':
        current.driverVersion = value
        break
      case 'vendorID':
        current.vendorId = Number.parseInt(value.replace(/^0x/i, ''), 16)
        break
      case 'deviceID':
        current.deviceId = Number.parseInt(value.replace(/^0x/i, ''), 16)
        break
      case 'deviceType':
        current.deviceType = mapVulkanDeviceType(value)
        break
      case 'deviceName':
        current.deviceName = value
        break
    }
  }
  flush()
  return devices.filter((d) => Number.isFinite(d.vendorId) && Number.isFinite(d.deviceId))
}

/**
 * Discrete or integrated, without a Vulkan enumeration to ask. A heuristic, by design: NVIDIA sells
 * no integrated PCI GPUs; Intel's discrete Arc parts (Alchemist `0x56xx`, Battlemage `0xe2xx`) are
 * the only Intel GPUs that are not an iGPU; an AMD GPU whose driver reports under 1 GiB of VRAM is
 * an APU; Qualcomm Adreno is always part of the SoC. Everything else is `Unknown`, which
 * `integratedGpuOnly` does not count as integrated.
 */
export function guessDeviceType(gpu: { vendor: string; deviceId: number; vramTotalMiB?: number }): string {
  if (gpu.vendor === 'NVIDIA') return 'DiscreteGpu'
  if (gpu.vendor === 'Qualcomm') return 'IntegratedGpu'
  if (gpu.vendor === 'Intel') {
    const family = (gpu.deviceId >> 8) & 0xff
    return family === 0x56 || family === 0xe2 ? 'DiscreteGpu' : 'IntegratedGpu'
  }
  if (gpu.vendor === 'AMD' && gpu.vramTotalMiB !== undefined && gpu.vramTotalMiB < 1024)
    return 'IntegratedGpu'
  return 'Unknown'
}
