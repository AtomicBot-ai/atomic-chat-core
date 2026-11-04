/**
 * A Windows CUDA pack whose CUDA runtime could not be put in place does not run: its `ggml-cuda.dll`
 * imports `cudart64_<major>.dll`, and without it the load dies with an empty stderr. The pre-flight
 * that repairs it before every load (`ensureUpstreamCudart`, `ensureTurboquantCudart`) used to only
 * warn when the repair failed — offline, a refused download — and the load went on into that crash.
 *
 * `CudaRuntimeGuard` remembers such a failure for the rest of the core's run, per provider: backend
 * selection then sees the machine without its CUDA facts (`nvidia_info` is what every CUDA tier
 * reads; Vulkan does not need it), and a load that asked for the broken CUDA pack is given the best
 * other installed one instead. A configured CUDA pack is still tried first on every load, so a repair
 * that succeeds later (the network is back) gives it back. A host with a CUDA toolkit of its own is
 * never blocked: the runtime puts the toolkit on PATH, and the pack may well run from it.
 */

import type { LocalProviderId } from '../../contracts/index.js'
import type { DataLayout } from '../../config/index.js'
import type { HardwareFacts, HardwareFactsSource } from '../../hardware/index.js'
import { discoverCudaPaths, nodeCudaProbeEnv } from '../../runtime/shared/index.js'
import { ensureBackend, selectInstalledBackend } from './runtime-backend.js'

/** The facts with the CUDA side of every NVIDIA GPU removed: no CUDA tier is supported from them. */
export function factsWithoutCuda(facts: HardwareFacts): HardwareFacts {
  return { ...facts, gpus: facts.gpus.map((gpu) => (gpu.nvidia_info ? { ...gpu, nvidia_info: null } : gpu)) }
}

/** What a load runs: `ensureBackend`'s answer. */
export interface ReadyBackend {
  version: string
  backend: string
  exePath: string
}

/** The steps of one guarded `ensureBackend`, injected so the guard knows nothing of the data folder. */
export interface GuardedEnsureSteps {
  /** `ensureBackend` with the facts and the repair hook it is given. */
  ensure: (
    hardware: HardwareFactsSource,
    repair: (backend: string, version: string) => Promise<void>
  ) => Promise<ReadyBackend>
  /** Put the CUDA runtime in place beside this pack; rejects when that could not be done. */
  repair: (backend: string, version: string) => Promise<unknown>
  /** `selectInstalledBackend` over the given facts. */
  select: (
    hardware: HardwareFactsSource
  ) => Promise<{ version: string; backend: string; path: string } | undefined>
}

export interface CudaRuntimeGuardOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Whether the host has a CUDA toolkit the runtime would put on PATH; probed from `platform`/`env` by default. */
  toolkitOnHost?: () => boolean
  log?: (level: 'warn', message: string) => void
}

export class CudaRuntimeGuard {
  private readonly blocked = new Set<string>()
  private readonly toolkitOnHost: () => boolean

  constructor(private readonly options: CudaRuntimeGuardOptions = {}) {
    this.toolkitOnHost =
      options.toolkitOnHost ??
      (() =>
        discoverCudaPaths(nodeCudaProbeEnv(options.platform ?? process.platform, options.env ?? process.env))
          .binDirs.length > 0)
  }

  /** Whether `provider`'s CUDA packs are kept out of selection for the rest of this run. */
  isBlocked(provider: string): boolean {
    return this.blocked.has(provider)
  }

  /** The facts backend selection reads for `provider`: without CUDA while its runtime is missing. */
  facts(provider: string, source: HardwareFactsSource): HardwareFactsSource {
    return {
      facts: async () => {
        const facts = await source.facts()
        return this.blocked.has(provider) ? factsWithoutCuda(facts) : facts
      },
    }
  }

  /** `ensureBackend` over the data folder, guarded as `ensure` describes; `repair` rejects when it fails. */
  ensureBackend(
    layout: DataLayout,
    provider: LocalProviderId,
    backend: string,
    version: string,
    hardware: HardwareFactsSource,
    hostArch: NodeJS.Architecture,
    repair: GuardedEnsureSteps['repair']
  ): Promise<ReadyBackend> {
    return this.ensure(provider, hardware, {
      ensure: (facts, guarded) => ensureBackend(layout, provider, backend, version, facts, hostArch, guarded),
      select: (facts) => selectInstalledBackend(layout, provider, facts, hostArch),
      repair,
    })
  }

  /**
   * One `ensureBackend` for a load. When the CUDA repair of the pack it chose fails and the host has
   * no toolkit, the provider's CUDA packs leave selection for this run and the best other installed
   * pack is returned; with no other pack the CUDA one is returned, as before.
   */
  async ensure(
    provider: string,
    hardware: HardwareFactsSource,
    steps: GuardedEnsureSteps
  ): Promise<ReadyBackend> {
    let repairFailed = false
    const ready = await steps.ensure(this.facts(provider, hardware), async (backend, version) => {
      try {
        await steps.repair(backend, version)
      } catch (error) {
        repairFailed = true
        this.options.log?.('warn', `cudart pre-flight for ${version}/${backend} failed: ${String(error)}`)
      }
    })
    if (!repairFailed || this.toolkitOnHost()) return ready
    if (!this.blocked.has(provider))
      this.options.log?.(
        'warn',
        `${provider}: CUDA builds are left out of backend selection until the core restarts`
      )
    this.blocked.add(provider)
    const other = await steps.select(this.facts(provider, hardware))
    if (!other || (other.version === ready.version && other.backend === ready.backend)) return ready
    this.options.log?.(
      'warn',
      `${ready.version}/${ready.backend} cannot run without its CUDA runtime; loading ${other.version}/${other.backend} instead`
    )
    return { version: other.version, backend: other.backend, exePath: other.path }
  }
}
