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

import { randomUUID } from 'node:crypto'
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
import { TAKEOVER_MUTEX_TTL_MS } from '../../lock/index.js'
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
  /**
   * What this operation has actually created, so recovery adopts by identity and not by name.
   * Monotonic: `compareAndSwap` writes the union of what is on disk and what it is given, and
   * `recordOwned` only adds, so no commit — however stale the read it was computed from — ever drops
   * an entry (review r2, item B). Nothing can remove one today; a future release of a resource (an
   * update deleting what an operation made) needs a store method of its own that removes under the
   * lock, not a `compareAndSwap` with a shorter list, which this union would silently undo.
   */
  owned_resource_ids: string[]
  /**
   * The process that last wrote this record, stamped by the store on every write (never by a
   * caller). App and CLI cores share this store, so a core deciding whether to recover a
   * non-terminal operation needs to know whether the core that last touched it is still running —
   * this is the identity `EnvironmentService.recover` checks with `verifyProcessIdentity`
   * (`src/lock/process-identity.ts`), the same primitive `InstanceLock` uses for its own takeover
   * decision. `null` only for a record this store has never written (see `speculative` in
   * `service.ts`, a probe's throwaway record that never reaches disk).
   */
  owner_pid: number | null
  owner_process_start_id: string | null
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

/** This process's own identity, or a fake one a test injects. See `PersistedOperation.owner_pid`. */
export interface OwnerIdentity {
  pid: number
  startId: string | null
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
  /**
   * What to stamp as the owner of every record this store writes. Required, not defaulted: the
   * one production caller (`wireManagedRuntimes`, `wiring.ts`) already builds a real one over
   * `src/lock/process-identity.ts`'s `processStartId`, resolved once and cached there — a
   * process's start identity does not change while it runs, and re-probing it on every write would
   * mean an `exec` per commit on macOS and Windows. A second, unused default here would be code
   * this store's own tests would have to either exercise for real (slow, platform-dependent, and
   * pointless when nothing calls it) or leave permanently uncovered.
   */
  ownerIdentity: () => Promise<OwnerIdentity>
}

const DEFAULT_LOCK_TTL_MS = 30_000
const DEFAULT_LOCK_ATTEMPTS = 40
const DEFAULT_LOCK_RETRY_MS = 50

const busy = (): AtomicCoreError =>
  new AtomicCoreError(
    'MANAGED_OPERATION_CONFLICT',
    'Another Atomic Chat process is changing the managed runtime; try again in a moment.'
  )

/**
 * A record on disk that cannot be read. This is never the caller's fault — nothing in a request
 * produced it, an interrupted write or a foreign file did — so it carries `IO_ERROR`, not
 * `MANAGED_METADATA_INVALID`: that code is for a client-supplied descriptor or plan this core
 * refused, and conflating the two would answer a caller's mistake and this store's own corruption
 * with the same 400.
 */
