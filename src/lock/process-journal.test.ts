import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { processStartId } from './process-identity.js'
import { ProcessJournal } from './process-journal.js'
import type { ChildProcessRecord } from './process-journal.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-journal-')
})
afterEach(() => data.cleanup())

const record = (over: Partial<ChildProcessRecord> = {}): ChildProcessRecord => ({
  instance_id: 'owner-a',
  pid: 4242,
  process_start_id: 'linux:1',
  exe: '/backends/llama-server',
  provider: 'llamacpp-upstream',
  model_id: 'm',
  port: 3000,
  started_at: '2026-09-15T00:00:00.000Z',
  ...over,
})

describe('journal file', () => {
  it('persists entries, replaces an entry for a reused pid and survives a reopen', async () => {
    const journal = await ProcessJournal.open(data.layout)
    await journal.add(record())
    await journal.add(record({ pid: 7, model_id: 'other' }))
    await journal.add(record({ pid: 7, model_id: 'replaced' }))
    expect(journal.list()).toHaveLength(2)
    const reopened = await ProcessJournal.open(data.layout)
    expect(reopened.list().find((r) => r.pid === 7)?.model_id).toBe('replaced')
    await reopened.remove(7)
    await reopened.remove(7)
    expect((await ProcessJournal.open(data.layout)).list().map((r) => r.pid)).toEqual([4242])
    const onDisk = JSON.parse(await readFile(data.layout.core.processes, 'utf8')) as { version: number }
    expect(onDisk.version).toBe(1)
  })

  it('keeps concurrent adds from losing entries', async () => {
    const journal = await ProcessJournal.open(data.layout)
    await Promise.all([1, 2, 3, 4, 5].map((pid) => journal.add(record({ pid }))))
    expect(
      (await ProcessJournal.open(data.layout))
        .list()
        .map((r) => r.pid)
        .sort()
    ).toEqual([1, 2, 3, 4, 5])
  })

  it('reads an empty, truncated or foreign journal as no entries', async () => {
    expect((await ProcessJournal.open(data.layout)).list()).toEqual([])
    await writeFile(data.layout.core.processes, '{"processes": [{"pid": 1, "inst')
    expect((await ProcessJournal.open(data.layout)).list()).toEqual([])
    await writeFile(data.layout.core.processes, '{"processes": [{"pid": 1}, 5, null]}')
    expect((await ProcessJournal.open(data.layout)).list()).toEqual([])
    await writeFile(data.layout.core.processes, '"nope"')
    expect((await ProcessJournal.open(data.layout)).list()).toEqual([])
  })
})

describe('scanOrphans', () => {
  it('confirms only a live process of a dead owner, and forgets what it confirms', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true })
    await new Promise((r) => setTimeout(r, 150))
    const pid = child.pid as number
    const startId = (await processStartId(pid)) as string
    const journal = await ProcessJournal.open(data.layout)
    await journal.add(record({ instance_id: 'dead-owner', pid, process_start_id: startId }))

    const scan = await journal.scanOrphans('current', new Set())
    expect(scan.confirmed.map((r) => r.pid)).toEqual([pid])
    expect(scan.skipped).toEqual([])
    expect(scan.gone).toEqual([])

    await journal.forget(scan.confirmed)
    expect(journal.list()).toEqual([])
    child.kill('SIGKILL')
    await new Promise((r) => child.on('exit', r))
  })

  it("never touches this owner's children, a live owner's children, or an unprovable process", async () => {
    const journal = await ProcessJournal.open(data.layout)
    await journal.add(record({ instance_id: 'current', pid: 11 }))
    await journal.add(record({ instance_id: 'other-live', pid: 12 }))
    await journal.add(record({ instance_id: 'dead-owner', pid: 13, process_start_id: null }))
    const scan = await journal.scanOrphans('current', new Set(['other-live']), { alive: () => true })
    expect(scan.confirmed).toEqual([])
    expect(scan.skipped.map((s) => [s.record.pid, s.reason])).toEqual([
      [11, 'current-instance'],
      [12, 'owner-alive'],
      [13, 'identity-unproven'],
    ])
  })

  it('reports a dead pid and a recycled pid as gone, not as something to kill', async () => {
    const journal = await ProcessJournal.open(data.layout)
    await journal.add(record({ instance_id: 'dead-owner', pid: 21, process_start_id: 'linux:1' }))
    await journal.add(record({ instance_id: 'dead-owner', pid: 22, process_start_id: 'linux:1' }))
    const scan = await journal.scanOrphans('current', new Set(), {
      alive: (pid) => pid === 22,
      platform: 'linux',
      readText: async () => '22 (x) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 999 0 0',
    })
    expect(scan.gone.map((r) => r.pid)).toEqual([21, 22])
    expect(scan.confirmed).toEqual([])
    await journal.forget(scan.gone)
    expect(journal.list()).toEqual([])
    await journal.forget([])
  })
})

describe('replace', () => {
  it('overwrites the whole journal in one write', async () => {
    const journal = await ProcessJournal.open(data.layout)
    await journal.add(record({ pid: 1 }))
    await journal.replace([record({ pid: 9 })])
    expect((await ProcessJournal.open(data.layout)).list().map((r) => r.pid)).toEqual([9])
  })
})
