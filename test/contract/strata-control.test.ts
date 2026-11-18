import { expect, it } from 'vitest'
import catalog from '../fixtures/strata/catalog.json' with { type: 'json' }
import { CoreClient, parseStrataDescriptor } from '../../src/client/index.js'
import { createCore, useCoreHarness } from '../helpers/core-harness.js'
useCoreHarness()

it('connects Strata check and operation endpoints to the owner without a runtime build', async () => {
  const core = await createCore()
  const client = new CoreClient({ baseUrl: core.control.url, token: core.controlToken })
  const descriptor = parseStrataDescriptor(Object.values(catalog.models)[0]!.definition)
  expect(await client.checkStrataModel({ descriptor })).toMatchObject({
    verdict: 'engine-not-installed',
    requirements: descriptor.requirements,
  })
  expect(await client.strataPreparations()).toEqual([])
  expect(await client.listStrataMaintenance()).toEqual([])
  await expect(
    client.beginStrataPreparation({
      request_id: 'prepare',
      model_id: 'absent',
      source_digest: 'a'.repeat(64),
    })
  ).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
  const guard = await client.beginStrataMaintenance({
    request_id: 'remove',
    model_id: 'absent',
    action: 'remove',
  })
  expect(guard).toMatchObject({ state: 'held', ready_to_mutate: true })
  expect(await client.strataMaintenance(guard.operation_id)).toEqual(guard)
  expect(await client.snapshot()).toMatchObject({
    strata_preparations: [],
    strata_maintenance: [guard],
    downloads: [],
  })
  expect(await client.completeStrataMaintenance(guard.operation_id)).toMatchObject({
    state: 'completed',
    ready_to_mutate: false,
  })
})

it('accepts only a bounded staged byte count on the Strata descriptor check', async () => {
  const core = await createCore()
  const client = new CoreClient({ baseUrl: core.control.url, token: core.controlToken })
  const descriptor = parseStrataDescriptor(Object.values(catalog.models)[0]!.definition)
  await expect(client.checkStrataModel({ descriptor, staged_bytes: 1 })).resolves.toMatchObject({
    verdict: 'engine-not-installed',
  })
  await expect(client.checkStrataModel({ model_id: 'absent' })).resolves.toMatchObject({
    verdict: 'invalid-installation',
  })
  for (const staged_bytes of [-1, 0.5, '1', descriptor.requirements.download_bytes + 1]) {
    await expect(
      client.request('POST', '/models/strata/check', { descriptor, staged_bytes })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  }
  await expect(
    client.request('POST', '/models/strata/check', { model_id: 'model', staged_bytes: 0 })
  ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
})

it('restores an interrupted Strata preparation and exposes its revision after restart', async () => {
  const first = await createCore()
  await first.shutdown()
  const { join } = await import('node:path')
  const { data } = await import('../helpers/core-harness.js')
  const { StrataOperationStore } = await import('../../src/runtime/strata/index.js')
  const journal = await StrataOperationStore.open(join(data.layout.core.dir, 'strata'))
  const interrupted = {
    operation_id: 'old-operation',
    request_id: 'old-request',
    model_id: 'existing',
    source_digest: 'a'.repeat(64),
    revision: 3,
    state: 'preparing' as const,
    stage: 'tokenizer',
    error: null,
  }
  await journal.change((state) => state.preparations.push({ operation: interrupted, backend: 'cuda' }))
  const next = await createCore()
  const client = new CoreClient({ baseUrl: next.control.url, token: next.controlToken })
  expect(await client.strataPreparation(interrupted.operation_id)).toMatchObject({
    state: 'interrupted',
    revision: 4,
  })
  expect(await client.cancelStrataPreparation(interrupted.operation_id)).toMatchObject({
    state: 'cancelled',
    revision: 5,
  })
  expect(await client.snapshot()).toMatchObject({
    downloads: [],
    strata_preparations: [{ operation_id: interrupted.operation_id, state: 'cancelled', revision: 5 }],
  })
})
