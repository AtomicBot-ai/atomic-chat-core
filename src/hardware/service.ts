/**
 * The hardware facts of this core process: one probe at start-up, re-run on request, replaced
 * wholesale by an injected override for as long as one stands (`override.ts`).
 *
 * `start()` kicks the probe off and returns at once, so the control listener is up while PowerShell
 * is still starting; the first caller that needs the facts (`facts()`, a backend load, `info()`)
 * waits for that probe, and every later one reads the answer. Nothing is persisted, for the reasons
 * `override.ts` gives: hardware changes between runs.
 */

import type {
  HardwareInfoResponse,
  HardwareOverride,
  HardwareOverrideInput,
  OsType,
  SystemInfo,
} from '../contracts/index.js'
import { factsOf, osTypeOf, rustArch, systemInfoWithOverride } from './facts.js'
import type { HardwareFacts, HardwareFactsSource } from './facts.js'
import { HardwareOverrideStore } from './override.js'
import type { HardwareProbeResult } from './probe-common.js'

export interface HardwareServiceOptions {
  /** Measure the machine. Expected not to throw; when it does, the answer is cpu/os/memory only. */
  probe: () => Promise<HardwareProbeResult>
  /** Node spelling (`x64`); the facts carry the Rust one. */
  arch: string
  /** For the `os_type` of the answer when even the probe fails; the platform the core runs on. */
  platform?: NodeJS.Platform | string
  now?: () => number
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
}

/** What `/hardware/*` needs from the service; the same shape `server/control/types.ts` names `HardwareControl`. */
export interface HardwareControlSurface {
  info: () => Promise<HardwareInfoResponse>
  refresh: () => Promise<HardwareInfoResponse>
  getOverride: () => HardwareOverride | undefined
  setOverride: (input: HardwareOverrideInput) => HardwareOverride
  clearOverride: () => boolean
}

interface Probed {
  info: SystemInfo
  warnings: string[]
  probedAt: number
}

export class HardwareService implements HardwareFactsSource, HardwareControlSurface {
  private readonly arch: string
  private readonly osType: OsType
  private readonly now: () => number
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void
  private readonly override: HardwareOverrideStore
  private inFlight: Promise<Probed> | undefined
  private last: Probed | undefined

  constructor(private readonly options: HardwareServiceOptions) {
    this.arch = rustArch(options.arch)
    this.osType = osTypeOf(options.platform ?? 'unknown')
    this.now = options.now ?? Date.now
    this.log = options.log ?? (() => {})
    this.override = new HardwareOverrideStore(this.now)
  }

  /** Start the first probe without waiting for it. Idempotent. */
  start(): void {
    if (!this.inFlight && !this.last) void this.run()
  }

  /** The current description, with the override applied when one stands. */
  async info(): Promise<HardwareInfoResponse> {
    return this.render(await this.current())
  }

  /**
   * Probe again and answer with the result. A probe already running is awaited instead of doubled:
   * two PowerShell processes measuring the same machine would only make both slower.
   */
  async refresh(): Promise<HardwareInfoResponse> {
    return this.render(await (this.inFlight ?? this.run()))
  }

  /** The slice the backend selectors read. Waits for the probe in flight. */
  async facts(): Promise<HardwareFacts> {
    const probed = await this.current()
    // The probe's own reading of the architecture, so a canned probe describes a whole host; the
    // constructor's `arch` only fills the last-resort answer when the probe itself failed.
    return factsOf(probed.info, probed.info.cpu.arch || this.arch, this.override.get())
  }

  getOverride(): HardwareOverride | undefined {
    return this.override.get()
  }

  setOverride(input: HardwareOverrideInput): HardwareOverride {
    const applied = this.override.set(input)
    this.log(
      'info',
      `hardware override accepted from ${applied.source ?? 'unknown'}: ${applied.gpus.length} GPU(s)`
    )
    return applied
  }

  clearOverride(): boolean {
    return this.override.clear()
  }

  private current(): Promise<Probed> {
    if (this.last) return Promise.resolve(this.last)
    return this.inFlight ?? this.run()
  }

  private run(): Promise<Probed> {
    const started = this.now()
    const attempt = this.options
      .probe()
      .then(
        (result) => ({ info: result.info, warnings: [...result.warnings], probedAt: started }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          this.log('warn', `hardware probe failed: ${message}`)
          return {
            info: this.minimalInfo(),
            warnings: [`hardware probe failed: ${message}`],
            probedAt: started,
          }
        }
      )
      .then((probed) => {
        this.last = probed
        for (const warning of probed.warnings) this.log('info', `hardware probe: ${warning}`)
        return probed
      })
      .finally(() => {
        if (this.inFlight === attempt) this.inFlight = undefined
      })
    this.inFlight = attempt
    return attempt
  }

  private render(probed: Probed): HardwareInfoResponse {
    const override = this.override.get()
    return {
      info: override ? systemInfoWithOverride(probed.info, override) : structuredClone(probed.info),
      source: override ? 'override' : 'probe',
      probed_at: probed.probedAt,
      warnings: [...probed.warnings],
    }
  }

  /** What is left when the probe itself threw: the arch and OS the service was built for. */
  private minimalInfo(): SystemInfo {
    return {
      cpu: { name: 'Unknown CPU', core_count: 0, arch: this.arch, extensions: [], extensions_known: false },
      os_type: this.osType,
      os_name: '',
      total_memory: 0,
      gpus: [],
    }
  }
}
