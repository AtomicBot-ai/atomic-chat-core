import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { ExecutionJournal } from './execution-journal.js'
import type { ExecutionRecord } from './execution-journal.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-execution-journal-')
})
afterEach(() => data.cleanup())

const record = (over: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
  container_id: 'c1c0e1a0123456789abcdef0123456789abcdef0123456789abcdef01234567',
  engine_id: 'tensorrt-llm',
  image_digest: `sha256:${'a'.repeat(64)}`,
  scope: 'app',
  instance_id: 'instance-a',
  created_at: '2026-09-28T00:00:00.000Z',
  ...over,
})

describe('ExecutionJournal', () => {
  it('is empty when the executions directory does not exist yet', async () => {
    const journal = await ExecutionJournal.open(data.layout)
    expect(journal.list()).toEqual([])
  })

  it('persists a record one file per container id, and survives a reopen', async () => {
    const journal = await ExecutionJournal.open(data.layout)
    await journal.add(record())
    await journal.add(record({ container_id: 'c2', engine_id: 'tensorrt-llm' }))
    expect(journal.list()).toHaveLength(2)

    const files = await readdir(data.layout.managed.executionsDir)
    expect(files.sort()).toEqual([`${record().container_id}.json`, 'c2.json'].sort())

    const reopened = await ExecutionJournal.open(data.layout)
    expect(
      reopened
        .list()
        .map((r) => r.container_id)
        .sort()
    ).toEqual([record().container_id, 'c2'].sort())
  })

  it('replaces the record for a reused container id', async () => {
    const journal = await ExecutionJournal.open(data.layout)
    await journal.add(record({ scope: 'app' }))
    await journal.add(record({ scope: 'cli' }))
    expect(journal.list()).toEqual([record({ scope: 'cli' })])
  })

  it('removes a record, and removing an unknown id is a no-op', async () => {
    const journal = await ExecutionJournal.open(data.layout)
    await journal.add(record())
    await journal.remove('does-not-exist')
    expect(journal.list()).toHaveLength(1)
    await journal.remove(record().container_id)
    expect(journal.list()).toEqual([])
    expect((await ExecutionJournal.open(data.layout)).list()).toEqual([])
  })

  it('drops a torn-write record on reopen but keeps every other record intact', async () => {
    const journal = await ExecutionJournal.open(data.layout)
    await journal.add(record())
    await journal.add(record({ container_id: 'c2' }))
    await mkdir(data.layout.managed.executionsDir, { recursive: true })
    await writeFile(`${data.layout.managed.executionsDir}/torn.json`, '{"container_id": "torn", "eng')

    const reopened = await ExecutionJournal.open(data.layout)
    expect(
      reopened
        .list()
        .map((r) => r.container_id)
        .sort()
    ).toEqual([record().container_id, 'c2'].sort())
  })

  it('reads a foreign non-JSON file in the directory as no entry, not a crash', async () => {
    const journal = await ExecutionJournal.open(data.layout)
    await journal.add(record())
    await mkdir(data.layout.managed.executionsDir, { recursive: true })
    await writeFile(`${data.layout.managed.executionsDir}/notes.txt`, 'not json')
    const reopened = await ExecutionJournal.open(data.layout)
    expect(reopened.list()).toHaveLength(1)
  })

  it('rejects a container id that is not filesystem-safe', async () => {
    const journal = await ExecutionJournal.open(data.layout)
    await expect(journal.add(record({ container_id: '../escape' }))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })

  it('serializes concurrent add/remove on the same id so disk state matches the final in-memory state', async () => {
    const journal = await ExecutionJournal.open(data.layout)
    const id = record().container_id
    // Padding the first write makes its own I/O slower than the later, tiny writes it races against;
    // without the write queue, that write's rename can land *after* the later ones and win on disk
    // even though it was called first — the bug this test guards against.
    const padded = record({ container_id: id, scope: 'x'.repeat(5_000_000) })
    const final = record({ container_id: id, scope: 'final' })

    await Promise.all([journal.add(padded), journal.remove(id), journal.add(final)])

    expect(journal.list()).toEqual([final])
    const reopened = await ExecutionJournal.open(data.layout)
    expect(reopened.list()).toEqual([final])
  })

  it('a write that fails does not stop a later add/remove from reaching disk', async () => {
    const journal = await ExecutionJournal.open(data.layout)
    // Occupies the record's own on-disk path with a directory, so writeRecord's rename() onto it
    // fails (EISDIR) — an injected fs failure distinct from a torn write.
    await mkdir(join(data.layout.managed.executionsDir, 'will-fail.json'), { recursive: true })

    await expect(journal.add(record({ container_id: 'will-fail' }))).rejects.toBeTruthy()

    // Sequential and deterministic (no timing dependence): before the round-2 fix, the queue stayed
    // permanently rejected after the first failure, so this call would reject too and never touch disk.
    await journal.add(record({ container_id: 'good' }))

    const reopened = await ExecutionJournal.open(data.layout)
    expect(reopened.list().map((r) => r.container_id)).toEqual(['good'])
  })

  it('each failing write rejects with its own error, not a stale one from an earlier failure', async () => {
    const journal = await ExecutionJournal.open(data.layout)
    await mkdir(join(data.layout.managed.executionsDir, 'fail-a.json'), { recursive: true })
    await mkdir(join(data.layout.managed.executionsDir, 'fail-b.json'), { recursive: true })

    const errorA = (await journal.add(record({ container_id: 'fail-a' })).catch((e: unknown) => e)) as Error
    const errorB = (await journal.add(record({ container_id: 'fail-b' })).catch((e: unknown) => e)) as Error

    expect(errorA.message).toContain('fail-a')
    expect(errorB.message).toContain('fail-b')
    // Before the round-2 fix, the second call would skip its own write and reject with the first
    // call's exact error instead — the queue-poisoning bug this test guards against.
    expect(errorB.message).not.toBe(errorA.message)
  })

  it('rolls back the in-memory record when its own write fails, so list() matches what a reopen would find', async () => {
    const journal = await ExecutionJournal.open(data.layout)
    await mkdir(join(data.layout.managed.executionsDir, 'will-fail.json'), { recursive: true })

    await expect(journal.add(record({ container_id: 'will-fail' }))).rejects.toBeTruthy()

    expect(journal.list()).toEqual([]) // never durable, so never counted as added
  })

  it('rolls back the in-memory removal when the disk removal fails, so list() matches what a reopen would find', async () => {
    const journal = await ExecutionJournal.open(data.layout)
    await journal.add(record({ container_id: 'stuck' }))
    const path = join(data.layout.managed.executionsDir, 'stuck.json')
    await rm(path, { force: true })
    await mkdir(path, { recursive: true }) // occupies the path so rm() without recursive fails

    await expect(journal.remove('stuck')).rejects.toBeTruthy()

    expect(journal.list().map((r) => r.container_id)).toEqual(['stuck']) // the removal never persisted
  })
})
