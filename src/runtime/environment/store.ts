/**
 * Where a durable operation lives between the moments anyone is watching it.
 *
 * A setup outlives the dialog that opened it, the app, and often the core: it can be waiting for a
 * sign-out, a reboot, or a 16 GB download. Three things follow. The record has to survive being
 * interrupted at any point, so a write never overwrites the only good copy — the previous one is
 * kept and read back if the newest is torn. Progress is only ever committed against the revision it
 * was computed from, so a late writer cannot step on a newer state. And the record is shared: the
 * app core and the CLI core drive one environment, so every read-modify-write happens inside a lock
 * file both of them respect.
 *
 * Idempotency is the other half. A client that retries `begin` with the same request must get the
 * operation it already started, not a second install of the same thing; a client that retries with
 * the same id but different contents is a bug, and is told so.
 */

import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicCoreError, MANAGED_PHASES } from '../../contracts/index.js'
import type {
  BeginOperation,
  ManagedHostReceipt,
  ManagedPhase,
  RequirementPlan,
  Sha256Digest,
} from '../../contracts/index.js'
import { encodeManagedId, managedSharedPaths } from '../../config/index.js'
import { canonicalDigest } from './canonical-json.js'
import { startOperation, type OperationMachine } from './state.js'

/** Phases from which an operation will not move on its own, so nothing needs recovering. */
const TERMINAL: readonly ManagedPhase[] = ['ready', 'removed', 'cancelled', 'failed']

export interface PersistedOperation {
  machine: OperationMachine
  /** What makes two `begin` calls the same request; see `beginFingerprint`. */
  request_digest: Sha256Digest
  request: BeginOperation
  requirement_plan: RequirementPlan | null
  /** Receipt nonce to the digest of the receipt that consumed it. A nonce is used once. */
  accepted_receipt_digests: Record<string, Sha256Digest>
  completed_effect_ids: string[]
  /** What this operation has actually created, so recovery adopts by identity and not by name. */
  owned_resource_ids: string[]
}

/** The slice of `node:fs/promises` the store needs; tests pass an in-memory fake. */
export interface StoreFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(path: string, data: string, options?: { encoding?: 'utf8'; mode?: number }): Promise<void>
  rename(from: string, to: string): Promise<void>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>
  readdir(path: string): Promise<string[]>
  rm(path: string, options?: { force?: boolean }): Promise<void>
  stat(path: string): Promise<{ mtimeMs: number }>
  /** Exclusive create: the whole mutual exclusion rests on this failing when the file exists. */
  openExclusive(path: string): Promise<{ close(): Promise<void> }>
}

const NODE_FS: StoreFs = {
  readFile,
  writeFile,
  rename,
  mkdir,
  readdir,
  rm,
  stat: async (path) => stat(path),
  openExclusive: async (path) => open(path, 'wx'),
}

export interface OperationStoreOptions {
  /** The shared per-user managed root; both scopes address the same one. */
  root: string
  instanceId: string
  newOperationId: () => string
  newEffectId: () => string
  fs?: StoreFs
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** A lock file older than this belonged to a process that died holding it. */
  lockTtlMs?: number
  lockAttempts?: number
  lockRetryMs?: number
}

const DEFAULT_LOCK_TTL_MS = 30_000
const DEFAULT_LOCK_ATTEMPTS = 40
const DEFAULT_LOCK_RETRY_MS = 50

const busy = (): AtomicCoreError =>
  new AtomicCoreError(
    'MANAGED_OPERATION_CONFLICT',
    'Another Atomic Chat process is changing the managed runtime; try again in a moment.'
  )

const corrupt = (operationId: string): AtomicCoreError =>
  new AtomicCoreError(
    'MANAGED_METADATA_INVALID',
    'The record of this operation cannot be read, so what it owns is unknown.',
    operationId
  )

const isPhase = (value: unknown): value is ManagedPhase =>
  typeof value === 'string' && (MANAGED_PHASES as readonly string[]).includes(value)

/** Enough of a shape check to tell a record from a truncated write or a foreign file. */
const parseRecord = (text: string): PersistedOperation | null => {
  try {
    const raw = JSON.parse(text) as PersistedOperation
    const operation = raw?.machine?.operation
    if (operation === undefined || typeof operation.operation_id !== 'string') return null
    if (!Number.isSafeInteger(operation.revision) || operation.revision < 0) return null
    if (!isPhase(operation.phase)) return null
    if (typeof raw.request_digest !== 'string') return null
    return raw
  } catch {
    return null
  }
}

