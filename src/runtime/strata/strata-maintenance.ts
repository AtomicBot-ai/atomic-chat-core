import { randomUUID } from 'node:crypto'
import { AtomicCoreError } from '../../contracts/index.js'
import type { StrataMaintenance, StrataMaintenanceRequest } from '../../contracts/index.js'
import type { StrataPreparationService } from './strata-preparation.js'

export interface StrataMaintenanceDependencies {
  /** Null means the model directory is absent; invalid or unverified data must never return ready. */
  inspect(modelId: string): Promise<{ digest: string; ready: boolean } | null>
  /** Confirms every owned process has exited, otherwise rejects and retains exclusion. */
  stop(modelId: string): Promise<void>
  /** Deletes only owned derivatives, retaining the verified digest on replacement or rollback. */
  cleanup(modelId: string, keepDigest: string | null): Promise<void>
}
const key = (r: StrataMaintenanceRequest) =>
  JSON.stringify([r.request_id, r.model_id, r.action, r.target_source_digest ?? null])
const active = (state: string) => ['queued', 'preparing', 'verifying'].includes(state)

/** A durable exclusion token, not a client assertion that deleting or replacing files succeeded. */
export class StrataMaintenanceService {
  private readonly stopping = new Map<string, Promise<StrataMaintenance>>()
  constructor(
    private readonly preparations: StrataPreparationService,
    private readonly deps: StrataMaintenanceDependencies
  ) {}

  list(): StrataMaintenance[] {
    return this.preparations.store.snapshot().maintenance.map((r) => r.operation)
  }
  get(id: string): StrataMaintenance {
    const op = this.list().find((o) => o.operation_id === id)
    if (!op) throw new AtomicCoreError('INVALID_ARGUMENT', 'Unknown Strata maintenance operation.')
    return op
  }

  async begin(request: StrataMaintenanceRequest): Promise<StrataMaintenance> {
    if (
      !request ||
      typeof request !== 'object' ||
      Object.keys(request).some(
        (k) => !['request_id', 'model_id', 'action', 'target_source_digest'].includes(k)
      ) ||
      [request.request_id, request.model_id].some(
        (v) => typeof v !== 'string' || !v || v.length > 1024 || v.includes('\0')
      ) ||
      !['replace', 'remove'].includes(request.action) ||
      (request.action === 'replace' &&
        (typeof request.target_source_digest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(request.target_source_digest))) ||
      (request.action === 'remove' && request.target_source_digest !== undefined)
    )
      throw new AtomicCoreError('INVALID_ARGUMENT', 'Invalid Strata maintenance request.')
    const input = structuredClone(request)
    const op = await this.preparations.coordination.run(async () => {
      const existing = this.list().find((o) => o.request_id === input.request_id)
      if (existing) {
        if (key(existing) !== key(input))
          throw new AtomicCoreError(
            'INVALID_ARGUMENT',
            'Strata request_id was reused with different maintenance inputs.'
          )
        return existing
      }
      if (this.preparations.list().some((o) => o.request_id === input.request_id))
        throw new AtomicCoreError('INVALID_ARGUMENT', 'Strata request_id already belongs to preparation.')
      if (this.list().some((o) => o.model_id === input.model_id && o.state !== 'completed'))
        throw new AtomicCoreError('GPU_BUSY', 'Strata model already has an active maintenance guard.')
      const original = await this.deps.inspect(input.model_id)
      const operation: StrataMaintenance = {
        ...input,
        operation_id: randomUUID(),
        revision: 1,
        state: 'stopping',
        ready_to_mutate: false,
      }
      await this.preparations.store.change((s) => {
        s.maintenance.push({ operation, originalDigest: original?.digest ?? null })
      })
      return operation
    })
    if (op.state !== 'stopping') return op
    const existing = this.stopping.get(op.operation_id)
    if (existing) return existing
    const promise = this.hold(op).finally(() => {
      this.stopping.delete(op.operation_id)
    })
    this.stopping.set(op.operation_id, promise)
    return promise
  }

  private async hold(op: StrataMaintenance): Promise<StrataMaintenance> {
    for (const p of this.preparations.list())
      if (p.model_id === op.model_id && (active(p.state) || p.state === 'interrupted'))
        await this.preparations.cancel(p.operation_id)
    await this.deps.stop(op.model_id)
    return this.preparations.coordination.run(() =>
      this.preparations.store.change((s) => {
        const row = s.maintenance.find((r) => r.operation.operation_id === op.operation_id)!
        row.operation = {
          ...row.operation,
          revision: row.operation.revision + 1,
          state: 'held',
          ready_to_mutate: true,
        }
        return row.operation
      })
    )
  }

  complete(id: string): Promise<StrataMaintenance> {
    return this.preparations.coordination.run(async () => {
      const op = this.get(id)
      if (op.state === 'completed') return op
      if (op.state !== 'held' || !op.ready_to_mutate)
        throw new AtomicCoreError('GPU_BUSY', 'Strata maintenance stop is not confirmed.')
      if (this.preparations.list().some((p) => p.model_id === op.model_id && active(p.state)))
        throw new AtomicCoreError('GPU_BUSY', 'Strata replacement is still preparing.')
      const actual = await this.deps.inspect(op.model_id)
      if (op.action === 'remove') {
        if (actual !== null)
          throw new AtomicCoreError('MODEL_INCOMPATIBLE', 'Strata model has not been removed.')
      } else {
        const original = this.preparations.store
          .snapshot()
          .maintenance.find((r) => r.operation.operation_id === id)!.originalDigest
        if (!actual?.ready || ![original, op.target_source_digest].includes(actual.digest))
          throw new AtomicCoreError(
            'MODEL_INCOMPATIBLE',
            'Strata replacement or rollback is not verified ready.'
          )
      }
      await this.deps.cleanup(op.model_id, actual?.digest ?? null)
      return this.preparations.store.change((s) => {
        const row = s.maintenance.find((r) => r.operation.operation_id === id)!
        row.operation = {
          ...row.operation,
          revision: row.operation.revision + 1,
          state: 'completed',
          ready_to_mutate: false,
        }
        return row.operation
      })
    })
  }

  /** Runtime load and maintenance share the same exclusion point, including asynchronous preflight. */
  withLoad<T>(modelId: string, work: () => Promise<T>): Promise<T> {
    return this.preparations.coordination.run(async () => {
      if (this.list().some((o) => o.model_id === modelId && o.state !== 'completed'))
        throw new AtomicCoreError('GPU_BUSY', 'Strata model is under maintenance.')
      if (this.preparations.list().some((o) => o.model_id === modelId && active(o.state)))
        throw new AtomicCoreError('GPU_BUSY', 'Strata model is preparing.')
      return work()
    })
  }
}
