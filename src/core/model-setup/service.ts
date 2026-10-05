/**
 * The model-setup runner: `queued → installing_engine → downloading_model → downloading_projector →
 * verifying → registering → ready`, or `failed | cancelled`; a setup a stopped core left mid-way is
 * `interrupted` at the next start and continues on `resume`, from the files already on disk.
 *
 * The PrismML pack is shared: two setups that need the same pack wait on one install, and cancelling
 * one of them stops its wait, never the install the other still needs. Credentials are never stored:
 * the Hugging Face token goes into the download headers of the run that uses it.
 */

import { stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { AtomicCoreError, MODEL_SETUP_FINAL_STAGES } from '../../contracts/index.js'
import type {
  CompatibilityVerdict,
  ErrorBody,
  ModelSetup,
  ModelSetupEngine,
  ModelSetupPlan,
  ModelSetupPlanRequest,
  ModelSetupStage,
  ModelSetupStartRequest,
  ProxyConfig,
} from '../../contracts/index.js'
import type { DataLayout } from '../../config/index.js'
import { modelDirFromId } from '../../config/index.js'
import type { DownloadItem } from '../../downloads/index.js'
import { hfResolveUrl } from '../../models/index.js'
import type { ModelYmlInput } from '../../models/index.js'
import type { ModelSetupStore } from './store.js'

export interface ModelSetupServiceDeps {
  layout: DataLayout
  store: ModelSetupStore
  plan: (request: ModelSetupPlanRequest) => Promise<ModelSetupPlan>
  /** Install the pack (idempotent: a pack already on disk returns at once). */
  installEngine: (engine: ModelSetupEngine, taskId: string, proxy: ProxyConfig | null) => Promise<void>
  /** Make `atomic-prism` load from this pack. */
  selectEngine: (engine: ModelSetupEngine) => Promise<void>
  download: (taskId: string, items: DownloadItem[]) => Promise<void>
  cancelDownload: (taskId: string) => void
  /** The header verdict of a downloaded file. */
  verify: (modelPath: string) => Promise<CompatibilityVerdict>
  register: (modelId: string, yml: ModelYmlInput) => Promise<void>
  emit: (record: ModelSetup) => void
  /** `model:imported` for the app's model list. */
  imported?: (event: {
    provider: ModelSetupPlan['provider']
    modelId: string
    modelPath: string
    mmprojPath?: string
  }) => void
  newId: () => string
  /** Where model files are downloaded from; Hugging Face unless a test points it elsewhere. */
  hfEndpoint?: string
  now?: () => number
  log?: (level: 'info' | 'warn', message: string) => void
}

/** A download task id the progress events can carry: no characters a path or event name chokes on. */
export function setupTaskId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_/:.-]/g, '_')
}

/** The engine install's task id, one per pack, shared by every setup that needs it. */
export function engineTaskId(engine: Pick<ModelSetupEngine, 'version' | 'backend'>): string {
  return setupTaskId(`atomic-prism-backend-${engine.version}/${engine.backend}`)
}

const isFinal = (stage: ModelSetupStage) => MODEL_SETUP_FINAL_STAGES.includes(stage)
const RESUMABLE: readonly ModelSetupStage[] = ['interrupted', 'failed', 'cancelled']

/** The error the wire carries for a stopped setup. */
export function setupErrorBody(error: unknown): ErrorBody {
  if (error instanceof AtomicCoreError) return error.toJSON()
  return { code: 'IO_ERROR', message: error instanceof Error ? error.message : String(error) }
}

/** The refusal a blocked plan answers `POST /model-setups` with. */
export function blockedPlanError(plan: ModelSetupPlan): AtomicCoreError | null {
  const blocker = plan.blockers[0]
  if (!blocker) return null
  const details = JSON.stringify({ blockers: plan.blockers })
  switch (blocker.code) {
    case 'legacy_artifact':
      return new AtomicCoreError('MODEL_FORMAT_LEGACY', blocker.message, details)
    case 'insufficient_disk_space':
      return new AtomicCoreError('DISK_FULL', `[disk_full] ${blocker.message}`, details)
    default:
      return new AtomicCoreError('MODEL_ENGINE_INCOMPATIBLE', blocker.message, details)
  }
}