const corrupt = (operationId: string): AtomicCoreError =>
  new AtomicCoreError(
    'IO_ERROR',
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
    // Older than this field, or written by something else entirely: treat as unrecorded rather
    // than reject the whole record over one optional pair of fields.
    return {
      ...raw,
      owner_pid: typeof raw.owner_pid === 'number' ? raw.owner_pid : null,
      owner_process_start_id:
        typeof raw.owner_process_start_id === 'string' ? raw.owner_process_start_id : null,
    }
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
    ownerIdentity: () => Promise<OwnerIdentity>
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
      ownerIdentity: options.ownerIdentity,
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
        // `write` stamps this store's own identity before the record reaches disk.
        owner_pid: null,
        owner_process_start_id: null,
      }
      const stamped = await this.write(record, true)
      return { record: stamped, created: true }
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
      // What an operation created only ever grows: a commit computed from a read taken before
      // `recordOwned` must not drop what was recorded since (review r2, item B).
      await this.write({
        ...next,
        owned_resource_ids: [...new Set([...current.owned_resource_ids, ...next.owned_resource_ids])],
      })
      return true
    })
  }

  /**
   * Record, at once and durably, resources this operation is about to create — before creating
   * them, so a core that dies halfway still knows what was its own. Does not move the revision: it
   * changes what the operation owns, never where it stands.
   */
  async recordOwned(operationId: string, resourceIds: string[]): Promise<void> {
    await this.withLock(async () => {
      const current = await this.read(operationId)
      if (current === null) {
        throw new AtomicCoreError('MANAGED_OPERATION_NOT_FOUND', 'No such operation.', operationId)
      }
      const owned = [...new Set([...current.owned_resource_ids, ...resourceIds])]
      if (owned.length === current.owned_resource_ids.length) return
      await this.write({ ...current, owned_resource_ids: owned })
    })
  }

  /** Every operation that has not finished, for a core deciding what to pick up at startup. */
  async listRecoverable(): Promise<PersistedOperation[]> {
    const all = await this.all()
    return all.filter((record) => !TERMINAL.includes(record.machine.operation.phase))
  }

  /**
   * Every operation this directory holds, one entry per operation id however it currently sits on
   * disk. `write` always leaves at least one of `<id>.json`/`<id>.json.bak` readable, but a crash
   * between renaming the old file to `.bak` and renaming the new one into place (`write`, below)
   * can leave only the `.bak` — so both extensions are scanned for base names before either is
   * read, or that operation would be invisible here even though `read(operationId)` finds it.
   */
  private async all(): Promise<PersistedOperation[]> {
    let entries: string[]
    try {
      entries = await this.fs.readdir(this.paths.operationsDir)
    } catch {
      return []
    }
    const baseNames = new Set<string>()
    for (const entry of entries) {
      if (entry.endsWith('.json')) baseNames.add(entry)
      else if (entry.endsWith('.json.bak')) baseNames.add(entry.slice(0, -'.bak'.length))
    }
    const records: PersistedOperation[] = []
    for (const entry of baseNames) {
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

  /**
   * Keep the previous record, then swap the new one in with a rename nothing can half-apply.
   * Stamps this store's own process identity on the way out — never the caller's job, so nothing
   * upstream can claim to be a different core than the one actually holding this handle — and
   * returns the stamped copy, since that is what actually landed on disk.
   */
  private async write(record: PersistedOperation): Promise<void>
  private async write(record: PersistedOperation, returnStamped: true): Promise<PersistedOperation>
  private async write(record: PersistedOperation, returnStamped = false): Promise<PersistedOperation | void> {
    const identity = await this.options.ownerIdentity()
    const stamped: PersistedOperation = {
      ...record,
      owner_pid: identity.pid,
      owner_process_start_id: identity.startId,
    }
    const path = this.paths.operationFile(stamped.machine.operation.operation_id)
    await this.fs.mkdir(this.paths.operationsDir, { recursive: true })
    const tmp = `${path}.tmp`
    await this.fs.writeFile(tmp, `${JSON.stringify(stamped, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    if (await this.exists(path)) await this.fs.rename(path, `${path}.bak`)
    await this.fs.rename(tmp, path)
    if (returnStamped) return stamped
  }

  private async withLock<T>(run: () => Promise<T>): Promise<T> {
    const { handle, token } = await this.acquire()
    try {
      return await run()
    } finally {
      await handle.close().catch(() => undefined)
      // Only the lock still carrying this attempt's token is this attempt's to remove: a takeover
      // that ran while this critical section was itself still inside its (generous) TTL leaves a
      // fresh lock behind under a different token, and releasing unconditionally would delete it
      // out from under its new, legitimate holder. A read that fails proves nothing either way —
      // it is not evidence the file is gone, only that this attempt could not confirm ownership —
      // so it is treated the same as a mismatch: leave the file alone rather than guess.
      const onDisk = await this.fs.readFile(this.paths.lockFile, 'utf8').catch(() => null)
      if (onDisk !== null && onDisk.trim() === token) {
        await this.fs.rm(this.paths.lockFile, { force: true }).catch(() => undefined)
      }
    }
  }

  private async acquire(): Promise<{ handle: { close(): Promise<void> }; token: string }> {
    await this.fs.mkdir(this.paths.root, { recursive: true })
    for (let attempt = 0; attempt < this.options.lockAttempts; attempt += 1) {
      const token = randomUUID()
      const handle = await this.fs.openExclusive(this.paths.lockFile).catch(() => null)
      if (handle !== null) {
        await this.fs.writeFile(this.paths.lockFile, token, { encoding: 'utf8' })
        return { handle, token }
      }
      // Somebody holds it, or somebody died holding it. Only one waiter at a time may decide which
      // and act on it — otherwise two waiters can both see the same expired lock, both delete it,
      // and both end up believing they hold it: the second one's delete lands *after* the first
      // has already recreated the file, taking the winner's brand new lock with it. Retry at once
      // only when a stale lock was actually cleared — a lock that is genuinely still held, or a
      // takeover another waiter is already deciding, waits its normal turn like any contention.
      if (await this.tryTakeoverStale()) continue
      await this.options.sleep(this.options.lockRetryMs)
    }
    throw busy()
  }

  /**
   * Decide, under a second exclusive-create file, whether the lock is stale enough to remove.
   * Serializing the decision itself (not just the removal) is what a bare `rm` cannot give: two
   * waiters that both read a 40-second-old lock and both act on that reading would both remove it,
   * however carefully the removal itself is written. Only the one holding this mutex reads and
   * acts, and it re-reads freshly, so a lock that became live again in the meantime is left alone.
   *
   * The mutex file is exactly as recoverable as the lock it protects: a waiter that dies holding
   * it — between creating it and its own `finally` removing it — would otherwise leave it behind
   * forever, and every later `openExclusive(mutexPath)` would fail permanently, taking the whole
   * store's stale-lock recovery down with it for good. `src/lock/instance-lock.ts`'s
   * `tryRecoverStale` faces the same problem for its own takeover mutex and solves it the same
   * way: when creating the mutex fails, check its own age, and remove it if it is older than
   * `TAKEOVER_MUTEX_TTL_MS` — generous enough that it is never mistaken for one a live waiter is
   * still using (a takeover only ever holds it for one stat and one rm).
   *
   * Returns whether a stale lock was actually cleared — not merely whether this call got to look.
   * `acquire` retries at once only on `true`; otherwise it is genuine contention with a live
   * holder, and the ordinary backoff applies, the same as losing the race for the lock itself.
   */
  private async tryTakeoverStale(): Promise<boolean> {
    const mutexPath = `${this.paths.lockFile}.takeover`
    const mutex = await this.fs.openExclusive(mutexPath).catch(async () => {
      const age = await this.ageOf(mutexPath)
      if (age !== null && age > TAKEOVER_MUTEX_TTL_MS) {
        await this.fs.rm(mutexPath, { force: true }).catch(() => undefined)
      }
      return null
    })
    if (mutex === null) return false // another waiter is deciding, or just cleaned up an orphan
    try {
      const age = await this.ageOf(this.paths.lockFile)
      if (age === null || age <= this.options.lockTtlMs) return false
      await this.fs.rm(this.paths.lockFile, { force: true }).catch(() => undefined)
      return true
    } finally {
      await mutex.close().catch(() => undefined)
      await this.fs.rm(mutexPath, { force: true }).catch(() => undefined)
    }
  }

  private async ageOf(path: string): Promise<number | null> {
    try {
      const info = await this.fs.stat(path)
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
