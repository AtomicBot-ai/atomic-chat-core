/**
 * One core owner per data folder (PLAN.md §3.4, §3.6).
 *
 * `<data>/atomic-core/instance.lock` is created exclusively (`open` with `wx`); its record carries
 * the owner's PID *and* start identity, so a client can tell a live owner from a recycled PID. The
 * record is written twice: `starting` when the lock is taken and `ready` once the control listener
 * is bound, so a client never dials a port that is not listening yet.
 *
 * Recovering a stale lock is itself serialised through a second exclusive file, otherwise two
 * clients that start together both decide the lock is stale and both become owner. A lock whose
 * owner is alive — or whose liveness cannot be disproven — is never taken over.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import { AtomicCoreError, CONTROL_PROTOCOL_VERSION } from '../contracts/index.js'
import type { DataLayout } from '../config/index.js'
import { CORE_VERSION } from '../version.js'
import {
  identityPermitsTakeover,
  processStartEpoch,
  processStartId,
  verifyProcessIdentity,
} from './process-identity.js'
import type { IdentityDeps, IdentityVerdict } from './process-identity.js'

export interface LockRecord {
  instance_id: string
  owner_scope?: 'app' | 'cli' | undefined
  pid: number
  process_start_id: string | null
  owner_started_at?: string | null
  protocol: number
  version: string
  /** Canonical data folder: the lock's scope, so two paths to the same folder collide as they should. */
  data_folder: string
  control_host: string
  control_port: number
  state: 'starting' | 'ready'
  acquired_at: string
}

export type LockState =
  | { kind: 'free' }
  | { kind: 'owned'; record: LockRecord; verdict: Extract<IdentityVerdict, 'match' | 'unknown'> }
  | { kind: 'stale'; record: LockRecord; verdict: Extract<IdentityVerdict, 'dead' | 'mismatch'> }
  | { kind: 'corrupt' }

/** How long a torn or unreadable lock is re-read before it counts as corrupt. */
export const CORRUPT_LOCK_GRACE_MS = 500
/** A takeover mutex older than this belonged to a process that died mid-recovery. */
export const TAKEOVER_MUTEX_TTL_MS = 30_000
export const TAKEOVER_ATTEMPTS = 20
export const TAKEOVER_RETRY_MS = 50

export interface LockDeps extends IdentityDeps {
  ownerScope?: 'app' | 'cli'
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Own start identity; injected in tests. */
  selfStartId?: () => Promise<string | undefined>
}

const defaultSleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const isEnoent = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT'
const isEexist = (e: unknown) => (e as NodeJS.ErrnoException).code === 'EEXIST'

/** Resolve symlinks so `/tmp/x` and `/private/tmp/x` are one scope; unresolvable paths stay as given. */
export async function canonicalDataFolder(root: string): Promise<string> {
  return realpath(root).catch(() => root)
}

/**
 * Read the record. A record being written at this instant parses as garbage, so an unreadable file
 * is re-read for `CORRUPT_LOCK_GRACE_MS` before the caller is told it is corrupt.
 */
export async function readLockRecord(
  path: string,
  deps: LockDeps = {}
): Promise<LockRecord | undefined | 'corrupt'> {
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const deadline = now() + CORRUPT_LOCK_GRACE_MS
  for (;;) {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (e) {
      if (isEnoent(e)) return undefined
      throw new AtomicCoreError('IO_ERROR', `Cannot read the instance lock at ${path}`, (e as Error).message)
    }
    const parsed = parseLockRecord(text)
    if (parsed) return parsed
    if (now() >= deadline) return 'corrupt'
    await sleep(25)
  }
}

