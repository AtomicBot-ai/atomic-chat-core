/**
 * Hardware facts the desktop app injects (PLAN.md §2 decision 10, risk 10).
 *
 * The core probes hardware with shell tools, which is enough to see that a GPU exists and roughly
 * what it is. It is not enough to see an NVIDIA driver's exact version or a GPU's compute
 * capability — those come from NVML and from a Vulkan enumeration, both of which need native
 * libraries the core deliberately does not link. Getting them wrong is not cosmetic: the CUDA tier
 * a backend is chosen from is decided by exactly those numbers, and on Windows the only signal for
 * an AMD gfx target is a PCI device id from Vulkan.
 *
 * So the app, which already has `tauri-plugin-hardware`, hands the core what it measured, and the
 * core prefers it over its own probe. The rule is one-directional: an override replaces the probe
 * for as long as it stands, and the core never merges the two — a half-probed, half-injected GPU
 * list would be a third description of the machine that matches neither side.
 *
 * Not persisted, on purpose. Hardware changes between runs (an eGPU, a driver update, a different
 * machine reading the same data folder over a network share), and a stale file claiming a GPU that
 * is no longer there would pick a backend that cannot start. The app re-injects on every attach.
 */

import { AtomicCoreError } from '../contracts/index.js'
import type { GpuProbeInfo } from '../backend/index.js'

export interface HardwareOverride {
  /** What the app's NVML/Vulkan enumeration found. Replaces the core's probe wholesale. */
  gpus: GpuProbeInfo[]
  /** CPU instruction-set flags (`avx`, `avx2`, `avx512`), lowercase as the feature check expects. */
  cpu_extensions?: string[]
  /** `linux` | `windows` | `macos` — the app's own idea of the OS, for cross-checking. */
  os_type?: string
  /** Who injected it, for the log and for the snapshot. */
  source?: string
  /** Milliseconds since the epoch, from the core's clock. */
  received_at: number
}

export interface HardwareOverrideInput {
  gpus?: unknown
  cpu_extensions?: unknown
  os_type?: unknown
  source?: unknown
}

/**
 * The override currently in force, if any.
 *
 * One per core process, held in memory. Reading it is how the backend selection path asks "do I
 * have better numbers than my own probe?".
 */
export class HardwareOverrideStore {
  private current: HardwareOverride | undefined

  constructor(private readonly now: () => number = Date.now) {}

  get(): HardwareOverride | undefined {
    return this.current ? structuredClone(this.current) : undefined
  }

  /** GPUs to use for backend selection: the override's when there is one, otherwise the probe's. */
  gpus(probed: readonly GpuProbeInfo[]): GpuProbeInfo[] {
    return this.current ? structuredClone(this.current.gpus) : [...probed]
  }

  cpuExtensions(probed: readonly string[]): string[] {
    return this.current?.cpu_extensions ? [...this.current.cpu_extensions] : [...probed]
  }

  /**
   * Accept an injection.
   *
   * A malformed payload is rejected rather than partly applied: this replaces the core's own view
   * of the machine, and a half-read GPU list is worse than no override at all.
   */
  set(input: HardwareOverrideInput): HardwareOverride {
    if (!Array.isArray(input.gpus))
      throw new AtomicCoreError(
        'INVALID_ARGUMENT',
        'A hardware override needs a `gpus` array.',
        'send the list from tauri-plugin-hardware, empty when the machine has no GPU'
      )
    const gpus = input.gpus.map((gpu, index) => {
      if (!gpu || typeof gpu !== 'object' || Array.isArray(gpu))
        throw new AtomicCoreError('INVALID_ARGUMENT', `gpus[${index}] is not an object`)
      return gpu as GpuProbeInfo
    })
    const extensions =
      input.cpu_extensions === undefined
        ? undefined
        : toStringArray(input.cpu_extensions, 'cpu_extensions').map((value) => value.toLowerCase())

    this.current = {
      gpus,
      ...(extensions ? { cpu_extensions: extensions } : {}),
      ...(typeof input.os_type === 'string' ? { os_type: input.os_type } : {}),
      ...(typeof input.source === 'string' ? { source: input.source } : {}),
      received_at: this.now(),
    }
    return structuredClone(this.current)
  }

  /** Drop the override and go back to the core's own probe. */
  clear(): boolean {
    const had = this.current !== undefined
    this.current = undefined
    return had
  }
}

function toStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    throw new AtomicCoreError('INVALID_ARGUMENT', `${field} must be an array of strings`)
  return value as string[]
}
