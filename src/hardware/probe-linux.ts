/**
 * Linux: `/proc/cpuinfo`, `/etc/os-release`, the `/sys/class/drm` walk, the Vulkan ICD directories,
 * `nvidia-smi` (first candidate that starts; legacy field set when the driver refuses `compute_cap`)
 * and `vulkaninfo --summary` from PATH. Everything runs at once; every failure is one warning.
 */

import { parseProcCpuinfo, isX86Arch } from './cpu-flags.js'
import { isCardNode, sysfsGpuFromFiles } from './drm-sysfs.js'
import type { SysfsGpu } from './drm-sysfs.js'
import { assembleSystemInfo, mergeGpus } from './merge.js'
import { PROBE_TOOL_TIMEOUT_MS, commonFacts, firstLine, runNvidiaSmi, settledOrWarn } from './probe-common.js'
import type { HardwareProbeResult, ProbeDeps } from './probe-common.js'
import { icdVendorOf, linuxIcdDirs, parseVulkaninfoSummary } from './vulkan.js'
import type { VulkanDevice } from './vulkan.js'

const DRM_DIR = '/sys/class/drm'

export async function probeLinux(deps: ProbeDeps): Promise<HardwareProbeResult> {
  const warnings: string[] = []
  const common = commonFacts(deps)
  const [cpuinfo, osRelease, drm, icd, nvidia, vulkan] = await Promise.allSettled([
    deps.fs.readFile('/proc/cpuinfo'),
    deps.fs.readFile('/etc/os-release'),
    scanDrm(deps),
    scanIcdDirs(deps),
    runNvidiaSmi(deps),
    runVulkaninfo(deps),
  ])

  const parsedCpu = settledOrWarn(cpuinfo, '/proc/cpuinfo', warnings)
  const cpu = parsedCpu ? parseProcCpuinfo(parsedCpu) : undefined
  // No `flags` line on a non-x86 kernel is the normal case (arm64 has no x86 extensions); on x86 it is unknown.
  const extensions = cpu?.flags ?? (parsedCpu !== undefined && !isX86Arch(common.arch) ? [] : undefined)

  const osReleaseText = settledOrWarn(osRelease, '/etc/os-release', warnings)
  const osName = (osReleaseText && prettyName(osReleaseText)) || 'Linux'

  const pci = settledOrWarn(drm, DRM_DIR, warnings) ?? []
  const icdVendors = settledOrWarn(icd, 'vulkan icd.d', warnings) ?? new Set<string>()
  const nvidiaRows = settledOrWarn(nvidia, 'nvidia-smi', warnings) ?? []
  const vulkanDevices = settledOrWarn(vulkan, 'vulkaninfo', warnings) ?? []

  const merged = mergeGpus({
    nvidia: nvidiaRows,
    pci,
    vulkan: vulkanDevices,
    icdVendors,
    loaderPresent: true,
  })
  warnings.push(...merged.warnings)

  return {
    info: assembleSystemInfo({
      cpu: {
        name: cpu?.modelName ?? common.cpuName ?? 'Unknown CPU',
        coreCount: cpu?.physicalCores ?? common.logicalCores,
        arch: common.arch,
        extensions,
      },
      osType: 'linux',
      osName,
      totalMemoryMiB: common.totalMemoryMiB,
      gpus: merged.gpus,
    }),
    warnings,
  }
}

/** `PRETTY_NAME="Ubuntu 24.04.1 LTS"` → `Ubuntu 24.04.1 LTS`; falls back to `NAME`. */
export function prettyName(osRelease: string): string | undefined {
  const pick = (key: string) => {
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(osRelease)
    const value = m?.[1]
      ?.trim()
      .replace(/^"(.*)"$/, '$1')
      .replace(/^'(.*)'$/, '$1')
    return value ? value : undefined
  }
  return pick('PRETTY_NAME') ?? pick('NAME')
}

/** Every `card<N>` under `/sys/class/drm` that has a readable PCI vendor and device id. */
async function scanDrm(deps: ProbeDeps): Promise<SysfsGpu[]> {
  const nodes = (await deps.fs.readdir(DRM_DIR)).filter(isCardNode).sort(byCardNumber)
  const gpus: SysfsGpu[] = []
  for (const card of nodes) {
    const device = `${DRM_DIR}/${card}/device`
    const [vendor, deviceId, vramTotal, bootVga, deviceLink, driverLink] = await Promise.all([
      deps.fs.readFile(`${device}/vendor`).catch(() => undefined),
      deps.fs.readFile(`${device}/device`).catch(() => undefined),
      deps.fs.readFile(`${device}/mem_info_vram_total`).catch(() => undefined),
      deps.fs.readFile(`${device}/boot_vga`).catch(() => undefined),
      deps.fs.readlink(device).catch(() => undefined),
      deps.fs.readlink(`${device}/driver`).catch(() => undefined),
    ])
    if (vendor === undefined || deviceId === undefined) continue // a virtual or platform device
    const gpu = sysfsGpuFromFiles({
      card,
      vendor,
      device: deviceId,
      ...(vramTotal !== undefined ? { vramTotal } : {}),
      ...(bootVga !== undefined ? { bootVga } : {}),
      ...(deviceLink !== undefined ? { deviceLink } : {}),
      ...(driverLink !== undefined ? { driverLink } : {}),
    })
    if (gpu) gpus.push(gpu)
  }
  return gpus
}

function byCardNumber(a: string, b: string): number {
  return Number(a.slice(4)) - Number(b.slice(4))
}

/** Vendors with an ICD manifest in any of the loader's directories; a missing directory is not an error. */
async function scanIcdDirs(deps: ProbeDeps): Promise<Set<string>> {
  const vendors = new Set<string>()
  for (const dir of linuxIcdDirs(deps.env)) {
    const entries = await deps.fs.readdir(dir).catch(() => [] as string[])
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const vendor = icdVendorOf(entry)
      if (vendor) vendors.add(vendor)
    }
  }
  return vendors
}

/** `vulkaninfo` is optional tooling; absent is silent, a failed run is a warning. */
async function runVulkaninfo(deps: ProbeDeps): Promise<VulkanDevice[]> {
  let result
  try {
    result = await deps.run('vulkaninfo', ['--summary'], PROBE_TOOL_TIMEOUT_MS)
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 'ENOENT') return []
    throw error
  }
  if (result.code !== 0)
    throw new Error(
      `vulkaninfo exited with ${result.code ?? 'signal'}: ${firstLine(result.stderr) || firstLine(result.stdout)}`
    )
  return parseVulkaninfoSummary(result.stdout)
}
