/**
 * Windows: one `powershell.exe` run (`WINDOWS_PROBE_SCRIPT`: adapters, class registry, CPU, OS, Vulkan
 * loader, CPU flags) and `nvidia-smi`, in parallel. PowerShell failing leaves the CPU flags unknown and
 * the GPU list to nvidia-smi alone; nvidia-smi missing is the normal case without an NVIDIA driver.
 */

import { cpuExtensionsFromWindowsPf } from './cpu-flags.js'
import { assembleSystemInfo, mergeGpus } from './merge.js'
import {
  PROBE_POWERSHELL_TIMEOUT_MS,
  commonFacts,
  firstLine,
  runNvidiaSmi,
  settledOrWarn,
} from './probe-common.js'
import type { HardwareProbeResult, ProbeDeps } from './probe-common.js'
import { coreCount, osName, parseWindowsProbe, windowsGpus, windowsProbeArgs } from './windows-video.js'
import type { WindowsProbe } from './windows-video.js'

export async function probeWindows(deps: ProbeDeps): Promise<HardwareProbeResult> {
  const warnings: string[] = []
  const common = commonFacts(deps)
  const [powershell, nvidia] = await Promise.allSettled([runPowerShellProbe(deps), runNvidiaSmi(deps)])
  const probe = settledOrWarn(powershell, 'powershell', warnings)
  const nvidiaRows = settledOrWarn(nvidia, 'nvidia-smi', warnings) ?? []

  const adapters = probe ? windowsGpus(probe) : undefined
  if (adapters) warnings.push(...adapters.warnings)
  const merged = mergeGpus({
    nvidia: nvidiaRows,
    pci: adapters?.adapters ?? [],
    vulkan: [],
    icdVendors: adapters?.icdVendors ?? new Set<string>(),
    // Without the PowerShell answer the loader's presence is unknown; an nvidia-smi GPU is still a GPU.
    loaderPresent: probe ? probe.vulkan.dll : true,
  })
  warnings.push(...merged.warnings)

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
