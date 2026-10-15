/**
 * Foundry Local's accelerators (openspec change `add-foundry-local`, task 6.4, design D3). The
 * library finds and downloads them itself; core only decides when: a `probe` of the active build
 * when a client first asks or the active build changed, and a `prepare` when a client orders it — one
 * at a time, each step published as `foundry-local:accelerators`.
 *
 * What is prepared is core's own record, `<data>/foundry-local/runtime/accelerators.json`: the
 * library's "registered" flag lives only as long as one process (spike finding 18).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import type {
  CoreEvents,
  FoundryLocalAccelerator,
  FoundryLocalAccelerators,
  FoundryLocalExecutionProvider,
  FoundryLocalPrepareRequest,
  FoundryLocalPrepareResult,
} from '../../contracts/index.js'
import { runFoundryHostPrepare, runFoundryHostProbe } from './host-process.js'
import type { FoundryHostCommand } from './host-process.js'

export const ACCELERATORS_FILE = 'accelerators.json'

interface AcceleratorsRecord {
  prepared: string[]
  /** The reason the last prepare of each failed one gave. */
  failures: Record<string, string>
  updated_at: number
}

export interface FoundryLocalAcceleratorDeps {
  hostCommand: FoundryHostCommand
  /** The active build's directory, or nothing installed. */
  resolveBuild: () => Promise<string | undefined>
  /** `<data>/foundry-local/runtime`: the library's data and core's `accelerators.json`. */
  runtimeDir: string
  logsDir: string
  emit: (name: 'foundry-local:accelerators', payload: CoreEvents['foundry-local:accelerators']) => void
  env?: NodeJS.ProcessEnv
  now?: () => number
}

const EMPTY: AcceleratorsRecord = { prepared: [], failures: {}, updated_at: 0 }

export class FoundryLocalAcceleratorService {
  private cache: { build: string; answer: FoundryLocalAccelerators } | null = null
  private preparing = false
  private readonly now: () => number

  constructor(private readonly deps: FoundryLocalAcceleratorDeps) {
    this.now = deps.now ?? Date.now
  }

  /** The names core recorded as prepared: what a load checks before it starts a host. */
  async prepared(): Promise<string[]> {
    return [...(await this.read()).prepared]
  }

  /** The last probe of the active build, with core's record of what is prepared; `force` probes again. */
  async list(options: { force?: boolean } = {}): Promise<FoundryLocalAccelerators> {
    const build = await this.deps.resolveBuild()
    if (!build)
      return {
        installed: false,
        build: null,
        version: null,
        c_api_version: null,
        probed_at: null,
        accelerators: [],
        error: null,
      }
    const record = await this.read()
    if (!options.force && this.cache?.build === build) return this.withRecord(this.cache.answer, record)
    const name = `${basename(dirname(build))}/${basename(build)}`
    let answer: FoundryLocalAccelerators
    try {
      const probe = await runFoundryHostProbe(
        this.deps.hostCommand,
        {
          libDir: build,
          appDataDir: this.deps.runtimeDir,
          logsDir: this.deps.logsDir,
          prepared: record.prepared,
        },
        this.deps.env ? { env: this.deps.env } : {}
      )
      answer = {
        installed: true,
        build: name,
        version: probe.version ?? null,
        c_api_version: probe.c_api_version,
        probed_at: this.now(),
        accelerators: probe.accelerators.map((accelerator) => ({
          name: accelerator.name,
          execution_provider: (accelerator.execution_provider ??
            null) as FoundryLocalExecutionProvider | null,
          device: accelerator.device,
          prepared: false,
        })),
        error: null,
      }
    } catch (error) {
      const details = error instanceof AtomicCoreError ? error.details : undefined
      answer = {
        installed: true,
        build: name,
        version: null,
        c_api_version: null,
        probed_at: this.now(),
        accelerators: [],
        error: [error instanceof Error ? error.message : String(error), details].filter(Boolean).join(' '),
      }
    }
    this.cache = { build, answer }
    return this.withRecord(answer, record)
  }

  /** Downloads and registers the accelerators named (none: all offered); one prepare at a time. */
  async prepare(request: FoundryLocalPrepareRequest): Promise<FoundryLocalPrepareResult> {
    if (this.preparing)
      throw new AtomicCoreError(
        'ENGINE_INSTALL_IN_PROGRESS',
        'Foundry Local accelerators are already being prepared; wait for that to finish.'
      )
    this.preparing = true
    try {
      const build = await this.deps.resolveBuild()
      if (!build)
        throw new AtomicCoreError(
          'BINARY_NOT_FOUND',
          'Foundry Local is not installed; install it before preparing accelerators.'
        )
      const summary = await runFoundryHostPrepare(
        this.deps.hostCommand,
        { libDir: build, appDataDir: this.deps.runtimeDir, logsDir: this.deps.logsDir },
        request.accelerators ?? [],
        (step) => this.deps.emit('foundry-local:accelerators', step),
        this.deps.env ? { env: this.deps.env } : {}
      )
      const record = await this.read()
      const prepared = new Set(record.prepared)
      const failures = { ...record.failures }
      for (const outcome of summary.accelerators) {
        if (outcome.prepared) {
          prepared.add(outcome.name)
          delete failures[outcome.name]
        } else {
          prepared.delete(outcome.name)
          failures[outcome.name] = outcome.reason ?? 'Foundry Local did not register it.'
        }
      }
      await this.write({ prepared: [...prepared], failures, updated_at: this.now() })
      // The library state changed: the next request probes again (spec: after install, update, prepare).
      this.cache = null
      return { accelerators: summary.accelerators }
    } finally {
      this.preparing = false
    }
  }

  private withRecord(answer: FoundryLocalAccelerators, record: AcceleratorsRecord): FoundryLocalAccelerators {
    return {
      ...answer,
      accelerators: answer.accelerators.map((accelerator): FoundryLocalAccelerator => {
        const reason = record.failures[accelerator.name]
        const prepared = record.prepared.includes(accelerator.name)
        return { ...accelerator, prepared, ...(!prepared && reason !== undefined ? { reason } : {}) }
      }),
    }
  }

  private async read(): Promise<AcceleratorsRecord> {
    try {
      const raw = JSON.parse(
        await readFile(join(this.deps.runtimeDir, ACCELERATORS_FILE), 'utf8')
      ) as Partial<AcceleratorsRecord>
      return {
        prepared: Array.isArray(raw.prepared)
          ? raw.prepared.filter((name): name is string => typeof name === 'string')
          : [],
        failures:
          raw.failures && typeof raw.failures === 'object' && !Array.isArray(raw.failures)
            ? Object.fromEntries(Object.entries(raw.failures).filter(([, v]) => typeof v === 'string'))
            : {},
        updated_at: typeof raw.updated_at === 'number' ? raw.updated_at : 0,
      }
    } catch {
      return EMPTY
    }
  }

  /** Write-then-rename: a crash mid-write leaves the previous record, never half of one. */
  private async write(record: AcceleratorsRecord): Promise<void> {
    await mkdir(this.deps.runtimeDir, { recursive: true })
    const path = join(this.deps.runtimeDir, ACCELERATORS_FILE)
    const temporary = `${path}.tmp-${process.pid}`
    await writeFile(temporary, JSON.stringify(record, null, 2))
    await rename(temporary, path)
  }
}
