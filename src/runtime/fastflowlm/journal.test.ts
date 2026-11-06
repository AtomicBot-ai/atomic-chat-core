import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FlmJournal } from './journal.js'
it('atomically replaces only the published revision', async () => {
  const path = await mkdtemp(join(tmpdir(), 'flm-journal-')),
    id = randomUUID(),
    store = new FlmJournal<{ id: string; n: number }>(path, (r) => r.id)
  try {
    await store.write({ id, n: 1 })
    await store.write({ id, n: 2 })
    expect(await store.all()).toEqual([{ id, n: 2 }])
  } finally {
    await rm(path, { recursive: true, force: true })
  }
})