const cancelled = () => new AtomicCoreError('MODEL_LOAD_CANCELLED', 'The model setup was cancelled.')

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelled())
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

interface Run {
  controller: AbortController
  done: Promise<void>
}

export class ModelSetupService {
  private readonly records = new Map<string, ModelSetup>()
  private readonly runs = new Map<string, Run>()
  private readonly engines = new Map<string, Promise<void>>()

  constructor(private readonly deps: ModelSetupServiceDeps) {}

  /** Load the records and mark what a stopped core left mid-way `interrupted`. Call once at start. */
  async recover(): Promise<void> {
    for (const record of await this.deps.store.list()) {
      this.records.set(record.setup_id, record)
      if (isFinal(record.stage) || record.stage === 'interrupted') continue
      await this.update(record.setup_id, { stage: 'interrupted', stopped_at: record.stage })
    }
  }

  /** In-memory view for the control snapshot. */
  snapshot(): ModelSetup[] {
    return [...this.records.values()].sort((a, b) => a.created_at - b.created_at)
  }

  plan(request: ModelSetupPlanRequest): Promise<ModelSetupPlan> {
    return this.deps.plan(request)
  }

  async list(): Promise<ModelSetup[]> {
    return this.snapshot()
  }

  async get(setupId: string): Promise<ModelSetup> {
    const record = this.records.get(setupId) ?? (await this.deps.store.read(setupId))
    if (!record) throw new AtomicCoreError('MODEL_SETUP_NOT_FOUND', 'No such model setup.', setupId)
    return record
  }

  /**
   * Start a setup from the plan the user saw. A retry with the same `request_id` returns the setup
   * it started; a plan that changed since is `MODEL_SETUP_PLAN_STALE`; a model already being set up
   * returns that setup.
   */
  async start(input: ModelSetupStartRequest): Promise<ModelSetup> {
    if (
      typeof input.request_id !== 'string' ||
      input.request_id === '' ||
      typeof input.plan_digest !== 'string'
    ) {
      throw new AtomicCoreError('INVALID_ARGUMENT', 'A model setup needs request_id and plan_digest.')
    }
    const { request_id: requestId, plan_digest: planDigest, proxy, ...request } = input
    const same = this.snapshot().find((r) => r.request_id === requestId)
    if (same) {
      if (JSON.stringify(same.request) !== JSON.stringify(request)) {
        throw new AtomicCoreError(
          'INVALID_ARGUMENT',
          'That request id was already used for another setup.',
          same.setup_id
        )
      }
      return same
    }
    const plan = await this.deps.plan(input)
    if (plan.digest !== planDigest) {
      throw new AtomicCoreError(
        'MODEL_SETUP_PLAN_STALE',
        'What this setup would do has changed since it was planned; review the new plan.',
        JSON.stringify(plan)
      )
    }
    const blocked = blockedPlanError(plan)
    if (blocked) throw blocked
    const active = this.snapshot().find(
      (r) => r.plan.model_id === plan.model_id && !isFinal(r.stage) && r.stage !== 'interrupted'
    )
    if (active) return active

    const setupId = this.deps.newId()
    const now = this.now()
    const record: ModelSetup = {
      setup_id: setupId,
      request_id: requestId,
      revision: 0,
      stage: 'queued',
      request,
      plan,
      task_ids: this.taskIds(setupId, plan),
      created_at: now,
      updated_at: now,
    }
    await this.deps.store.create(record)
    this.remember(record)
    this.launch(setupId, proxy ?? null)
    return record
  }

  /** Stop a setup. Files downloaded so far stay, so `resume` continues from them. */
  async cancel(setupId: string): Promise<ModelSetup> {
    const record = await this.get(setupId)
    const run = this.runs.get(setupId)
    if (run) {
      run.controller.abort()
      this.deps.cancelDownload(record.task_ids.model)
      if (record.task_ids.projector) this.deps.cancelDownload(record.task_ids.projector)
      await run.done
      return this.get(setupId)
    }
    if (isFinal(record.stage)) return record
    return this.update(setupId, { stage: 'cancelled', stopped_at: record.stage })
  }

