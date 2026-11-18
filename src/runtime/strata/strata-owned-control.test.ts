import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { StrataOwnedControl } from './strata-owned-control.js'
import { StrataProcessJournal } from './strata-process-journal.js'
import type { StrataProcessIdentity } from './strata-process-journal.js'
import type { IdentityVerdict } from '../../lock/index.js'
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
const generation = 'a'.repeat(32)
const intent = {
  generation,
  profile: 'atomic-' + generation,
  modelId: 'model',
  cards: ['gpu'],
  core: { instanceId: 'core', pid: 1, startId: 'linux:1' },
}
const processes: StrataProcessIdentity[] = [
  { role: 'owner', pid: 12, startId: 'strata:l:12' },
  { role: 'server', pid: 13, startId: 'strata:l:13' },
  { role: 'compute', pid: 14, startId: 'strata:l:14' },
]
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'strata-owned-'))
  dirs.push(dir)
  const dead = new Set<number>([11])
  const verify = vi.fn(async (pid: number): Promise<IdentityVerdict> => (dead.has(pid) ? 'dead' : 'match'))
  const journal = await StrataProcessJournal.open(dir, 'scope', verify)
  const inspector = {
    initialize: vi.fn(async () => {}),
    identify: async () => 'strata:l:11',
    verify,
    snapshot: async () => ({ processes, launchComplete: dead.has(12) && dead.has(13) }),
    terminate: vi.fn(async (pid: number): Promise<IdentityVerdict> => {
      dead.add(pid)
      return 'dead'
    }),
  }
  const ownerId = 'b'.repeat(32)
  const instanceId = 'c'.repeat(32)
  const control = {
    start: vi.fn(async (o?: { register: (pid: number) => Promise<void> }) => {
      expect(journal.list()).toHaveLength(1)
      await o!.register(11)
      expect(journal.list()[0]!.processes).toContainEqual({
        role: 'launcher',
        pid: 11,
        startId: 'strata:l:11',
      })
      return { state: 'starting' as const }
    }),
    status: vi.fn(async () =>
      dead.has(12)
        ? { state: 'stopped' as const }
        : { state: 'ready' as const, ownerId, instanceId, hostPid: 12, childPid: 13 }
    ),
    stop: vi.fn(async () => {
      dead.add(12)
      dead.add(13)
      return { state: 'stopped' as const }
    }),
  }
  return { journal, control, inspector, dead, ownerId, instanceId }
}
it('registers the launcher, stops the identified owner, and retains the claim while compute survives', async () => {
  const f = await fixture()
  const owner = new StrataOwnedControl(intent, f.journal, f.control, f.inspector, 0)
  await owner.start(30_000)
  expect((await owner.status()).state).toBe('ready')
  await expect(owner.stop()).resolves.toBe(false)
  expect(f.control.stop).toHaveBeenCalledWith({ ownerId: f.ownerId, instanceId: f.instanceId })
  expect(f.journal.list()[0]!.cards).toEqual(['gpu'])
  f.dead.add(14)
  await expect(owner.stop()).resolves.toBe(true)
  expect(f.journal.list()).toEqual([])
})
it('checks the old core identity before recovering scoped orphans', async () => {
  const f = await fixture()
  const owner = new StrataOwnedControl(intent, f.journal, f.control, f.inspector, 0)
  await owner.start(30_000)
  await expect(owner.reconcile('new-core', async () => 'unknown')).resolves.toBe(false)
  expect(f.control.stop).not.toHaveBeenCalled()
  expect(f.inspector.terminate).not.toHaveBeenCalled()
  await expect(owner.reconcile('new-core', async () => 'dead')).resolves.toBe(true)
  expect(f.inspector.terminate).toHaveBeenCalledExactlyOnceWith(14, 'strata:l:14')
})
