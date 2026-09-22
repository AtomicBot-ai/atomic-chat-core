import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { BeginOperation, ManagedHostReceipt, Sha256Digest } from '../../contracts/index.js'
import { managedSharedPaths } from '../../config/index.js'
import { FakeManagedFs } from '../../../test/helpers/managed-store-fs.js'
import { classifyReceipt, withReceipt, OperationStore } from './store.js'

const ROOT = '/shared'
const PATHS = managedSharedPaths(ROOT)

const store = (fs: FakeManagedFs, over: { instanceId?: string; serial?: string } = {}): OperationStore => {
  let n = 0
  const tag = over.serial ?? 'a'
  return new OperationStore({
    root: ROOT,
    instanceId: over.instanceId ?? 'core-1',
    newOperationId: () => `op-${tag}-${(n += 1)}`,
    newEffectId: () => `effect-${tag}-${n}`,
    fs,
    now: () => fs.clock,
    sleep: async () => undefined,
    lockAttempts: 5,
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

  it('gives up rather than writing while somebody else is still holding the lock', async () => {
    const fs = new FakeManagedFs()
    await fs.openExclusive(PATHS.lockFile)
    // Fresh lock: the holder is alive, so waiting is the only correct answer.
    const s = store(fs)
    await expect(s.createOrGet('env-1', begin(), DIGEST_A)).rejects.toThrow(/another atomic chat process/i)
    expect(await s.listRecoverable()).toHaveLength(0)
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
    expect(fs.renames.some(([, to]) => to === path)).toBe(true)
    expect(fs.files.has(`${path}.tmp`)).toBe(false)
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

  it('treats a receipt for another authorization as new, not as a replay', () => {
    const recorded = withReceipt(base, receipt())
    expect(classifyReceipt(recorded, receipt({ nonce: 'once-2' }))).toBe('fresh')
  })
})