  /** Run a stopped setup again, planned afresh from its request. */
  async resume(setupId: string, options: { proxy?: ProxyConfig | null } = {}): Promise<ModelSetup> {
    const record = await this.get(setupId)
    if (this.runs.has(setupId) || !RESUMABLE.includes(record.stage)) return record
    const plan = await this.deps.plan(record.request)
    const blocked = blockedPlanError(plan)
    if (blocked) {
      return this.update(setupId, {
        stage: 'failed',
        stopped_at: record.stage,
        error: blocked.toJSON(),
        plan,
      })
    }
    const next = await this.update(
      setupId,
      { stage: 'queued', plan, task_ids: this.taskIds(setupId, plan) },
      ['error', 'stopped_at']
    )
    this.launch(setupId, options.proxy ?? null)
    return next
  }

  /** Wait for a run in flight (tests and shutdown). */
  async settled(setupId: string): Promise<void> {
    await this.runs.get(setupId)?.done
  }

  private taskIds(setupId: string, plan: ModelSetupPlan): ModelSetup['task_ids'] {
    return {
      ...(plan.engine && !plan.engine.installed ? { engine: engineTaskId(plan.engine) } : {}),
      model: setupTaskId(`model-setup-${setupId}-model`),
      ...(plan.projector ? { projector: setupTaskId(`model-setup-${setupId}-projector`) } : {}),
    }
  }

  private launch(setupId: string, proxy: ProxyConfig | null): void {
    const controller = new AbortController()
    const done = this.run(setupId, proxy, controller.signal).finally(() => {
      if (this.runs.get(setupId)?.controller === controller) this.runs.delete(setupId)
    })
    this.runs.set(setupId, { controller, done })
  }

  private async run(setupId: string, proxy: ProxyConfig | null, signal: AbortSignal): Promise<void> {
    let stage: ModelSetupStage = 'queued'
    const enter = async (next: ModelSetupStage) => {
      if (signal.aborted) throw cancelled()
      stage = next
      return this.update(setupId, { stage: next })
    }
    try {
      let record = await this.get(setupId)
      const { plan } = record
      const paths = this.pathsOf(plan)
      if (plan.engine) {
        if (!plan.engine.installed) {
          record = await enter('installing_engine')
          await raceAbort(this.sharedInstall(plan.engine, proxy), signal)
        }
        await this.deps.selectEngine(plan.engine)
      }
      record = await enter('downloading_model')
      await raceAbort(
        this.deps.download(record.task_ids.model, [this.item(plan.model, paths.model, plan.model_id, proxy)]),
        signal
      )
      const projectorTask = record.task_ids.projector
      if (plan.projector && paths.projector && projectorTask) {
        await enter('downloading_projector')
        await raceAbort(
          this.deps.download(projectorTask, [
            this.item(plan.projector, paths.projector, plan.model_id, proxy),
          ]),
          signal
        )
      }
      await enter('verifying')
      this.check(plan, await this.deps.verify(join(this.deps.layout.root, paths.model)))
      await enter('registering')
      await this.registerModel(plan, paths)
      await enter('ready')
    } catch (error) {
      const wasCancelled =
        signal.aborted || (error instanceof Error && error.message.includes('Download cancelled'))
      await this.update(
        setupId,
        wasCancelled
          ? { stage: 'cancelled', stopped_at: stage }
          : { stage: 'failed', stopped_at: stage, error: setupErrorBody(error) }
      ).catch((e: unknown) =>
        this.deps.log?.('warn', `[model-setup] could not record the end of ${setupId}: ${String(e)}`)
      )
    }
  }

  private sharedInstall(engine: ModelSetupEngine, proxy: ProxyConfig | null): Promise<void> {
    const key = `${engine.version}/${engine.backend}`
    let install = this.engines.get(key)
    if (!install) {
      install = this.deps
        .installEngine(engine, engineTaskId(engine), proxy)
        .finally(() => this.engines.delete(key))
      this.engines.set(key, install)
    }
    return install
  }

