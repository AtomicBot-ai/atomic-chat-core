import { randomUUID } from 'node:crypto'
import { isFastFlowLmVariantId } from '../../client/index.js'
import {
  AtomicCoreError,
  type FastFlowLmMaintenance,
  type FastFlowLmMaintenanceRequest,
} from '../../contracts/index.js'
import type { AsyncMutex } from '../../diffusion/index.js'
import { FlmJournal } from './journal.js'
const conflict = (why: string): never => {
  throw new AtomicCoreError('MANAGED_OPERATION_CONFLICT', why)
}
export class FlmMaintenance {
  private closed = false
  async close() {
    this.closed = true
    await this.lock.run(async () => {})
  }
  private assertOpen() {
    if (this.closed) throw new AtomicCoreError('CORE_NOT_RUNNING', 'The FastFlowLM owner has stopped.')
  }
  private readonly journal: FlmJournal<FastFlowLmMaintenance>
  constructor(
    dir: string,
    private readonly lock: AsyncMutex,
    private readonly stop: (id: string) => Promise<void>,
    private readonly scan: (op: FastFlowLmMaintenance) => Promise<void>,
    dataRoot?: string
  ) {
    this.journal = new FlmJournal(dir, (r) => r.operation_id, dataRoot)
  }
  list() {
    return this.journal.all()
  }
  get(id: string) {
    return this.journal.read(id)
  }
  /** Called inside the same lock as begin/complete, before even returning a resident session. */
  async assertLoadable(id: string) {
    if ((await this.list()).some((op) => op.model_id === id && op.state !== 'completed'))
      return conflict('FastFlowLM model maintenance is active.')
  }
  begin(req: FastFlowLmMaintenanceRequest) {
    return this.lock.run(async () => {
      this.assertOpen()
      if (
        !req ||
        typeof req.request_id !== 'string' ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(req.request_id) ||
        !isFastFlowLmVariantId(req.model_id) ||
        !['replace', 'remove'].includes(req.kind) ||
        Object.keys(req).length !== 3
      )
        throw new AtomicCoreError('INVALID_ARGUMENT', 'Invalid FastFlowLM maintenance request.')
      const rows = await this.list()
      let op = rows.find((r) => r.request_id === req.request_id)
      if (op && (req.model_id !== op.model_id || req.kind !== op.kind))
        return conflict('The request ID already describes another maintenance operation.')
      if (!op) {
        await this.assertLoadable(req.model_id)
        op = { ...req, operation_id: randomUUID(), state: 'stopping', ready_to_mutate: false }
        await this.journal.write(op)
      }
      if (op.state === 'stopping') {
        await this.stop(op.model_id)
        op = { ...op, state: 'held', ready_to_mutate: true }
        await this.journal.write(op)
      }
      return { operation_id: op.operation_id, ready_to_mutate: op.ready_to_mutate }
    })
  }
  complete(id: string) {
    return this.lock.run(async () => {
      this.assertOpen()
      const op = await this.get(id)
      if (op.state === 'completed') return op
      if (op.state !== 'held') return conflict('The model has not finished stopping.')
      await this.scan(op)
      const done = { ...op, state: 'completed' as const, ready_to_mutate: false as const }
      await this.journal.write(done)
      return done
    })
  }
}
