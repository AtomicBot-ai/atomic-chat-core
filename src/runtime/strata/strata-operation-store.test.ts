import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { StrataOperationStore } from './strata-operation-store.js'
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
async function root() {
  const p = await mkdtemp(join(tmpdir(), 'strata-ops-'))
  dirs.push(p)
  return p
}
it('durably interrupts unfinished work and retains maintenance exclusion on restart', async () => {
  const dir = await root(),
    store = await StrataOperationStore.open(dir)
  await store.change((s) => {
    s.preparations.push({
      operation: {
        operation_id: 'op',
        request_id: 'request',
        model_id: 'model',
        source_digest: 'a'.repeat(64),
        revision: 2,
        state: 'preparing',
        stage: 'tokenizer',
        error: null,
      },
      backend: 'metal',
    })
    s.maintenance.push({
      operation: {
        operation_id: 'guard',
        request_id: 'guard-request',
        model_id: 'model',
        action: 'remove',
        revision: 1,
        state: 'held',
        ready_to_mutate: true,
      },
      originalDigest: 'a'.repeat(64),
    })
  })
  const reopened = await StrataOperationStore.open(dir)
  expect(reopened.snapshot().preparations[0]!.operation).toMatchObject({
    state: 'interrupted',
    revision: 3,
    stage: 'tokenizer',
  })
  expect(reopened.snapshot().maintenance[0]!.operation).toMatchObject({
    state: 'stopping',
    ready_to_mutate: false,
    revision: 2,
  })
  expect(
    JSON.parse(await readFile(join(dir, 'operations.json'), 'utf8')).preparations[0].operation.state
  ).toBe('interrupted')
})
it('serializes mutations and exposes no mutable references or partial failed update', async () => {
  const store = await StrataOperationStore.open(await root())
  await expect(
    store.change((s) => {
      s.version = 4 as never
      throw new Error('abort')
    })
  ).rejects.toThrow('abort')
  expect(store.snapshot().version).toBe(1)
  const snap = store.snapshot()
  snap.version = 9 as never
  expect(store.snapshot().version).toBe(1)
})
it('fails closed on unreadable operation state instead of forgetting maintenance', async () => {
  const dir = await root()
  await writeFile(join(dir, 'operations.json'), '{broken')
  await expect(StrataOperationStore.open(dir)).rejects.toThrow()
  await writeFile(
    join(dir, 'operations.json'),
    JSON.stringify({ version: 1, preparations: [], maintenance: [{ operation: { state: 'held' } }] })
  )
  await expect(StrataOperationStore.open(dir)).rejects.toThrow()
})