  /** Data-folder-relative paths, `/`-separated, as `model.yml` stores them. */
  private pathsOf(plan: ModelSetupPlan): { model: string; projector?: string } {
    const dir = modelDirFromId(this.deps.layout.provider('llamacpp-upstream').modelsDir, plan.model_id)
    const rel = (file: string) =>
      relative(this.deps.layout.root, join(dir, file.split('/').pop() ?? file))
        .split(sep)
        .join('/')
    return { model: rel(plan.model.file), ...(plan.projector ? { projector: rel(plan.projector.file) } : {}) }
  }

  private item(
    artifact: ModelSetupPlan['model'],
    savePath: string,
    modelId: string,
    proxy: ProxyConfig | null
  ): DownloadItem {
    return {
      url: hfResolveUrl(artifact.repo, artifact.file, artifact.revision, this.deps.hfEndpoint),
      save_path: savePath,
      ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
      ...(artifact.size > 0 ? { size: artifact.size } : {}),
      model_id: modelId,
      ...(proxy ? { proxy } : {}),
    }
  }

  /** The header is the last word: a file that turned out to need another engine is not registered. */
  private check(plan: ModelSetupPlan, verdict: CompatibilityVerdict): void {
    if (verdict.outcome === 'legacy_artifact')
      throw new AtomicCoreError('MODEL_FORMAT_LEGACY', verdict.reason, JSON.stringify(verdict))
    if (verdict.outcome === 'unsupported') {
      throw new AtomicCoreError('MODEL_ENGINE_INCOMPATIBLE', verdict.reason, JSON.stringify(verdict))
    }
    if (verdict.provider !== null && verdict.provider !== plan.provider) {
      throw new AtomicCoreError(
        'MODEL_SETUP_PLAN_STALE',
        `The downloaded file needs ${verdict.provider}, not ${plan.provider}; plan the setup again.`,
        JSON.stringify(verdict)
      )
    }
  }

  private async registerModel(
    plan: ModelSetupPlan,
    paths: { model: string; projector?: string }
  ): Promise<void> {
    const size = async (rel: string) => (await stat(join(this.deps.layout.root, rel))).size
    const modelSize = await size(paths.model)
    const projectorSize = paths.projector ? await size(paths.projector) : 0
    const { verdict } = plan
    await this.deps.register(plan.model_id, {
      model_path: paths.model,
      ...(paths.projector ? { mmproj_path: paths.projector } : {}),
      name: (plan.model.file.split('/').pop() ?? plan.model.file).replace(/\.gguf$/i, ''),
      size_bytes: modelSize + projectorSize,
      ...(plan.model.sha256 ? { model_sha256: plan.model.sha256 } : {}),
      model_size_bytes: modelSize,
      ...(plan.projector?.sha256 ? { mmproj_sha256: plan.projector.sha256 } : {}),
      ...(paths.projector ? { mmproj_size_bytes: projectorSize, projector_vision: true } : {}),
      embedding: false,
      ...(plan.provider === 'atomic-prism'
        ? {
            atomic_runtime: {
              provider: 'atomic-prism',
              requires: verdict.requires,
              ...(verdict.min_prism_build !== undefined ? { min_build: verdict.min_prism_build } : {}),
              ...(verdict.family ? { family: verdict.family } : {}),
            },
          }
        : {}),
    })
    this.deps.imported?.({
      provider: plan.provider,
      modelId: plan.model_id,
      modelPath: paths.model,
      ...(paths.projector ? { mmprojPath: paths.projector } : {}),
    })
  }

  /** Commit a patch on top of the newest record, retrying if a concurrent write moved it. */
  private async update(
    setupId: string,
    patch: Partial<ModelSetup>,
    clear: readonly ('error' | 'stopped_at')[] = []
  ): Promise<ModelSetup> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.deps.store.read(setupId)
      if (!current) throw new AtomicCoreError('MODEL_SETUP_NOT_FOUND', 'No such model setup.', setupId)
      const next: ModelSetup = { ...current, ...patch, updated_at: this.now() }
      for (const key of clear) delete next[key]
      const stored = await this.deps.store.commit(next, current.revision)
      if (stored) {
        this.remember(stored)
        return stored
      }
    }
    throw new AtomicCoreError('INTERNAL_ERROR', 'The model setup kept changing under this write.', setupId)
  }

  private remember(record: ModelSetup): void {
    this.records.set(record.setup_id, record)
    this.deps.emit(record)
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}
