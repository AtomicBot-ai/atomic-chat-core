import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { IdentityVerdict } from '../../lock/index.js'
import { StrataProcessJournal } from './strata-process-journal.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const generation = 'a'.repeat(32)
const intent = {
  generation,
  profile: `atomic-${generation}`,
  modelId: 'model',
  cards: ['gpu-1'],
  core: { instanceId: 'old-core', pid: 10, startId: 'linux:10' },
}
const children = [
  { role: 'owner' as const, pid: 11, startId: 'linux:11' },
  { role: 'server' as const, pid: 12, startId: 'linux:12' },
  { role: 'compute' as const, pid: 13, startId: 'linux:13' },
  { role: 'vision' as const, pid: 14, startId: 'linux:14' },
]
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'strata-process-journal-')))
  roots.push(root)
  const verdicts = new Map<number, IdentityVerdict>()
  const verify = vi.fn(async (pid: number) => verdicts.get(pid) ?? 'dead')
  const journal = await StrataProcessJournal.open(root, 'scope-1', verify)
  return { root, journal, verdicts, verify }
}
it('persists launch intent before children exist and retains an unresolved launch after restart', async () => {
  const f = await fixture()
  await f.journal.begin(intent)
  const reopened = await StrataProcessJournal.open(f.root, 'scope-1', f.verify)
  expect(reopened.list()[0]).toMatchObject({ ...intent, launchComplete: false, processes: [] })
  expect(await reopened.confirmStopped(generation)).toBe(false)
  expect(reopened.list()).toHaveLength(1)
  // A caller may attest that launch never happened only after proving its command/owner is gone.
  await reopened.observe(generation, { processes: [], launchComplete: true })
  expect(await reopened.confirmStopped(generation)).toBe(true)
})
it('does not release a GPU until the owner, HTTP server, compute and vision identities are all gone', async () => {
  const f = await fixture()
  await f.journal.begin(intent)
  await f.journal.observe(generation, {
    ownerId: 'b'.repeat(32),
    instanceId: 'c'.repeat(32),
    profileRevision: 'd'.repeat(16),
    processes: children,
    launchComplete: true,
  })
  f.verdicts.set(14, 'match')
  expect(await f.journal.confirmStopped(generation)).toBe(false)
  f.verdicts.set(14, 'unknown')
  expect(await f.journal.confirmStopped(generation)).toBe(false)
  f.verdicts.set(14, 'mismatch')
  expect(await f.journal.confirmStopped(generation)).toBe(true)
  expect(JSON.parse(await readFile(join(f.root, 'processes.json'), 'utf8')).entries).toEqual([])
})
it('reconciles only its scope, never reaps a live owner, and separates reused or unproven child PIDs', async () => {
  const f = await fixture()
  await f.journal.begin(intent)
  await f.journal.observe(generation, { processes: children, launchComplete: true })
  f.verdicts.set(10, 'match')
  expect((await f.journal.orphans('new-core')).confirmed).toEqual([])
  f.verdicts.set(10, 'unknown')
  expect((await f.journal.orphans('new-core')).confirmed).toEqual([])
  f.verdicts.set(10, 'dead')
  f.verdicts.set(11, 'mismatch')
  f.verdicts.set(13, 'match')
  f.verdicts.set(14, 'unknown')
  const scan = await f.journal.orphans('new-core')
  expect(scan.confirmed.map((row) => row.process.pid)).toEqual([13])
  expect(scan.blocked.map((row) => row.process?.pid)).toContain(14)
  expect((await f.journal.orphans('old-core')).confirmed).toEqual([])
  await expect(StrataProcessJournal.open(f.root, 'foreign-scope', f.verify)).rejects.toThrow(/scope/i)
})
it('keeps earlier descendants and refuses owner or process identity replacement within a generation', async () => {
  const f = await fixture()
  await f.journal.begin(intent)
  await f.journal.observe(generation, { ownerId: 'b'.repeat(32), processes: children })
  await f.journal.observe(generation, { processes: [children[0]!] })
  expect(f.journal.list()[0]!.processes).toHaveLength(4)
  await expect(f.journal.observe(generation, { ownerId: 'c'.repeat(32), processes: [] })).rejects.toThrow(
    /identity/i
  )
  await expect(
    f.journal.observe(generation, { processes: [{ ...children[2]!, startId: 'linux:99' }] })
  ).rejects.toThrow(/identity/i)
  expect(f.journal.list()[0]!.ownerId).toBe('b'.repeat(32))
})
it('fails closed on corrupt persistent state instead of forgetting GPU ownership', async () => {
  const f = await fixture()
  await f.journal.begin(intent)
  await writeFile(join(f.root, 'processes.json'), '{"version":1,"scopeId":"scope-1","entries":[{}]}')
  await expect(StrataProcessJournal.open(f.root, 'scope-1', f.verify)).rejects.toThrow(/journal/i)
})