export class OperationStore {
  private readonly paths: ReturnType<typeof managedSharedPaths>
  private readonly fs: StoreFs
  private readonly options: Required<
    Pick<OperationStoreOptions, 'instanceId' | 'newOperationId' | 'newEffectId'>
  > & {
    now: () => number
    sleep: (ms: number) => Promise<void>
    lockTtlMs: number
    lockAttempts: number
    lockRetryMs: number
  }

  constructor(options: OperationStoreOptions) {
    this.paths = managedSharedPaths(options.root)
    this.fs = options.fs ?? NODE_FS
    this.options = {
      instanceId: options.instanceId,
      newOperationId: options.newOperationId,
      newEffectId: options.newEffectId,
      now: options.now ?? Date.now,
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      lockTtlMs: options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS,
      lockAttempts: options.lockAttempts ?? DEFAULT_LOCK_ATTEMPTS,
      lockRetryMs: options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS,
    }
  }

  /**
   * Start an operation, or hand back the one this request already started. A retry of the same
   * request is the same operation; the same request id carrying something else is a conflict, and
   * a second operation on an environment that is already busy is refused before anything is written.
   */
  async createOrGet(
    environmentId: string,
    input: BeginOperation,
    requestDigest: Sha256Digest
  ): Promise<{ record: PersistedOperation; created: boolean }> {
    return this.withLock(async () => {
      const existing = await this.all()
      const sameRequest = existing.find((record) => record.request.request_id === input.request_id)
      if (sameRequest !== undefined) {
        if (sameRequest.request_digest !== requestDigest) {
          throw new AtomicCoreError(
            'MANAGED_OPERATION_CONFLICT',
            'That request id was already used for a different operation.',
            input.request_id
          )
        }
        return { record: sameRequest, created: false }
      }
      const running = existing.find(
        (record) =>
          record.machine.operation.environment_id === environmentId &&
          !TERMINAL.includes(record.machine.operation.phase)
      )
      if (running !== undefined) {
        throw new AtomicCoreError(
          'MANAGED_OPERATION_CONFLICT',
          'Another change to this environment is still running.',
          running.machine.operation.operation_id
        )
      }

      const started = startOperation(
        {
          operation_id: this.options.newOperationId(),
          request_id: input.request_id,
          environment_id: environmentId,
          instance_id: this.options.instanceId,
          target: input.target,
          kind: input.kind,
          ...(input.approved_plan_digest === undefined
            ? {}
            : { approved_plan_digest: input.approved_plan_digest }),
        },
        { next_effect_id: this.options.newEffectId() }
      )
      const record: PersistedOperation = {
        machine: started.state,
        request_digest: requestDigest,
        request: input,
        requirement_plan: null,
        accepted_receipt_digests: {},
        completed_effect_ids: [],
        owned_resource_ids: [],
      }
      await this.write(record)
      return { record, created: true }
    })
  }

  /** The current record, or null when there is no such operation. Throws when one cannot be read. */
  async read(operationId: string): Promise<PersistedOperation | null> {
    const path = this.paths.operationFile(operationId)
    const current = await this.readRecord(path)
    if (current !== null) return current
    // The newest write was interrupted. The one before it is a real state this operation was in,
    // and recovery will reconcile from there; inventing an empty record would claim it owns nothing.
    const previous = await this.readRecord(`${path}.bak`)
    if (previous !== null) return previous
    const exists = await this.exists(path)
    if (!exists && !(await this.exists(`${path}.bak`))) return null
    throw corrupt(operationId)
  }

  /**
   * Commit the next state, but only if nothing else has moved the operation since. Returns false
   * without writing when it has, which is how two writers find out they raced.
   */
  async compareAndSwap(
    operationId: string,
    expectedRevision: number,
    next: PersistedOperation
  ): Promise<boolean> {
    return this.withLock(async () => {
      const current = await this.read(operationId)
      if (current === null) return false
      if (current.machine.operation.revision !== expectedRevision) return false
      if (next.machine.operation.operation_id !== operationId) {
        throw new AtomicCoreError(
          'MANAGED_IDENTITY_MISMATCH',
          'That state belongs to another operation.',
          operationId
        )
      }
      await this.write(next)
      return true
    })
  }