export function parseLockRecord(text: string): LockRecord | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r['instance_id'] !== 'string' || typeof r['pid'] !== 'number') return undefined
  return {
    instance_id: r['instance_id'],
    owner_scope: r['owner_scope'] === 'app' || r['owner_scope'] === 'cli' ? r['owner_scope'] : undefined,
    pid: r['pid'],
    process_start_id: typeof r['process_start_id'] === 'string' ? r['process_start_id'] : null,
    owner_started_at: typeof r['owner_started_at'] === 'string' ? r['owner_started_at'] : null,
    protocol: typeof r['protocol'] === 'number' ? r['protocol'] : 0,
    version: typeof r['version'] === 'string' ? r['version'] : '',
    data_folder: typeof r['data_folder'] === 'string' ? r['data_folder'] : '',
    control_host: typeof r['control_host'] === 'string' ? r['control_host'] : '',
    control_port: typeof r['control_port'] === 'number' ? r['control_port'] : 0,
    state: r['state'] === 'ready' ? 'ready' : 'starting',
    acquired_at: typeof r['acquired_at'] === 'string' ? r['acquired_at'] : '',
  }
}

export async function inspectLock(layout: DataLayout, deps: LockDeps = {}): Promise<LockState> {
  const record = await readLockRecord(layout.core.instanceLock, deps)
  if (record === undefined) return { kind: 'free' }
  if (record === 'corrupt') return { kind: 'corrupt' }
  const verdict = await verifyProcessIdentity(record.pid, record.process_start_id, deps)
  return identityPermitsTakeover(verdict)
    ? { kind: 'stale', record, verdict: verdict as 'dead' | 'mismatch' }
    : { kind: 'owned', record, verdict: verdict as 'match' | 'unknown' }
}

export class InstanceLock {
  private constructor(
    private readonly handle: FileHandle,
    private readonly path: string,
    private current: LockRecord,
    private readonly deps: LockDeps
  ) {}

  get record(): LockRecord {
    return { ...this.current }
  }

  get instanceId(): string {
    return this.current.instance_id
  }

  /**
   * Become the owner, or fail with `CORE_ALREADY_RUNNING` describing who holds it. A stale lock is
   * recovered under a mutex so concurrent starters produce exactly one owner.
   */
  static async acquire(layout: DataLayout, deps: LockDeps = {}): Promise<InstanceLock> {
    const sleep = deps.sleep ?? defaultSleep
    const path = layout.core.instanceLock
    await mkdir(layout.core.dir, { recursive: true })
    const dataFolder = await canonicalDataFolder(layout.root)
    // Two probes of the same process; on Windows each is a PowerShell start, so they run together.
    const [selfId, ownerStartedAt] = await Promise.all([
      deps.selfStartId ? deps.selfStartId() : processStartId(process.pid, deps),
      processStartEpoch(process.pid, deps),
    ])

    for (let attempt = 0; attempt < TAKEOVER_ATTEMPTS; attempt++) {
      const handle = await open(path, 'wx').catch((e: unknown) => {
        if (isEexist(e)) return undefined
        throw new AtomicCoreError(
          'IO_ERROR',
          `Cannot create the instance lock at ${path}`,
          (e as Error).message
        )
      })
      if (handle) {
        const record: LockRecord = {
          instance_id: randomUUID(),
          owner_scope: deps.ownerScope ?? 'cli',
          pid: process.pid,
          process_start_id: selfId ?? null,
          owner_started_at: ownerStartedAt ?? null,
          protocol: CONTROL_PROTOCOL_VERSION,
          version: CORE_VERSION,
          data_folder: dataFolder,
          control_host: '',
          control_port: 0,
          state: 'starting',
          acquired_at: new Date().toISOString(),
        }
        await writeRecord(handle, record).catch(async (e: unknown) => {
          await handle.close().catch(() => {})
          await rm(path, { force: true }).catch(() => {})
          throw e
        })
        return new InstanceLock(handle, path, record, deps)
      }

      const state = await inspectLock(layout, deps)
      if (state.kind === 'owned') throw alreadyRunning(state.record, state.verdict)
      if (state.kind === 'free') continue // the holder released between our attempts
      // stale or corrupt: recover, but only one starter at a time
      const recovered = await tryRecoverStale(layout, deps)
      if (!recovered) await sleep(TAKEOVER_RETRY_MS)
    }
    throw new AtomicCoreError(
      'CORE_START_FAILED',
      'Could not acquire the core instance lock.',
      `${path} kept changing hands across ${TAKEOVER_ATTEMPTS} attempts`
    )
  }

