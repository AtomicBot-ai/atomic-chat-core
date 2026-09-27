/**
 * What the per-platform probes share: the injected dependency surface, the result shape, the budgets,
 * and the facts every platform reads the same way from `node:os`. Kept apart from `probe.ts` (the
 * runner and dispatcher) so the platform files and the dispatcher do not import each other.
 */

import type { SystemInfo } from '../contracts/index.js'
import { osTypeOf, rustArch } from './facts.js'
import type { NvidiaSmiGpu } from './merge.js'
import {
  NVIDIA_SMI_FIELDS,
  NVIDIA_SMI_FIELDS_LEGACY,
  isUnknownFieldError,
  nvidiaBusIdOf,
  nvidiaGpuFromRow,
  nvidiaSmiArgs,
  nvidiaSmiCandidates,
  parseNvidiaSmiCsv,
} from './nvidia-smi.js'

/** Per-tool budget: `nvidia-smi`, `vulkaninfo`, `sysctl`, `sw_vers`. */
export const PROBE_TOOL_TIMEOUT_MS = 5_000
/** PowerShell starts cold in seconds, more on a loaded machine; `Add-Type` compiles on top of that. */
export const PROBE_POWERSHELL_TIMEOUT_MS = 15_000
/** The runner's stdout cap; a `vulkaninfo --summary` is a few KiB, `/proc/cpuinfo` on a big host a few hundred. */
export const PROBE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

export interface ToolResult {
  stdout: string
  stderr: string
  /** The exit code; `null` when the process ended on a signal. */
  code: number | null
}

export interface ProbeFs {
  readFile: (path: string) => Promise<string>
  readdir: (path: string) => Promise<string[]>
  exists: (path: string) => Promise<boolean>
  readlink: (path: string) => Promise<string>
}

export interface ProbeDeps {
  platform: NodeJS.Platform | string
  /** Node spelling (`x64`, `arm64`); the probe converts. */
  arch: string
  env: NodeJS.ProcessEnv
  /**
   * Run a tool. Resolves with the exit code on a non-zero exit (the caller reads `stderr`); rejects
   * only when the tool could not be started (not found, not executable) or did not finish in time.
   */
  run: (file: string, args: string[], timeoutMs: number) => Promise<ToolResult>
  fs: ProbeFs
  os: {
    totalmem: () => number
    cpus: () => Array<{ model: string }>
  }
}

export interface HardwareProbeResult {
  info: SystemInfo
  /** What could not be read, one line each. */
  warnings: string[]
}

/** The facts every platform reads the same way, from `node:os`. */
export interface CommonFacts {
  /** Rust spelling. */
  arch: string
  totalMemoryMiB: number
  /** `os.cpus()[0].model`, the fallback when the platform tool does not name the CPU. */
  cpuName: string | undefined
  logicalCores: number
}

export function commonFacts(deps: ProbeDeps): CommonFacts {
  let cpuList: Array<{ model: string }> = []
  try {
    cpuList = deps.os.cpus()
  } catch {
    // A restricted container can refuse it; the platform probe still names the CPU.
  }
  let totalmem = 0
  try {
    totalmem = deps.os.totalmem()
  } catch {
    // Same: answer 0 rather than fail the whole probe over one number.
  }
  const model = cpuList[0]?.model.trim()
  return {
    arch: rustArch(deps.arch),
    totalMemoryMiB: Math.floor(Math.max(0, Number.isFinite(totalmem) ? totalmem : 0) / 2 ** 20),
    cpuName: model ? model : undefined,
    logicalCores: cpuList.length,
  }
}

/** The one line a failed step becomes. */
export function warningOf(step: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `${step}: ${message}`
}

/** CPU name, core count, memory and OS type from `node:os` alone: no flags, no GPUs. */
export function fallbackProbe(deps: ProbeDeps): HardwareProbeResult {
  const common = commonFacts(deps)
  return {
    info: {
      cpu: {
        name: common.cpuName ?? 'Unknown CPU',
        core_count: common.logicalCores,
        arch: common.arch,
        extensions: [],
        extensions_known: false,
      },
      os_type: osTypeOf(deps.platform),
      os_name: String(deps.platform),
      total_memory: common.totalMemoryMiB,
      gpus: [],
    },
    warnings: [],
  }
}

/** A settled step's value, or `undefined` with its failure recorded as a warning. */
export function settledOrWarn<T>(
  settled: PromiseSettledResult<T>,
  step: string,
  warnings: string[]
): T | undefined {
  if (settled.status === 'fulfilled') return settled.value
  warnings.push(warningOf(step, settled.reason))
  return undefined
}

/**
 * The first candidate that starts decides: a refusal of `compute_cap` is retried with the legacy fields
 * on the same binary; any other failure is reported (the driver is not loaded, the GPU is lost). No
 * candidate starting is the normal case on a machine without an NVIDIA driver, not a warning.
 */
export async function runNvidiaSmi(deps: ProbeDeps): Promise<NvidiaSmiGpu[]> {
  for (const candidate of nvidiaSmiCandidates(deps.platform, deps.env)) {
    let result
    try {
      result = await deps.run(candidate, nvidiaSmiArgs(NVIDIA_SMI_FIELDS), PROBE_TOOL_TIMEOUT_MS)
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') continue // not here; try the next location
      throw error // it is here and hung or could not start: worth a warning
    }
    let fields = NVIDIA_SMI_FIELDS
    if (result.code !== 0 && isUnknownFieldError(result.stderr)) {
      fields = NVIDIA_SMI_FIELDS_LEGACY
      result = await deps.run(candidate, nvidiaSmiArgs(fields), PROBE_TOOL_TIMEOUT_MS)
    }
    if (result.code !== 0)
      throw new Error(
        `${candidate} exited with ${result.code ?? 'signal'}: ${firstLine(result.stderr) || firstLine(result.stdout)}`
      )
    return parseNvidiaSmiCsv(result.stdout, fields).map((row) => {
      const busId = nvidiaBusIdOf(row)
      return { gpu: nvidiaGpuFromRow(row), ...(busId ? { busId } : {}) }
    })
  }
  return []
}

/** The first non-blank line of a tool's output, for a warning. */
export function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .find((line) => line.trim() !== '')
      ?.trim() ?? ''
  )
}
