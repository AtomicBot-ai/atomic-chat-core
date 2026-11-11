/**
 * Foundry Local's accelerators (openspec change `add-foundry-local`, task 6.4, design D3). The
 * library discovers and downloads its provider bundles; core stages external CUDA dependencies and
 * decides when to run a `probe` of the active build
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
import type { FoundryHostCommand, FoundryHostPrepareSummary } from './host-process.js'
import { FOUNDRY_CUDA_EXECUTION_PROVIDER, withCudaRuntime } from './cuda/index.js'
import type { CudaRuntimeStore } from './cuda/index.js'

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
  cuda?: Pick<CudaRuntimeStore, 'supports' | 'prepare'>
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
  async prepared(build?: string): Promise<string[]> {
    const selected = build ?? (await this.deps.resolveBuild())
    return selected ? [...(await this.read(selected)).prepared] : []
  }

  /** The last probe of the active build, with core's record of what is prepared; `force` probes again. */
  async list(options: { force?: boolean; build?: string } = {}): Promise<FoundryLocalAccelerators> {
    const build = options.build ?? (await this.deps.resolveBuild())
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
    const record = await this.read(build)
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
      const summary = await this.prepareHost(build, request.accelerators ?? [])
      const record = await this.read(build)
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
      await this.write(build, { prepared: [...prepared], failures, updated_at: this.now() })
      // The library state changed: the next request probes again (spec: after install, update, prepare).
      this.cache = null
      return { accelerators: summary.accelerators }
    } finally {
      this.preparing = false
    }
  }

  private async prepareHost(build: string, requested: string[]): Promise<FoundryHostPrepareSummary> {
    const target = { libDir: build, appDataDir: this.deps.runtimeDir, logsDir: this.deps.logsDir }
    const env = this.deps.env ?? process.env
    const emit = (step: CoreEvents['foundry-local:accelerators']) =>
      this.deps.emit('foundry-local:accelerators', step)
    const run = (names: readonly string[]) =>
      runFoundryHostPrepare(this.deps.hostCommand, target, names, emit, { env })
    const cuda = this.deps.cuda
    const accelerator = FOUNDRY_CUDA_EXECUTION_PROVIDER
    if (!cuda?.supports(build) || (requested.length && !requested.includes(accelerator)))
      return run(requested)
    const offered = (await this.list({ build })).accelerators.map(({ name }) => name)
    if (!offered.includes(accelerator)) return run(requested)

    const names = requested.length ? requested : offered
    const otherNames = names.filter((name) => name !== accelerator)
    // Let the other accelerators finish before a potentially long CUDA download.
    const others = otherNames.length ? (await run(otherNames)).accelerators : []
    emit({ accelerator, stage: 'started', fraction: 0 })
    let outcomes: FoundryHostPrepareSummary['accelerators']
    try {
      const dir = await cuda.prepare(build, (fraction) =>
        emit({ accelerator, stage: 'downloading', fraction: fraction / 2 })
      )
      const result = await runFoundryHostPrepare(
        this.deps.hostCommand,
        target,
        [accelerator],
        (step) => {
          if (step.stage === 'started') return
          emit(
            step.stage === 'downloading' && step.fraction !== null
              ? { ...step, fraction: 0.5 + step.fraction / 2 }
              : step
          )
        },
        { env: dir ? withCudaRuntime(env, build, dir) : env }
      )
      outcomes = result.accelerators
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      emit({ accelerator, stage: 'failed', fraction: null, reason })
      outcomes = [{ name: accelerator, prepared: false, reason }]
    }
    let otherIndex = 0
    return {
      accelerators: names.flatMap((name) =>
        name === accelerator ? outcomes : others.slice(otherIndex, ++otherIndex)
      ),
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

  /** 2.1.0 keeps its legacy record readable by an older core after rollback. */
  private recordPath(build: string): string {
    const tag = basename(dirname(build))
    return tag === 'v2.1.0'
      ? join(this.deps.runtimeDir, ACCELERATORS_FILE)
      : join(this.deps.runtimeDir, tag, basename(build), ACCELERATORS_FILE)
  }

  private async read(build: string): Promise<AcceleratorsRecord> {
    try {
      const raw = JSON.parse(await readFile(this.recordPath(build), 'utf8')) as Partial<AcceleratorsRecord>
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
  private async write(build: string, record: AcceleratorsRecord): Promise<void> {
    const path = this.recordPath(build)
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.tmp-${process.pid}`
    await writeFile(temporary, JSON.stringify(record, null, 2))
    await rename(temporary, path)
  }
}
