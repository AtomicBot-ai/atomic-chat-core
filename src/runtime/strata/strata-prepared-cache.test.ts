import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { StrataPreparedCache } from './strata-prepared-cache.js'
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
const key = {
  modelId: 'org/model',
  digest: 'a'.repeat(64),
  abi: 'strata-v1' as const,
  backend: 'metal' as const,
}
async function cache() {
  const root = await mkdtemp(join(tmpdir(), 'strata-cache-'))
  dirs.push(root)
  return StrataPreparedCache.open(root)
}
it('reuses only verified completed steps and atomically publishes a content-checked cache', async () => {
  const c = await cache(),
    stage = await c.stage(key, 'operation')
  const step = {
    id: 'tokenizer',
    tool: 'tools/strata_tokenizer.py' as const,
    args: [],
    outputs: [{ path: 'pack/vocab.json' }],
  }
  await mkdir(join(stage, 'pack'))
  await writeFile(join(stage, 'pack/vocab.json'), '{"a":0}')
  expect(await c.stepReady(stage, step)).toBe(false)
  await c.recordStep(stage, step)
  expect(await c.stepReady(stage, step)).toBe(true)
  expect(await c.ready(key)).toBeNull()
  const ready = await c.publish(key, stage)
  expect(await readFile(join(ready, 'pack/vocab.json'), 'utf8')).toBe('{"a":0}')
  expect(await c.ready(key)).toBe(ready)
  expect(await c.publishedBytes(key.modelId)).toBe(7)
  expect(await c.ready({ ...key, digest: 'b'.repeat(64) })).toBeNull()
  expect(await c.ready({ ...key, backend: 'cuda' })).toBeNull()
  await writeFile(join(ready, 'pack/vocab.json'), '{"b":0}')
  expect(await c.ready(key)).toBeNull()
})

it('inspects an absent cache without creating any directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-cache-'))
  dirs.push(root)
  const path = join(root, 'prepared')
  expect(await StrataPreparedCache.find(path)).toBeNull()
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('rejects partial outputs, corruption and unowned destination trees without deleting them', async () => {
  const c = await cache(),
    stage = await c.stage(key, 'operation')
  const step = {
    id: 'draft',
    tool: 'tools/dflash2_pack.py' as const,
    args: [],
    outputs: [{ path: 'draft.pack', size: 3 }],
  }
  await writeFile(join(stage, 'draft.pack'), 'xx')
  await expect(c.recordStep(stage, step)).rejects.toThrow()
  await writeFile(join(stage, 'draft.pack'), 'abc')
  await c.recordStep(stage, step)
  await writeFile(join(stage, 'draft.pack'), 'abd')
  expect(await c.stepReady(stage, step)).toBe(false)
  const destination = c.path(key)
  await mkdir(destination, { recursive: true })
  await writeFile(join(destination, 'user-file'), 'keep')
  await expect(c.publish(key, stage)).rejects.toThrow()
  expect(await readFile(join(destination, 'user-file'), 'utf8')).toBe('keep')
})
it('cleans only owned caches for one model and preserves the selected replacement digest', async () => {
  const c = await cache()
  for (const k of [key, { ...key, digest: 'b'.repeat(64) }, { ...key, modelId: 'other' }]) {
    const stage = await c.stage(k, 'op')
    await writeFile(join(stage, 'artifact'), 'ready')
    await c.publish(k, stage)
  }
  await c.cleanup(key.modelId, 'b'.repeat(64))
  expect(await c.ready(key)).toBeNull()
  expect(await c.ready({ ...key, digest: 'b'.repeat(64) })).not.toBeNull()
  expect(await c.ready({ ...key, modelId: 'other' })).not.toBeNull()
  const pending = await c.stage(key, 'pending')
  await writeFile(join(pending, 'partial'), 'pending')
  expect(await c.publishedBytes(key.modelId)).toBe(5)
})

it('rechecks source identity after hashing outputs and before publishing readiness', async () => {
  const c = await cache(),
    stage = await c.stage(key, 'op')
  await writeFile(join(stage, 'artifact'), 'ready')
  await expect(
    c.publish(key, stage, async () => {
      throw new Error('source changed')
    })
  ).rejects.toThrow('source changed')
  expect(await c.ready(key)).toBeNull()
  expect(await readFile(join(stage, 'artifact'), 'utf8')).toBe('ready')
})

it('publishes a verified CUDA source pack by digest without adding weights to the prepared cache', async () => {
  const c = await cache()
  const cuda = { ...key, backend: 'cuda' as const }
  const stage = await c.stage(cuda, 'operation')
  await expect(c.recordSourcePack(key, stage)).rejects.toThrow(/identity/)
  await c.recordSourcePack(cuda, stage)
  expect(await c.ready(cuda)).toBeNull()
  const ready = await c.publish(cuda, stage)
  expect(await c.ready(cuda)).toBe(ready)
  expect(JSON.parse(await readFile(join(ready, 'source-pack.json'), 'utf8'))).toEqual({
    source_digest: cuda.digest,
  })
  await expect(lstat(join(ready, 'pack'))).rejects.toMatchObject({ code: 'ENOENT' })
})