  /** Announce the bound control listener. Until this lands, clients see `state: "starting"`. */
  async publish(controlHost: string, controlPort: number): Promise<void> {
    this.current = { ...this.current, control_host: controlHost, control_port: controlPort, state: 'ready' }
    await writeRecord(this.handle, this.current)
  }

  /** Release only what is still ours: a lock taken over by someone else is left alone. */
  async release(): Promise<void> {
    await this.handle.close().catch(() => {})
    const onDisk = await readLockRecord(this.path, this.deps).catch(() => undefined)
    if (onDisk && onDisk !== 'corrupt' && onDisk.instance_id !== this.current.instance_id) return
    await rm(this.path, { force: true }).catch(() => {})
  }
}

async function writeRecord(handle: FileHandle, record: LockRecord): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
  await handle.truncate(0)
  await handle.write(bytes, 0, bytes.length, 0)
  await handle.sync().catch(() => {})
}

export function alreadyRunning(record: LockRecord, verdict: 'match' | 'unknown'): AtomicCoreError {
  const where = record.control_port ? `${record.control_host}:${record.control_port}` : 'not yet published'
  const proof = verdict === 'match' ? 'confirmed' : 'could not be disproven'
  return new AtomicCoreError(
    'CORE_ALREADY_RUNNING',
    'Another Atomic Chat core already owns this data folder.',
    `pid ${record.pid} (${proof}), instance ${record.instance_id}, control ${where}`
  )
}

/** Returns true when this caller performed the recovery; false when someone else is doing it. */
async function tryRecoverStale(layout: DataLayout, deps: LockDeps): Promise<boolean> {
  const now = deps.now ?? Date.now
  const mutexPath = `${layout.core.instanceLock}.takeover`
  const mutex = await open(mutexPath, 'wx').catch(async (e: unknown) => {
    if (!isEexist(e))
      throw new AtomicCoreError('IO_ERROR', `Cannot create ${mutexPath}`, (e as Error).message)
    const age = await stat(mutexPath).then(
      (s) => now() - s.mtimeMs,
      () => 0
    )
    if (age > TAKEOVER_MUTEX_TTL_MS) await rm(mutexPath, { force: true }).catch(() => {})
    return undefined
  })
  if (!mutex) return false
  try {
    await mutex.write(Buffer.from(`${process.pid}\n`))
    // Re-check under the mutex: the previous reader's verdict may be out of date.
    const state = await inspectLock(layout, deps)
    if (state.kind === 'owned') throw alreadyRunning(state.record, state.verdict)
    if (state.kind === 'stale' || state.kind === 'corrupt') {
      await rm(layout.core.instanceLock, { force: true })
    }
    return true
  } finally {
    await mutex.close().catch(() => {})
    await rm(mutexPath, { force: true }).catch(() => {})
  }
}

export interface WaitForOwnerOptions extends LockDeps {
  timeoutMs?: number
  pollMs?: number
}

/**
 * Wait until an owner publishes its control endpoint. Used by a client that just launched a core:
 * it must not dial before the listener is bound, and must give up when the launched process dies.
 */
export async function waitForPublishedOwner(
  layout: DataLayout,
  options: WaitForOwnerOptions = {}
): Promise<LockRecord> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const deadline = now() + (options.timeoutMs ?? 15_000)
  for (;;) {
    const state = await inspectLock(layout, options)
    if (state.kind === 'owned' && state.record.state === 'ready') return state.record
    if (now() >= deadline) {
      const detail =
        state.kind === 'owned'
          ? `owner pid ${state.record.pid} did not publish a control port in time`
          : `no live owner appeared (${state.kind})`
      throw new AtomicCoreError('CORE_START_FAILED', 'The Atomic Chat core did not become ready.', detail)
    }
    await sleep(options.pollMs ?? 25)
  }
}
