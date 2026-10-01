/**
 * macOS: `sysctl` for the physical core count, the CPU name and (Intel only) the x86 feature lists,
 * `sw_vers` for the OS name. No GPUs, on purpose: the plugin reported none on macOS either, and the
 * backend there is a single Metal build that no hardware fact selects between.
 */

import { isX86Arch, parseDarwinCpuFeatures } from './cpu-flags.js'
import { assembleSystemInfo } from './merge.js'
import { PROBE_TOOL_TIMEOUT_MS, commonFacts, firstLine, settledOrWarn } from './probe-common.js'
import type { HardwareProbeResult, ProbeDeps } from './probe-common.js'

const SYSCTL = '/usr/sbin/sysctl'
const SW_VERS = '/usr/bin/sw_vers'

export async function probeDarwin(deps: ProbeDeps): Promise<HardwareProbeResult> {
  const warnings: string[] = []
  const common = commonFacts(deps)
  const x86 = isX86Arch(common.arch)
  const keys = [
    'hw.physicalcpu',
    'machdep.cpu.brand_string',
    ...(x86 ? ['machdep.cpu.features', 'machdep.cpu.leaf7_features'] : []),
  ]
  const [sysctl, swVers] = await Promise.allSettled([
    runOrThrow(deps, SYSCTL, ['-n', ...keys]),
    runOrThrow(deps, SW_VERS, []),
  ])

  // `sysctl -n a b c` prints one value per line, in the order asked.
  const values = settledOrWarn(sysctl, 'sysctl', warnings)?.split('\n') ?? []
  const physicalCpu = Number(values[0]?.trim())
  const brand = values[1]?.trim()
  let extensions: string[] | undefined
  if (!x86) extensions = []
  else if (values.length >= 4) extensions = parseDarwinCpuFeatures(values[2] ?? '', values[3] ?? '')

  const versText = settledOrWarn(swVers, 'sw_vers', warnings)
  const osName = versText ? parseSwVers(versText) : 'macOS'

  return {
    info: assembleSystemInfo({
      cpu: {
        name: brand || common.cpuName || 'Unknown CPU',
        coreCount: Number.isInteger(physicalCpu) && physicalCpu > 0 ? physicalCpu : common.logicalCores,
        arch: common.arch,
        extensions,
      },
      osType: 'macos',
      osName,
      totalMemoryMiB: common.totalMemoryMiB,
      gpus: [],
    }),
    warnings,
  }
}

/** RAM the GPU shares with the system: half of it is what the llama.cpp fit margin leaves to the rest. */
export interface UnifiedMemoryProbe {
  totalMemoryBytes: number
}

/**
 * Apple silicon only, where the GPU works out of system RAM; `undefined` on an Intel Mac and on
 * every other platform. How much of that RAM Metal lets the GPU use is llama.cpp's to report
 * (`--list-devices`): Apple's rule has changed across macOS releases, and `iogpu.wired_limit_mb`
 * overrides it.
 */
export function probeUnifiedMemory(deps: ProbeDeps): UnifiedMemoryProbe | undefined {
  const common = commonFacts(deps)
  if (deps.platform !== 'darwin' || common.arch !== 'arm64' || common.totalMemoryMiB <= 0) return undefined
  return { totalMemoryBytes: common.totalMemoryMiB * 2 ** 20 }
}

/** `ProductName:\t\tmacOS\nProductVersion:\t\t15.5\n…` → `macOS 15.5`. */
export function parseSwVers(text: string): string {
  const pick = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(text)?.[1]?.trim()
  const name = pick('ProductName') || 'macOS'
  const version = pick('ProductVersion')
  return version ? `${name} ${version}` : name
}

async function runOrThrow(deps: ProbeDeps, file: string, args: string[]): Promise<string> {
  const result = await deps.run(file, args, PROBE_TOOL_TIMEOUT_MS)
  if (result.code !== 0)
    throw new Error(
      `${file} exited with ${result.code ?? 'signal'}: ${firstLine(result.stderr) || firstLine(result.stdout)}`
    )
  return result.stdout
}
