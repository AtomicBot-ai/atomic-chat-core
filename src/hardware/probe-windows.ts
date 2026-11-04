/**
 * Windows: one `powershell.exe` run (`WINDOWS_PROBE_SCRIPT`: adapters, class registry, CPU, OS, Vulkan
 * loader, CPU flags) and `nvidia-smi`, in parallel. nvidia-smi missing is the normal case without an
 * NVIDIA driver.
 *
 * PowerShell failing (blocked by AppLocker or AMSI, past its deadline on a cold start), or answering
 * no video controller at all (a broken WMI repository; every Windows has at least the basic display
 * adapter), used to leave the GPU list to nvidia-smi alone: AMD and Intel GPUs vanished. The display
 * class key is then read with `reg.exe` instead (`windows-registry.ts`) and merged with nvidia-smi the
 * same way. CPU flags have no such second source and stay unknown without PowerShell. A result that
 * still has no GPU, or that no enumeration but nvidia-smi produced, is marked `degraded`, so the
 * service probes again later instead of keeping it.
 */

import type { HardwareGpuSource } from '../contracts/index.js'
import { cpuExtensionsFromWindowsPf } from './cpu-flags.js'
import { assembleSystemInfo, mergeGpus } from './merge.js'
import {
  PROBE_POWERSHELL_TIMEOUT_MS,
  PROBE_TOOL_TIMEOUT_MS,
  commonFacts,
  firstLine,
  runNvidiaSmi,
  settledOrWarn,
  warningOf,
} from './probe-common.js'
import type { HardwareProbeResult, ProbeDeps } from './probe-common.js'
import { coreCount, osName, parseWindowsProbe, windowsGpus, windowsProbeArgs } from './windows-video.js'
import type { WindowsAdapter, WindowsProbe } from './windows-video.js'
import {
  DISPLAY_CLASS_REG_KEY,
  VULKAN_DRIVERS_REG_KEY,
  isDisplayDriverKey,
  parseRegQuery,
  regExePath,
  regQueryArgs,
  registryDisplayKeys,
  registryGpus,
  vulkanDriverPaths,
} from './windows-registry.js'
import type { RegKey } from './windows-registry.js'

interface AdapterList {
  adapters: WindowsAdapter[]
  icdVendors: Set<string>
  warnings: string[]
  loaderPresent: boolean
}

export async function probeWindows(deps: ProbeDeps): Promise<HardwareProbeResult> {
  const warnings: string[] = []
  const common = commonFacts(deps)
  const [powershell, nvidia] = await Promise.allSettled([runPowerShellProbe(deps), runNvidiaSmi(deps)])
  const probe = settledOrWarn(powershell, 'powershell', warnings)
  const nvidiaRows = settledOrWarn(nvidia, 'nvidia-smi', warnings) ?? []

  let list: AdapterList | undefined
  let gpuSource: HardwareGpuSource
  if (probe && probe.video.length > 0) {
    list = { ...windowsGpus(probe), loaderPresent: probe.vulkan.dll }
    gpuSource = 'powershell'
  } else {
    if (probe)
      warnings.push('powershell: Win32_VideoController answered nothing; reading GPUs from the registry')
    try {
      list = await registryAdapters(
        deps,
        nvidiaRows.map((row) => row.gpu.name)
      )
      gpuSource = 'registry'
    } catch (error) {
      warnings.push(warningOf('registry', error))
      gpuSource = nvidiaRows.length > 0 ? 'nvidia-smi' : 'none'
    }
  }
  if (list) warnings.push(...list.warnings)
  const merged = mergeGpus({
    nvidia: nvidiaRows,
    pci: list?.adapters ?? [],
    vulkan: [],
    icdVendors: list?.icdVendors ?? new Set<string>(),
    // Without an answer the loader's presence is unknown; an nvidia-smi GPU is still a GPU.
    loaderPresent: list ? list.loaderPresent : true,
  })
  warnings.push(...merged.warnings)
  const degraded = gpuSource !== 'powershell' && (gpuSource !== 'registry' || merged.gpus.length === 0)

  return {
    info: assembleSystemInfo({
      cpu: {
        name: probe?.cpu[0]?.Name?.trim() || common.cpuName || 'Unknown CPU',
        coreCount: (probe && coreCount(probe)) ?? common.logicalCores,
        arch: common.arch,
        extensions: probe ? cpuExtensionsFromWindowsPf(probe.pf, probe.build, common.arch) : undefined,
      },
      osType: 'windows',
      osName: (probe && osName(probe)) ?? 'Windows',
      totalMemoryMiB: common.totalMemoryMiB,
      gpus: merged.gpus,
    }),
    warnings,
    gpuSource,
    ...(degraded ? { degraded: true } : {}),
  }
}

async function runPowerShellProbe(deps: ProbeDeps): Promise<WindowsProbe> {
  const result = await deps.run('powershell.exe', windowsProbeArgs(), PROBE_POWERSHELL_TIMEOUT_MS)
  if (result.code !== 0)
    throw new Error(
      `powershell.exe exited with ${result.code ?? 'signal'}: ${firstLine(result.stderr) || firstLine(result.stdout)}`
    )
  return parseWindowsProbe(result.stdout)
}

async function runRegQuery(deps: ProbeDeps, reg: string, key: string): Promise<RegKey[]> {
  const result = await deps.run(reg, regQueryArgs(key), PROBE_TOOL_TIMEOUT_MS)
  if (result.code !== 0)
    throw new Error(
      `reg.exe query ${key} exited with ${result.code ?? 'signal'}: ${firstLine(result.stderr) || firstLine(result.stdout)}`
    )
  return parseRegQuery(result.stdout)
}

/**
 * The display class key's driver instances, one `reg query` each (a recursive query would also walk
 * the drivers' large private subkeys and the `Properties` key no user may open), the Khronos driver
 * registrations and `vulkan-1.dll`. Throws only when the class key itself cannot be read.
 */
async function registryAdapters(deps: ProbeDeps, nvidiaNames: string[]): Promise<AdapterList> {
  const reg = regExePath(deps.env)
  const root = await runRegQuery(deps, reg, DISPLAY_CLASS_REG_KEY)
  const children = root.map((key) => key.path).filter(isDisplayDriverKey)
  const systemRoot = deps.env['SystemRoot'] ?? deps.env['SYSTEMROOT'] ?? 'C:\\Windows'
  const [instances, drivers, loaderPresent] = await Promise.all([
    Promise.allSettled(children.map((path) => runRegQuery(deps, reg, path))),
    runRegQuery(deps, reg, VULKAN_DRIVERS_REG_KEY).catch(() => [] as RegKey[]),
    deps.fs.exists(`${systemRoot}\\System32\\vulkan-1.dll`),
  ])
  const warnings: string[] = []
  const keys = instances.flatMap((settled) => settledOrWarn(settled, 'registry', warnings) ?? [])
  const gpus = registryGpus(registryDisplayKeys(keys), vulkanDriverPaths(drivers), nvidiaNames)
  return { ...gpus, warnings: [...warnings, ...gpus.warnings], loaderPresent }
}
