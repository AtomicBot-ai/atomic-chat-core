import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { BeginOperation, ManagedHostReceipt, Sha256Digest } from '../../contracts/index.js'
import { managedSharedPaths } from '../../config/index.js'
import { TAKEOVER_MUTEX_TTL_MS } from '../../lock/index.js'
import { FakeManagedFs } from '../../../test/helpers/managed-store-fs.js'
import {
  classifyReceipt,
  operationFileName,
  withReceipt,
  OperationStore,
  type OwnerIdentity,
} from './store.js'

const ROOT = '/shared'
const PATHS = managedSharedPaths(ROOT)

/** A fake identity, fast and deterministic — nothing here needs a real pid or a real OS probe. */
const fakeOwnerIdentity =
  (pid = 4242, startId: string | null = 'test:owner'): (() => Promise<OwnerIdentity>) =>
  async () => ({ pid, startId })

/**
 * Pauses whoever calls `hold()` until the test calls `releaseOne`/`releaseAll` — lets a test force
 * a specific interleaving between two concurrent callers instead of hoping `Promise.all` happens
 * to schedule them the way a real race would. Two contenders that are each individually correct
 * can still race unsafely only at the exact instant both have looked and neither has acted yet;
 * without a gate, that window is microseconds wide and not reliably hit by chance.
 */
class CallGate {
  private waiters: Array<() => void> = []
  /** Once tripped, every future `hold()` resolves at once: a one-shot barrier, not a permanent
   *  checkpoint — a retry loop that calls the gated method again after the forced interleaving is
   *  over must not queue up behind a gate nothing will ever release again. */
  private armed = true

  /** Total callers ever queued, monotonic — unlike `waiters.length`, this does not drop back down
   *  once a held caller is released, so a *later* call (e.g. a retry loop's second attempt at the
   *  same gated method) is never queued a second time just because the queue happened to be empty
   *  again. */
  private seen = 0

  /** At most this many callers are ever made to wait; anyone past that count runs straight
   *  through, unheld — the one way to hold exactly one contender back while letting a second
   *  (later) caller through immediately to create the exact window the first is then released
   *  into. Unlimited by default: the common case is "hold everyone until I say go". */
  constructor(private readonly holdCount: number = Number.POSITIVE_INFINITY) {}

  get waiting(): number {
    return this.waiters.length
  }
  hold(): Promise<void> {
    if (!this.armed || this.seen >= this.holdCount) return Promise.resolve()
    this.seen += 1
    return new Promise((resolve) => this.waiters.push(resolve))
  }
  releaseOne(): void {
    this.waiters.shift()?.()
  }
  releaseAll(): void {
    this.armed = false
    while (this.waiters.length > 0) this.releaseOne()
  }
}

/** Poll `gate.waiting` up to `attempts` macrotask ticks, for however many contenders actually get
 *  there — a fix that serializes contenders means only one of them ever will, and this must not
 *  hang waiting for a second that structurally cannot arrive. */
