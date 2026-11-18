import { randomUUID } from 'node:crypto'
import { AtomicCoreError } from '../../contracts/index.js'
import type {
  StrataBackend,
  StrataPreparationOperation,
  StrataPreparationRequest,
} from '../../contracts/index.js'
import { FifoLock } from '../shared/index.js'
import type { StrataOperationStore } from './strata-operation-store.js'

type Report = (stage: string, completedBytes?: number, totalBytes?: number) => Promise<void>
export interface StrataPreparationDependencies {
  resolve(request: StrataPreparationRequest): Promise<{ backend: StrataBackend; digest: string }>
  /** Returns only after source/output verification and atomic readiness publication. */
  run(
    operation: StrataPreparationOperation,
    backend: StrataBackend,
    signal: AbortSignal,
    report: Report
  ): Promise<void>
  emit(operation: StrataPreparationOperation): void
}
const active = (state: string) => ['queued', 'preparing', 'verifying'].includes(state)
function requestKey(r: StrataPreparationRequest): string {
  return JSON.stringify([r.request_id, r.model_id, r.source_digest, r.maintenance_id ?? null])
}
function validate(r: StrataPreparationRequest) {
  if (
    !r ||
    typeof r !== 'object' ||
    Object.keys(r).some((k) => !['request_id', 'model_id', 'source_digest', 'maintenance_id'].includes(k)) ||
    [r.request_id, r.model_id].some(
      (v) => typeof v !== 'string' || !v || v.length > 1024 || v.includes('\0')
    ) ||
    typeof r.source_digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(r.source_digest) ||
    (r.maintenance_id !== undefined && (typeof r.maintenance_id !== 'string' || !r.maintenance_id))
  )
    throw new AtomicCoreError('INVALID_ARGUMENT', 'Invalid Strata preparation request.')
}

/** Durable state machine. Long-running conversion never holds the lock needed to cancel it. */
export class StrataPreparationService {
  readonly coordination = new FifoLock()
  private readonly jobs = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  private closed = false
  private failure: unknown
  constructor(
    readonly store: StrataOperationStore,
    private readonly deps: StrataPreparationDependencies
  ) {}

  list(): StrataPreparationOperation[] {
    if (this.failure)
      throw new AtomicCoreError(
        'IO_ERROR',
        'Strata could not persist preparation progress; operations remain blocked.'
      )
    return this.store.snapshot().preparations.map((row) => row.operation)
  }

  get(id: string): StrataPreparationOperation {
    const op = this.list().find((o) => o.operation_id === id)
    if (!op) throw new AtomicCoreError('INVALID_ARGUMENT', 'Unknown Strata preparation operation.')
    return op
  }

  begin(request: StrataPreparationRequest): Promise<StrataPreparationOperation> {
    validate(request)
    const input = structuredClone(request)
    return this.coordination.run(async () => {
      if (this.closed) throw new AtomicCoreError('CORE_NOT_RUNNING', 'Strata preparation is shutting down.')
      const existing = this.list().find((o) => o.request_id === input.request_id)
      if (existing) {
        if (requestKey(existing) !== requestKey(input))
          throw new AtomicCoreError('INVALID_ARGUMENT', 'Strata request_id was reused with different inputs.')
        return existing
      }
      if (this.store.snapshot().maintenance.some((m) => m.operation.request_id === input.request_id))
        throw new AtomicCoreError('INVALID_ARGUMENT', 'Strata request_id already belongs to maintenance.')
      await this.check(input)
      const { backend, digest } = await this.deps.resolve(input)
      if (digest !== input.source_digest)
        throw new AtomicCoreError('MODEL_INCOMPATIBLE', 'Strata source changed before preparation.')
      const op: StrataPreparationOperation = {
        ...input,
        operation_id: randomUUID(),
        revision: 1,
        state: 'queued',
        stage: 'queued',
        error: null,
      }
      await this.store.change((s) => {
        s.preparations.push({ operation: op, backend })
      })
      this.deps.emit(structuredClone(op))
      this.launch(op, backend)
      return structuredClone(op)
    })
  }

