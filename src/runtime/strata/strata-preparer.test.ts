import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import catalog from '../../../test/fixtures/strata/catalog.json' with { type: 'json' }
import { parseStrataDescriptor } from '../../client/index.js'
import type { StrataModelEntry } from '../../models/index.js'
import { StrataPreparedCache } from './strata-prepared-cache.js'
import { StrataPreparer } from './strata-preparer.js'
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
const op = {
  operation_id: 'op',
  request_id: 'request',
  model_id: 'model',
  source_digest: 'a'.repeat(64),
  revision: 1,
  state: 'queued' as const,
  stage: 'queued',
  error: null,
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'strata-preparer-'))
  dirs.push(dir)
  const source = join(dir, 'source')
  await mkdir(source)
  const descriptor = parseStrataDescriptor(Object.values(catalog.models)[1]!.definition)
  for (const file of descriptor.files) {
    await mkdir(join(source, file.path, '..'), { recursive: true })
    await writeFile(join(source, file.path), 'source')
  }
  const entry = {
    id: 'model',
    dir: source,
    strata: { schema_version: 1, source_digest: op.source_digest, descriptor },
  } as StrataModelEntry
  const cache = await StrataPreparedCache.open(join(dir, 'cache'))
  const execute = vi.fn(async (ctx, step) => {
    for (const output of step.outputs) {
      await mkdir(join(ctx.stagingDir, output.path, '..'), { recursive: true })
      await writeFile(join(ctx.stagingDir, output.path), 'derived')
    }
  })
  const preparer = new StrataPreparer({
    registry: {
      get: async () => entry,
      verify: async () => ({ ...entry, contextLimit: descriptor.context_length }),
    },
    cache,
    context: async () => ({
      python: '/bundle/python',
      controlDir: '/bundle/control',
      platform: process.platform,
      env: {},
    }),
    reconcile: async () => {},
    execute,
  })
  return { preparer, execute, cache, entry }
}
it('publishes verified outputs and reuses a complete cache without rerunning the converter', async () => {
  const f = await fixture(),
    report = vi.fn(async () => {})
  await f.preparer.run(op, 'cuda', new AbortController().signal, report)
  expect(f.execute).toHaveBeenCalledTimes(1)
  expect(
    await f.cache.ready({ modelId: 'model', digest: op.source_digest, abi: 'strata-v1', backend: 'cuda' })
  ).not.toBeNull()
  await f.preparer.run({ ...op, operation_id: 'retry' }, 'cuda', new AbortController().signal, report)
  expect(f.execute).toHaveBeenCalledTimes(1)
})
it('does not publish outputs after the source changes during conversion', async () => {
  const f = await fixture()
  const execute = f.execute.getMockImplementation()!
  f.execute.mockImplementationOnce(async (ctx, step) => {
    await execute(ctx, step)
    await writeFile(join(f.entry.dir, f.entry.strata.descriptor.files[0]!.path), 'changed-source')
  })
  await expect(f.preparer.run(op, 'cuda', new AbortController().signal, async () => {})).rejects.toThrow(
    /source changed/i
  )
  expect(
    await f.cache.ready({ modelId: 'model', digest: op.source_digest, abi: 'strata-v1', backend: 'cuda' })
  ).toBeNull()
})
