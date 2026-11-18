import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { AtomicCoreError, STRATA_PREPARATION_STATES } from '../../contracts/index.js'
import type { StrataBackend, StrataMaintenance, StrataPreparationOperation } from '../../contracts/index.js'
import { FifoLock } from '../shared/index.js'

export interface StrataOperationState {
  version: 1
  preparations: Array<{ operation: StrataPreparationOperation; backend: StrataBackend }>
  maintenance: Array<{ operation: StrataMaintenance; originalDigest: string | null }>
}

function validate(raw: unknown): asserts raw is StrataOperationState {
  const bad = (): never => {
    throw new AtomicCoreError('IO_ERROR', 'Strata operation journal is corrupt; maintenance remains blocked.')
  }
  if (!raw || typeof raw !== 'object') return bad()
  const v = raw as StrataOperationState
  if (v.version !== 1 || !Array.isArray(v.preparations) || !Array.isArray(v.maintenance)) return bad()
  const ids = new Set<string>(),
    requests = new Set<string>()
  const digest = (s: unknown) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)
  const text = (s: unknown) => typeof s === 'string' && s.length > 0 && s.length <= 1024 && !s.includes('\0')
  for (const row of [...v.preparations, ...v.maintenance]) {
    const op = row?.operation
    if (
      !op ||
      !text(op.operation_id) ||
      !text(op.request_id) ||
      !text(op.model_id) ||
      !Number.isSafeInteger(op.revision) ||
      op.revision < 1 ||
      ids.has(op.operation_id) ||
      requests.has(op.request_id)
    )
      return bad()
    ids.add(op.operation_id)
    requests.add(op.request_id)
  }
  for (const { operation: o, backend } of v.preparations) {
    if (
      !STRATA_PREPARATION_STATES.includes(o.state) ||
      !text(o.stage) ||
      !digest(o.source_digest) ||
      !['cuda', 'hip', 'metal', 'sycl'].includes(backend) ||
      (o.maintenance_id !== undefined && !text(o.maintenance_id))
    )
      return bad()
    if (o.error !== null && (!o.error || !text(o.error.code) || typeof o.error.message !== 'string'))
      return bad()
    for (const n of [o.completed_bytes, o.total_bytes])
      if (n !== undefined && (!Number.isSafeInteger(n) || n < 0)) return bad()
  }
  for (const { operation: o, originalDigest } of v.maintenance) {
    if (
      !['stopping', 'held', 'completed'].includes(o.state) ||
      !['replace', 'remove'].includes(o.action) ||
      typeof o.ready_to_mutate !== 'boolean' ||
      (o.action === 'replace' && !digest(o.target_source_digest)) ||
      (o.action === 'remove' && o.target_source_digest !== undefined) ||
      (originalDigest !== null && !digest(originalDigest)) ||
      (o.ready_to_mutate && o.state !== 'held')
    )
      return bad()
  }
}

/** One atomic journal for idempotency and exclusion; a torn file never clears a guard. */
export class StrataOperationStore {
  private state: StrataOperationState = { version: 1, preparations: [], maintenance: [] }
  private readonly lock = new FifoLock()
  private constructor(private readonly root: string) {}

  static async open(root: string): Promise<StrataOperationStore> {
    await mkdir(root, { recursive: true, mode: 0o700 })
    if (!(await lstat(root)).isDirectory())
      throw new AtomicCoreError('IO_ERROR', 'Strata journal directory is redirected.')
    const store = new StrataOperationStore(root)
    try {
      const file = await open(join(root, 'operations.json'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid journal file')
        const raw: unknown = JSON.parse(await file.readFile('utf8'))
        validate(raw)
        store.state = raw
      } finally {
        await file.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new AtomicCoreError(
          'IO_ERROR',
          'Cannot read Strata operation journal; maintenance remains blocked.'
        )
    }
    let changed = false
    for (const { operation: o } of store.state.preparations)
      if (['queued', 'preparing', 'verifying'].includes(o.state)) {
        o.state = 'interrupted'
        o.revision++
        changed = true
      }
    // A previous process's stop proof is not reused by a new owner until it reconciles the journal.
    for (const { operation: o } of store.state.maintenance)
      if (o.state === 'held') {
        o.state = 'stopping'
        o.ready_to_mutate = false
        o.revision++
        changed = true
      }
    if (changed) await store.persist(store.state)
    return store
  }

  snapshot(): StrataOperationState {
    return structuredClone(this.state)
  }

  change<T>(update: (next: StrataOperationState) => T): Promise<T> {
    return this.lock.run(async () => {
      const next = this.snapshot(),
        result = update(next)
      validate(next)
      await this.persist(next)
      this.state = next
      return structuredClone(result)
    })
  }

  private async persist(state: StrataOperationState): Promise<void> {
    const temp = join(this.root, '.operations-' + randomUUID() + '.tmp')
    try {
      const file = await open(temp, 'wx', 0o600)
      try {
        await file.writeFile(JSON.stringify(state) + '\n')
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temp, join(this.root, 'operations.json'))
    } finally {
      await rm(temp, { force: true })
    }
  }
}