  /** Every operation that has not finished, for a core deciding what to pick up at startup. */
  async listRecoverable(): Promise<PersistedOperation[]> {
    const all = await this.all()
    return all.filter((record) => !TERMINAL.includes(record.machine.operation.phase))
  }

  private async all(): Promise<PersistedOperation[]> {
    let entries: string[]
    try {
      entries = await this.fs.readdir(this.paths.operationsDir)
    } catch {
      return []
    }
    const records: PersistedOperation[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const record = await this.readRecord(join(this.paths.operationsDir, entry))
      if (record === null) {
        const recovered = await this.readRecord(join(this.paths.operationsDir, `${entry}.bak`))
        if (recovered === null) throw corrupt(entry)
        records.push(recovered)
        continue
      }
      records.push(record)
    }
    return records
  }

  private async readRecord(path: string): Promise<PersistedOperation | null> {
    try {
      return parseRecord(await this.fs.readFile(path, 'utf8'))
    } catch {
      return null
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await this.fs.stat(path)
      return true
    } catch {
      return false
    }
  }

  /** Keep the previous record, then swap the new one in with a rename nothing can half-apply. */
  private async write(record: PersistedOperation): Promise<void> {
    const path = this.paths.operationFile(record.machine.operation.operation_id)
    await this.fs.mkdir(this.paths.operationsDir, { recursive: true })
    const tmp = `${path}.tmp`
    await this.fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    if (await this.exists(path)) await this.fs.rename(path, `${path}.bak`)
    await this.fs.rename(tmp, path)
  }

  private async withLock<T>(run: () => Promise<T>): Promise<T> {
    const handle = await this.acquire()
    try {
      return await run()
    } finally {
      await handle.close().catch(() => undefined)
      await this.fs.rm(this.paths.lockFile, { force: true }).catch(() => undefined)
    }
  }

  private async acquire(): Promise<{ close(): Promise<void> }> {
    await this.fs.mkdir(this.paths.root, { recursive: true })
    for (let attempt = 0; attempt < this.options.lockAttempts; attempt += 1) {
      try {
        return await this.fs.openExclusive(this.paths.lockFile)
      } catch {
        // Somebody holds it, or somebody died holding it. Only age tells those apart.
        const age = await this.lockAge()
        if (age !== null && age > this.options.lockTtlMs) {
          await this.fs.rm(this.paths.lockFile, { force: true }).catch(() => undefined)
          continue
        }
        await this.options.sleep(this.options.lockRetryMs)
      }
    }
    throw busy()
  }

  private async lockAge(): Promise<number | null> {
    try {
      const info = await this.fs.stat(this.paths.lockFile)
      return this.options.now() - info.mtimeMs
    } catch {
      return null
    }
  }
}

export type ReceiptVerdict = 'fresh' | 'duplicate'

/**
 * Whether a host receipt may be acted on. A receipt's nonce is single use: the identical one
 * arriving twice is a retry and its effect must not run again, and a different one for a nonce
 * already spent is either a confused client or a replay, and is refused.
 */
export function classifyReceipt(record: PersistedOperation, receipt: ManagedHostReceipt): ReceiptVerdict {
  const seen = record.accepted_receipt_digests[receipt.nonce]
  if (seen === undefined) return 'fresh'
  return seen === canonicalDigest(receipt)
    ? 'duplicate'
    : (() => {
        throw new AtomicCoreError(
          'MANAGED_RECEIPT_CONFLICT',
          'A different result was already recorded for this authorization.',
          receipt.nonce
        )
      })()
}

/** Record that this receipt consumed its nonce. */
export function withReceipt(record: PersistedOperation, receipt: ManagedHostReceipt): PersistedOperation {
  return {
    ...record,
    accepted_receipt_digests: {
      ...record.accepted_receipt_digests,
      [receipt.nonce]: canonicalDigest(receipt),
    },
  }
}

/** The directory name an operation's record takes, exported for tests and diagnostics. */
export const operationFileName = (operationId: string): string => `${encodeManagedId(operationId)}.json`