const waitForGate = async (gate: CallGate, count: number, attempts = 200): Promise<void> => {
  for (let i = 0; i < attempts && gate.waiting < count; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** Poll an arbitrary condition up to `attempts` macrotask ticks — a bounded wait for something
 *  that may or may not ever become true, without hanging the test if it does not. */
const waitUntil = async (condition: () => boolean, attempts = 200): Promise<void> => {
  for (let i = 0; i < attempts && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/**
 * Pauses `stat` on `statPath` (governed by `statGate`, if given) and/or every `readdir` (governed
 * by `readdirGate`, if given) — the two checkpoints a test needs to force a specific interleaving
 * between two contenders: `stat` is "I have just read this lock's age, before acting on it";
 * `readdir` is "I am deep inside my own critical section, lock genuinely held, business logic not
 * yet done".
 */
class GatedFs extends FakeManagedFs {
  /** Every `readdir` call, paused or not — a plain tally, so a test can wait for a second caller
   *  to have at least *looked*, even where pausing it would (by winning-or-losing whichever race
   *  it is currently in) change what there was to see. */
  readdirCalls = 0

  constructor(
    private readonly rmGate: CallGate | undefined,
    private readonly rmPath: string | undefined,
    private readonly readdirGate: CallGate | undefined,
    private readonly writeTmpGate: CallGate | undefined = undefined
  ) {
    super()
  }
  override async rm(path: string): Promise<void> {
    if (this.rmGate && path === this.rmPath) await this.rmGate.hold()
    return super.rm(path)
  }
  override async readdir(path: string): Promise<string[]> {
    this.readdirCalls += 1
    if (this.readdirGate) await this.readdirGate.hold()
    return super.readdir(path)
  }
  override async writeFile(path: string, data: string): Promise<void> {
    // `.tmp` is specific to `write()`'s first step (staging an operation record) — never the lock
    // file itself, which `writeFile`s its token under a plain, unsuffixed path.
    if (this.writeTmpGate && path.endsWith('.tmp')) await this.writeTmpGate.hold()
    return super.writeFile(path, data)
  }
}

const store = (
  fs: FakeManagedFs,
  over: {
    instanceId?: string
    serial?: string
    ownerIdentity?: () => Promise<OwnerIdentity>
    lockAttempts?: number
    sleep?: (ms: number) => Promise<void>
  } = {}
): OperationStore => {
  let n = 0
  const tag = over.serial ?? 'a'
  return new OperationStore({
    root: ROOT,
    instanceId: over.instanceId ?? 'core-1',
    newOperationId: () => `op-${tag}-${(n += 1)}`,
    newEffectId: () => `effect-${tag}-${n}`,
    fs,
    now: () => fs.clock,
    sleep: over.sleep ?? (async () => undefined),
    lockAttempts: over.lockAttempts ?? 5,
    ownerIdentity: over.ownerIdentity ?? fakeOwnerIdentity(),
  })
}

const begin = (over: Partial<BeginOperation> = {}): BeginOperation => ({
  request_id: 'req-1',
  target: { kind: 'runtime', installation_id: 'inst-1', engine_id: 'tensorrt-llm' },
  kind: 'setup',
  descriptor_id: 'trtllm-1.3.0rc27',
  ...over,
})

const DIGEST_A = `sha256:${'a'.repeat(64)}` as Sha256Digest
const DIGEST_B = `sha256:${'b'.repeat(64)}` as Sha256Digest

const receipt = (over: Partial<ManagedHostReceipt> = {}): ManagedHostReceipt => ({
  step_id: 'step-1',
  nonce: 'once-1',
  expected_operation_revision: 1,
  recipe_digest: DIGEST_A,
  parameters_digest: DIGEST_B,
  outcome: 'completed',
  receipt_id: 'receipt-1',
  ...over,
})

describe('starting an operation once (OP01)', () => {
  it('hands a retried request the operation it already started, without a second effect', async () => {
    const fs = new FakeManagedFs()
    const s = store(fs)

    const first = await s.createOrGet('env-1', begin(), DIGEST_A)
    const again = await s.createOrGet('env-1', begin(), DIGEST_A)

    expect(first.created).toBe(true)
    expect(again.created).toBe(false)
    expect(again.record.machine.operation.operation_id).toBe(first.record.machine.operation.operation_id)
    // One operation on disk, and the effect intent is the one the first call issued.
    expect(await s.listRecoverable()).toHaveLength(1)
    expect(again.record.machine.pending_effect?.effect_id).toBe(
      first.record.machine.pending_effect?.effect_id
    )
  })

  it('refuses the same request id carrying a different install, and writes nothing', async () => {
    const fs = new FakeManagedFs()
    const s = store(fs)
    await s.createOrGet('env-1', begin(), DIGEST_A)
    const before = new Map(fs.files)

    await expect(s.createOrGet('env-1', begin({ descriptor_id: 'trtllm-1.4.0' }), DIGEST_B)).rejects.toThrow(
      AtomicCoreError
    )
    expect(fs.files).toEqual(before)
  })

  it('refuses a second change to an environment that is still busy', async () => {
    const fs = new FakeManagedFs()
    const s = store(fs)
    await s.createOrGet('env-1', begin(), DIGEST_A)
    await expect(s.createOrGet('env-1', begin({ request_id: 'req-2' }), DIGEST_B)).rejects.toThrow(
      /still running/
    )
  })
})

describe('owner identity (findings 1/2)', () => {
  it('stamps every write with this store’s own identity, never the caller’s', async () => {
    const fs = new FakeManagedFs()
    const s = store(fs, { ownerIdentity: fakeOwnerIdentity(4242, 'test:owner') })
    const { record } = await s.createOrGet('env-1', begin(), DIGEST_A)
    expect(record.owner_pid).toBe(4242)
    expect(record.owner_process_start_id).toBe('test:owner')

    // A later write re-stamps the *current* store's identity, not whatever the caller's in-memory
    // copy happened to carry — this is what lets a reader tell who last touched a record.
    const other = store(fs, { ownerIdentity: fakeOwnerIdentity(9999, 'test:other') })
    const id = record.machine.operation.operation_id
    await other.compareAndSwap(id, 0, {
      ...record,
      owner_pid: 1, // a stale/forged value from the caller's side must not survive the write
      owner_process_start_id: 'forged',
      machine: {
        ...record.machine,
        operation: { ...record.machine.operation, revision: 1, phase: 'awaiting-consent' as const },
      },
    })
    const after = await s.read(id)
    expect(after?.owner_pid).toBe(9999)
    expect(after?.owner_process_start_id).toBe('test:other')
  })

  it('reads an old record with no recorded owner as unrecorded, not as a parse failure', async () => {
    const fs = new FakeManagedFs()
    const s = store(fs)
    const { record } = await s.createOrGet('env-1', begin(), DIGEST_A)
    const id = record.machine.operation.operation_id
    const path = PATHS.operationFile(id)
    const onDisk = JSON.parse(fs.files.get(path) as string) as Record<string, unknown>
    delete onDisk['owner_pid']
    delete onDisk['owner_process_start_id']
    fs.files.set(path, JSON.stringify(onDisk))

    const read = await s.read(id)
    expect(read?.owner_pid).toBeNull()
    expect(read?.owner_process_start_id).toBeNull()
  })
})

describe('two cores on one environment', () => {
  it('lets only one of them create the operation, and the other finds it', async () => {
    const fs = new FakeManagedFs()
    const app = store(fs, { instanceId: 'core-app', serial: 'app' })
    const cli = store(fs, { instanceId: 'core-cli', serial: 'cli' })

    const [one, other] = await Promise.all([
      app.createOrGet('env-1', begin(), DIGEST_A),
      cli.createOrGet('env-1', begin(), DIGEST_A),
    ])

    expect([one.created, other.created].filter(Boolean)).toHaveLength(1)
    expect(one.record.machine.operation.operation_id).toBe(other.record.machine.operation.operation_id)
    expect(await app.listRecoverable()).toHaveLength(1)
  })

  it('releases the lock even when the work inside it fails', async () => {
    const fs = new FakeManagedFs()
    const s = store(fs)
    await s.createOrGet('env-1', begin(), DIGEST_A)
    await expect(s.createOrGet('env-1', begin({ request_id: 'req-2' }), DIGEST_B)).rejects.toThrow()
    // The next caller is not locked out by the one that threw.
    expect(fs.files.has(PATHS.lockFile)).toBe(false)
    expect((await s.createOrGet('env-1', begin(), DIGEST_A)).created).toBe(false)
  })

  it('breaks a lock left behind by a process that died holding it', async () => {
    const fs = new FakeManagedFs()
    await fs.openExclusive(PATHS.lockFile)
    fs.clock += 60_000

    const s = store(fs)
    const created = await s.createOrGet('env-1', begin(), DIGEST_A)
    expect(created.created).toBe(true)
  })

  it('recovers a lock whose own takeover mutex was abandoned by a process that died deciding', async () => {
    // Not just the main lock but the second, `.takeover` mutex that serializes deciding whether to
    // break it can itself be left behind by a process that died holding it — between creating the
    // mutex and its own `finally` removing it. Without recovering the mutex too, every later
    // `openExclusive` on it fails forever, taking this store's entire stale-lock recovery down
    // with it: the same problem `src/lock/instance-lock.ts`'s `tryRecoverStale` already solves for
    // its own takeover mutex, `TAKEOVER_MUTEX_TTL_MS` reused here unchanged.
    const fs = new FakeManagedFs()
    await fs.openExclusive(PATHS.lockFile)
    fs.clock += 60_000 // the main lock: stale by the store's own (shorter) lockTtlMs
    await fs.openExclusive(`${PATHS.lockFile}.takeover`)
    fs.clock += TAKEOVER_MUTEX_TTL_MS + 10_000 // the mutex: now stale by its own (longer) ttl too

    const s = store(fs)
    const created = await s.createOrGet('env-1', begin(), DIGEST_A)
    expect(created.created).toBe(true)
    expect(fs.files.has(`${PATHS.lockFile}.takeover`)).toBe(false)
  })

  it('backs off rather than break in while another waiter’s takeover mutex is still fresh', async () => {
    const fs = new FakeManagedFs()
    await fs.openExclusive(PATHS.lockFile)
    fs.clock += 60_000 // the main lock: stale
    await fs.openExclusive(`${PATHS.lockFile}.takeover`) // a fresh mutex: another waiter deciding now

    const s = store(fs, { lockAttempts: 3 })
    await expect(s.createOrGet('env-1', begin(), DIGEST_A)).rejects.toThrow(/another atomic chat process/i)
    // Backed off, not broke in: the still-fresh mutex, and the main lock it is deciding about, are
    // exactly as the other waiter left them — not stepped on by an impatient contender that gave up
    // waiting and just took them anyway.
    expect(fs.files.has(`${PATHS.lockFile}.takeover`)).toBe(true)
    expect(fs.files.has(PATHS.lockFile)).toBe(true)
  })

  it('lets only one of two contenders recover a lock left behind by a dead process', async () => {
    const fs = new FakeManagedFs()
    await fs.openExclusive(PATHS.lockFile)
    fs.clock += 60_000 // old enough that both contenders read it as abandoned

    const app = store(fs, { instanceId: 'core-app', serial: 'app' })
    const cli = store(fs, { instanceId: 'core-cli', serial: 'cli' })

    const [one, other] = await Promise.all([
      app.createOrGet('env-1', begin(), DIGEST_A),
      cli.createOrGet('env-1', begin(), DIGEST_A),
    ])

    // Whichever of the two actually created it, there is exactly one operation and the lock ends
    // up released — not a second contender's takeover deleting the first's freshly-acquired lock
    // and both believing they hold it.
    expect(one.record.machine.operation.operation_id).toBe(other.record.machine.operation.operation_id)
    expect(await app.listRecoverable()).toHaveLength(1)
    expect(fs.files.has(PATHS.lockFile)).toBe(false)
    expect(fs.files.has(`${PATHS.lockFile}.takeover`)).toBe(false)
  })

  it('forces the exact TOCTOU window: B decides stale, A takes over and starts writing, then B deletes', async () => {
    // The natural interleaving of two `Promise.all`-launched calls against an all-microtask fake
    // filesystem does not reliably reproduce the harmful window on its own — nor does merely
    // forcing both contenders to *read* the lock's age together (a contender that finishes cleanly
    // before the other ever acts leaves nothing to damage; and pausing *inside* `stat` itself would
    // only ever hand a paused caller today's freshly-recreated mtime on resume, never the stale
    // value it meant to act on). The real danger needs three things true at once: B has *already*
    // correctly read the lock as stale (an ordinary, unpaused `stat`) and is paused only right
    // before it *acts* on that reading; A has since taken the same stale lock over, created its own
    // fresh one, found nothing conflicting, and is paused only right before it *commits* its own
    // operation record; and B's paused delete is released first, then B is left to run all the way
    // to its own successful, independent write before A's paused write is released to do the same.
    //   1. `rmGate` (`holdCount: 1`) holds only B's very first `rm` of the lock file — the delete
    //      it decided on from an honest stale reading — never A's own later `rm` of the same path
    //      (or either side's ordinary end-of-attempt cleanup).
    //   2. `writeTmpGate` (`holdCount: 1`) holds only A's very first write of a staged operation
    //      record (`*.tmp`) — after it has taken the lock over and found nothing conflicting, right
    //      before it would actually commit.
    const rmGate = new CallGate(1)
    const writeTmpGate = new CallGate(1)
    const fs = new GatedFs(rmGate, PATHS.lockFile, undefined, writeTmpGate)
    await fs.openExclusive(PATHS.lockFile)
    fs.clock += 60_000

    // A real (if short) `setTimeout` `sleep`, not a no-op: a fix that serializes the stale-or-not
    // decision (the takeover mutex) can leave the losing side of that decision retrying for a
    // while, and a no-op `sleep` resolves as a microtask, which Node drains completely before
    // running a single `setTimeout` callback — the polling waits below would never get a turn.
    const retrySleep = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
    const app = store(fs, { instanceId: 'core-app', serial: 'app', lockAttempts: 5_000, sleep: retrySleep })
    const cli = store(fs, { instanceId: 'core-cli', serial: 'cli', lockAttempts: 5_000, sleep: retrySleep })

    // Different request ids: with the same one, `createOrGet`'s own idempotency check ("a retried
    // request gets the operation it already started") would mask exactly the bug this test exists
    // to catch, by quietly handing the loser the winner's record instead of writing its own.
    const bPromise = cli.createOrGet('env-1', begin({ request_id: 'req-b' }), DIGEST_A)
    await waitForGate(rmGate, 1)
    expect(rmGate.waiting).toBe(1) // B: decided stale from an honest reading, paused before deleting

    const aPromise = app.createOrGet('env-1', begin({ request_id: 'req-a' }), DIGEST_A)
    await waitForGate(writeTmpGate, 1)
    // A fix that serializes the stale-or-not decision may never let A take the lock over at all
    // while B is still deciding — there is nothing to force in that case, and the releases below
    // simply do nothing, same as an ordinary, uncontested run.
    const readdirsBeforeRelease = fs.readdirCalls // A's own look already happened, finding nothing

    // Release B's delete, then — this is the part that actually matters — wait for B to have
    // looked at what exists *itself* (its own `all()`, once it has retried and reacquired) before
    // letting A's paused write land. Without this wait, A's own (much shorter) remaining path to
    // "done" reliably wins the race regardless of who woke up first, and B's later look always
    // finds A's record already there — which is a correct refusal, not the bug this test exists to
    // catch: the danger is specifically two lookers who *each* saw nothing.
    rmGate.releaseAll() // B acts on its stale reading — by now, A's fresh, in-use lock
    await waitUntil(() => fs.readdirCalls > readdirsBeforeRelease)
    writeTmpGate.releaseAll() // only now does whoever is paused here proceed

    const settled = await Promise.allSettled([aPromise, bPromise])
    // Never two operations for one environment: whichever contender actually wins must leave the
    // other refused with a conflict, not each believing itself the exclusive owner and each
    // committing its own independent record.
    const created = settled.filter((result) => result.status === 'fulfilled')
    expect(created).toHaveLength(1)
    for (const result of settled) {
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(AtomicCoreError)
    }
    expect(await app.listRecoverable()).toHaveLength(1)
  })

  it("does not delete a takeover that landed while this holder's own work was still running", async () => {
    // Fully deterministic, no interleaving to hope for: hold a real holder deep inside its own
    // critical section (lock acquired, business logic paused mid-flight), simulate — by editing
    // the fake disk directly — exactly what a second core's takeover would have left behind, and
    // prove the first holder's own release does not touch it.
    const gate = new CallGate()
    const fs = new GatedFs(undefined, undefined, gate)
    const s = store(fs, { instanceId: 'core-app' })

    const holding = s.createOrGet('env-1', begin(), DIGEST_A)
    await waitForGate(gate, 1)
    expect(gate.waiting).toBe(1)
    expect(fs.files.has(PATHS.lockFile)).toBe(true) // genuinely held, not merely about to be

    // A second core decided (by the TTL heuristic) that this lock was abandoned — wrongly: the
    // first holder is merely slow, not dead — and took it over under its own token.
    await fs.rm(PATHS.lockFile)
    await fs.writeFile(PATHS.lockFile, 'someone-elses-token')

    gate.releaseAll()
    await holding

    // Only a release that finds its own token still there may remove it; this one must not have.
    expect(fs.files.get(PATHS.lockFile)).toBe('someone-elses-token')
  })

  it('gives up rather than writing while somebody else is still holding the lock', async () => {
    const fs = new FakeManagedFs()
    await fs.openExclusive(PATHS.lockFile)
    // Fresh lock: the holder is alive, so waiting is the only correct answer.
    const s = store(fs)
    await expect(s.createOrGet('env-1', begin(), DIGEST_A)).rejects.toThrow(/another atomic chat process/i)
    expect(await s.listRecoverable()).toHaveLength(0)
  })

  it('paces itself between attempts on a lock that is genuinely held, rather than spinning', async () => {
    const fs = new FakeManagedFs()
    await fs.openExclusive(PATHS.lockFile) // fresh: never stale, never clears on its own
    let sleeps = 0
    const s = new OperationStore({
      root: ROOT,
      instanceId: 'core-1',
      newOperationId: () => 'op-1',
      newEffectId: () => 'effect-1',
      fs,
      now: () => fs.clock,
      sleep: async () => {
        sleeps += 1
      },
      lockAttempts: 5,
      ownerIdentity: fakeOwnerIdentity(),
    })

    await expect(s.createOrGet('env-1', begin(), DIGEST_A)).rejects.toThrow(AtomicCoreError)
    // Every attempt against a lock that is neither won nor found stale backs off once: a takeover
    // decision that correctly found nothing to clear must not read as "retry immediately", or a
    // busy lock turns every wait into a tight loop instead of the deliberate one `lockRetryMs` sets.
    expect(sleeps).toBe(5)
  })
})

describe('what an operation created is recorded at once, and never forgotten (review r2, item B)', () => {
  it('records a resource without moving the revision, and a commit from an older read keeps it', async () => {
    const fs = new FakeManagedFs()
    const s = store(fs)
    const { record } = await s.createOrGet('env-1', begin(), DIGEST_A)
    const id = record.machine.operation.operation_id

    await s.recordOwned(id, ['image:probe@sha256:1'])
    await s.recordOwned(id, ['image:probe@sha256:1'])
    const read = await s.read(id)
    expect(read?.owned_resource_ids).toEqual(['image:probe@sha256:1'])
    expect(read?.machine.operation.revision).toBe(0)

    // A transition computed from the read before the claim still lands, and the claim survives it.
    const moved = {
      ...record,
      machine: { ...record.machine, operation: { ...record.machine.operation, revision: 1 } },
    }
    expect(await s.compareAndSwap(id, 0, moved)).toBe(true)
    expect((await s.read(id))?.owned_resource_ids).toEqual(['image:probe@sha256:1'])
  })

  it('refuses to record for an operation that does not exist', async () => {
    const s = store(new FakeManagedFs())
    await expect(s.recordOwned('op-nobody', ['x'])).rejects.toMatchObject({
      code: 'MANAGED_OPERATION_NOT_FOUND',
    })
  })
})

describe('committing against a revision (OP08)', () => {
  it('refuses a commit computed from a state the operation has left, and writes nothing', async () => {
    const fs = new FakeManagedFs()
    const s = store(fs)
    const { record } = await s.createOrGet('env-1', begin(), DIGEST_A)
    const id = record.machine.operation.operation_id

    const moved = {
      ...record,
      machine: {
        ...record.machine,
        operation: { ...record.machine.operation, revision: 1, phase: 'awaiting-consent' as const },
      },
    }
    expect(await s.compareAndSwap(id, 0, moved)).toBe(true)

    const stale = {
      ...record,
      machine: {
        ...record.machine,
        operation: { ...record.machine.operation, revision: 1, phase: 'failed' as const },
      },
    }
    expect(await s.compareAndSwap(id, 0, stale)).toBe(false)
    expect((await s.read(id))?.machine.operation.phase).toBe('awaiting-consent')
  })

  it('answers false for an operation that does not exist rather than creating one', async () => {
    const fs = new FakeManagedFs()
    const s = store(fs)
    const { record } = await s.createOrGet('env-1', begin(), DIGEST_A)
    expect(await s.compareAndSwap('op-nobody', 0, record)).toBe(false)
    expect(await s.read('op-nobody')).toBeNull()
  })

  it('refuses to file one operation’s state under another’s name', async () => {
    const fs = new FakeManagedFs()
    const s = store(fs)
    const { record } = await s.createOrGet('env-1', begin(), DIGEST_A)
    const id = record.machine.operation.operation_id
    const foreign = {
      ...record,
      machine: {
        ...record.machine,
        operation: { ...record.machine.operation, operation_id: 'op-other' },
      },
    }
    await expect(s.compareAndSwap(id, 0, foreign)).rejects.toThrow(AtomicCoreError)
  })

  it('reads back the previous record when the newest write was torn', async () => {
    const fs = new FakeManagedFs()
    const s = store(fs)
    const { record } = await s.createOrGet('env-1', begin(), DIGEST_A)
    const id = record.machine.operation.operation_id
    await s.compareAndSwap(id, 0, {
      ...record,
      machine: {
        ...record.machine,
        operation: { ...record.machine.operation, revision: 1, phase: 'awaiting-consent' as const },
      },
    })

    // The power went out mid-rename: the newest file is half a JSON document.
    const path = PATHS.operationFile(id)
    fs.files.set(path, '{"machine":{"operation":{"operation')

    const recovered = await s.read(id)
    // A state this operation really was in, not an empty one that would claim it owns nothing.
    expect(recovered?.machine.operation.revision).toBe(0)
    expect(recovered?.request.request_id).toBe('req-1')
    expect(await s.listRecoverable()).toHaveLength(1)
  })

  it('fails closed when neither copy can be read, instead of reporting an empty operation', async () => {
    const fs = new FakeManagedFs()
    const s = store(fs)
    const { record } = await s.createOrGet('env-1', begin(), DIGEST_A)
    const id = record.machine.operation.operation_id
    await s.compareAndSwap(id, 0, record)

    const path = PATHS.operationFile(id)
    fs.files.set(path, 'not json')
    fs.files.set(`${path}.bak`, 'also not json')

    await expect(s.read(id)).rejects.toThrow(AtomicCoreError)
    await expect(s.listRecoverable()).rejects.toThrow(AtomicCoreError)
  })

  it('keeps the previous copy on every write, so there is always one to fall back to', async () => {
    const fs = new FakeManagedFs()
    const s = store(fs)
    const { record } = await s.createOrGet('env-1', begin(), DIGEST_A)
    const id = record.machine.operation.operation_id
    const path = PATHS.operationFile(id)
    await s.compareAndSwap(id, 0, record)

    expect(fs.files.has(`${path}.bak`)).toBe(true)
    // The new state arrives by rename, never by writing over the file that is being read.
    expect(fs.renames.some(([, to]: [string, string]) => to === path)).toBe(true)
    expect(fs.files.has(`${path}.tmp`)).toBe(false)
  })

  it('finds an operation whose newest write left only the backup copy on disk', async () => {
    const fs = new FakeManagedFs()
    const s = store(fs)
    const { record } = await s.createOrGet('env-1', begin(), DIGEST_A)
    const id = record.machine.operation.operation_id
    const path = PATHS.operationFile(id)
    await s.compareAndSwap(id, 0, {
      ...record,
      machine: {
        ...record.machine,
        operation: { ...record.machine.operation, revision: 1, phase: 'awaiting-consent' as const },
      },
    })
    expect(fs.files.has(`${path}.bak`)).toBe(true)

    // The crash lands between renaming the current file to `.bak` and renaming the new one into
    // place (`write`, in store.ts): `<id>.json` never reappears, only `<id>.json.bak` does.
    fs.files.delete(path)
    fs.mtimes.delete(path)

    // `read` already falls back to `.bak`; the directory scan behind `listRecoverable` and the
    // busy-check in `createOrGet` must see it too, or an abandoned operation becomes invisible to
    // both while a client keeps being told the environment is free.
    expect(await s.listRecoverable()).toHaveLength(1)
    await expect(s.createOrGet('env-1', begin({ request_id: 'req-2' }), DIGEST_B)).rejects.toThrow(
      /still running/
    )
  })

  it('leaves a finished operation out of what needs recovering', async () => {
    const fs = new FakeManagedFs()
    const s = store(fs)
    const { record } = await s.createOrGet('env-1', begin(), DIGEST_A)
    const id = record.machine.operation.operation_id
    await s.compareAndSwap(id, 0, {
      ...record,
      machine: {
        ...record.machine,
        operation: { ...record.machine.operation, revision: 1, phase: 'ready' as const },
      },
    })
    expect(await s.listRecoverable()).toHaveLength(0)
    // And the environment is free for the next change.
    expect((await s.createOrGet('env-1', begin({ request_id: 'req-2' }), DIGEST_B)).created).toBe(true)
  })
})

describe('receipts are used once (OP03)', () => {
  const base = {
    machine: {} as never,
    request_digest: DIGEST_A,
    request: begin(),
    requirement_plan: null,
    accepted_receipt_digests: {},
    completed_effect_ids: [],
    owned_resource_ids: [],
    owner_pid: null,
    owner_process_start_id: null,
  }

  it('accepts a receipt once and calls the identical one a duplicate', () => {
    expect(classifyReceipt(base, receipt())).toBe('fresh')
    const recorded = withReceipt(base, receipt())
    // A retry must not make the privileged step run a second time.
    expect(classifyReceipt(recorded, receipt())).toBe('duplicate')
  })

  it('refuses a different result for an authorization that was already spent', () => {
    const recorded = withReceipt(base, receipt())
    expect(() => classifyReceipt(recorded, receipt({ outcome: 'declined' }))).toThrow(AtomicCoreError)
    expect(() => classifyReceipt(recorded, receipt({ receipt_id: 'receipt-2' }))).toThrow(/already recorded/)
  })

  it('does not count the diagnostic log_tail in a receipt identity (task 2.23 review, minor 1)', () => {
    // The same receipt re-posted with another tail, or none, is the same receipt: a duplicate, never
    // "a different result" for the spent authorization.
    const recorded = withReceipt(base, receipt({ log_tail: 'docker-service failed: first read' }))
    expect(classifyReceipt(recorded, receipt())).toBe('duplicate')
    expect(classifyReceipt(recorded, receipt({ log_tail: 'docker-service failed: another read' }))).toBe(
      'duplicate'
    )
    // A receipt recorded before task 2.23 (no tail) keeps its digest.
    expect(withReceipt(base, receipt({ log_tail: 'x' })).accepted_receipt_digests).toEqual(
      withReceipt(base, receipt()).accepted_receipt_digests
    )
  })

  it('treats a receipt for another authorization as new, not as a replay', () => {
    const recorded = withReceipt(base, receipt())
    expect(classifyReceipt(recorded, receipt({ nonce: 'once-2' }))).toBe('fresh')
  })
})

describe('operationFileName', () => {
  it('names one JSON file per operation, with an id that could not climb out of the folder', () => {
    expect(operationFileName('op-1')).toMatch(/\.json$/)
    expect(operationFileName('../escape/op')).not.toMatch(/[\\/]/)
  })
})
