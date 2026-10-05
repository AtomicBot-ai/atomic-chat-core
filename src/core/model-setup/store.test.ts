import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ModelSetup } from '../../contracts/index.js'
import { ModelSetupStore, parseModelSetupRecord } from './store.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-setups-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const record = (id: string, over: Partial<ModelSetup> = {}): ModelSetup =>
  ({
    setup_id: id,
    request_id: `req-${id}`,
    revision: 0,
    stage: 'queued',
    request: { repo: 'o/r', file: 'f.gguf' },
    plan: { digest: 'd', model_id: 'o/f' },
    task_ids: { model: `model-${id}` },
    created_at: 1,
    updated_at: 1,
    ...over,
  }) as ModelSetup

describe('parseModelSetupRecord', () => {
  it.each([
    ['a record', JSON.stringify(record('a')), true],
    ['torn JSON', '{"setup_id":', false],
    ['an unsafe id', JSON.stringify(record('../x')), false],
    ['an unknown stage', JSON.stringify(record('a', { stage: 'nope' as never })), false],
    ['no plan', JSON.stringify({ ...record('a'), plan: undefined }), false],
    ['a negative revision', JSON.stringify(record('a', { revision: -1 })), false],
  ])('%s → %s', (_name, text, ok) => {
    expect(parseModelSetupRecord(text) !== null).toBe(ok)
  })
})

describe('ModelSetupStore', () => {
  it('creates, reads and lists oldest first; an existing id is refused', async () => {
    const store = new ModelSetupStore(join(dir, 'prism-setups'))
    expect(await store.list()).toEqual([])
    await store.create(record('b', { created_at: 2 }))
    await store.create(record('a', { created_at: 1 }))
    expect((await store.list()).map((r) => r.setup_id)).toEqual(['a', 'b'])
    expect(await store.read('a')).toMatchObject({ setup_id: 'a' })
    expect(await store.read('../a')).toBeNull()
    await expect(store.create(record('a'))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('commits only against the revision it was computed from, bumping it', async () => {
    const store = new ModelSetupStore(dir)
    await store.create(record('a'))
    const next = await store.commit(record('a', { stage: 'downloading_model' }), 0)
    expect(next).toMatchObject({ revision: 1, stage: 'downloading_model' })
    expect(await store.commit(record('a', { stage: 'failed' }), 0)).toBeNull()
    expect(await store.read('a')).toMatchObject({ revision: 1, stage: 'downloading_model' })
    expect(await store.commit(record('missing'), 0)).toBeNull()
  })

  it('serialises concurrent commits: one wins per revision', async () => {
    const store = new ModelSetupStore(dir)
    await store.create(record('a'))
    const results = await Promise.all([
      store.commit(record('a', { stage: 'verifying' }), 0),
      store.commit(record('a', { stage: 'failed' }), 0),
    ])
    expect(results.filter((r) => r !== null)).toHaveLength(1)
  })

  it('keeps the previous record as .bak and reads it when the newest is torn', async () => {
    const store = new ModelSetupStore(dir)
    await store.create(record('a'))
    await store.commit(record('a', { stage: 'verifying' }), 0)
    expect(JSON.parse(await readFile(join(dir, 'a.json.bak'), 'utf8'))).toMatchObject({ revision: 0 })
    await writeFile(join(dir, 'a.json'), '{"torn":')
    expect(await store.read('a')).toMatchObject({ revision: 0, stage: 'queued' })
    expect((await store.list()).map((r) => r.setup_id)).toEqual(['a'])
  })

  it('skips foreign files', async () => {
    await writeFile(join(dir, 'notes.txt'), 'x')
    await writeFile(join(dir, 'bad id!.json'), JSON.stringify(record('a')))
    expect(await new ModelSetupStore(dir).list()).toEqual([])
  })
})