  private async check(request: StrataPreparationRequest, ownId?: string): Promise<void> {
    if (
      this.list().some((o) => o.model_id === request.model_id && o.operation_id !== ownId && active(o.state))
    )
      throw new AtomicCoreError('GPU_BUSY', 'Strata model already has an active preparation.')
    const guard = this.store
      .snapshot()
      .maintenance.find(
        (m) => m.operation.model_id === request.model_id && m.operation.state !== 'completed'
      )?.operation
    if (guard) {
      if (
        guard.operation_id !== request.maintenance_id ||
        guard.action !== 'replace' ||
        !guard.ready_to_mutate ||
        guard.state !== 'held' ||
        guard.target_source_digest !== request.source_digest
      )
        throw new AtomicCoreError('GPU_BUSY', 'Strata model is under maintenance.')
    } else if (request.maintenance_id !== undefined)
      throw new AtomicCoreError('INVALID_ARGUMENT', 'Strata maintenance guard is missing or completed.')
  }

  resume(id: string): Promise<StrataPreparationOperation> {
    return this.coordination.run(async () => {
      if (this.closed) throw new AtomicCoreError('CORE_NOT_RUNNING', 'Strata preparation is shutting down.')
      const op = this.get(id)
      if (active(op.state) || op.state === 'ready') return op
      await this.check(op, id)
      const { backend, digest } = await this.deps.resolve(op)
      if (digest !== op.source_digest)
        throw new AtomicCoreError(
          'MODEL_INCOMPATIBLE',
          'Strata source changed; create a new preparation request.'
        )
      const queued = await this.update(id, { state: 'queued', stage: 'queued', error: null }, backend)
      this.launch(queued, backend)
      return queued
    })
  }

  async cancel(id: string): Promise<StrataPreparationOperation> {
    const job = await this.coordination.run(async () => {
      const op = this.get(id),
        running = this.jobs.get(id)
      if (running) {
        running.controller.abort()
        return running
      }
      if (op.state === 'interrupted') await this.update(id, { state: 'cancelled', error: null })
      return undefined
    })
    await job?.promise
    return this.get(id)
  }

  async settled(id: string): Promise<void> {
    await this.jobs.get(id)?.promise
  }

  async shutdown(): Promise<void> {
    this.closed = true
    const jobs = await this.coordination.run(async () => {
      for (const job of this.jobs.values()) job.controller.abort()
      return [...this.jobs.values()].map((j) => j.promise)
    })
    await Promise.all(jobs)
  }

  private launch(op: StrataPreparationOperation, backend: StrataBackend): void {
    const controller = new AbortController()
    const promise = Promise.resolve()
      .then(async () => {
        try {
          await this.update(op.operation_id, { state: 'preparing', stage: 'checking-inputs', error: null })
          controller.signal.throwIfAborted()
          await this.deps.run(op, backend, controller.signal, async (stage, completed, total) => {
            controller.signal.throwIfAborted()
            await this.update(op.operation_id, {
              state: stage === 'verifying' ? 'verifying' : 'preparing',
              stage,
              ...(completed === undefined ? {} : { completed_bytes: completed }),
              ...(total === undefined ? {} : { total_bytes: total }),
            })
          })
          controller.signal.throwIfAborted()
          await this.update(op.operation_id, { state: 'ready', stage: 'ready', error: null })
        } catch (error) {
          const cancelled = controller.signal.aborted
          await this.update(op.operation_id, {
            state: cancelled ? 'cancelled' : 'failed',
            error: cancelled
              ? null
              : {
                  code: error instanceof AtomicCoreError ? error.code : 'MODEL_LOAD_FAILED',
                  message: error instanceof Error ? error.message : 'Strata preparation failed.',
                },
          })
        }
      })
      .catch((error: unknown) => {
        this.failure = error
      })
      .finally(() => {
        this.jobs.delete(op.operation_id)
      })
    this.jobs.set(op.operation_id, { controller, promise })
  }

  private async update(
    id: string,
    patch: Partial<StrataPreparationOperation>,
    backend?: StrataBackend
  ): Promise<StrataPreparationOperation> {
    const op = await this.store.change((s) => {
      const row = s.preparations.find((r) => r.operation.operation_id === id)!
      row.operation = { ...row.operation, ...patch, revision: row.operation.revision + 1 }
      if (backend) row.backend = backend
      if (patch.stage !== undefined && patch.stage !== 'ready') {
        if (patch.completed_bytes === undefined) delete row.operation.completed_bytes
        if (patch.total_bytes === undefined) delete row.operation.total_bytes
      }
      return row.operation
    })
    this.deps.emit(structuredClone(op))
    return op
  }
}
