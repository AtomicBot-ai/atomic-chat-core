import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { StrataOperationStore } from './strata-operation-store.js'
import { StrataPreparationService } from './strata-preparation.js'
import type { StrataPreparationDependencies } from './strata-preparation.js'
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
const request = { request_id: 'request', model_id: 'model', source_digest: 'a'.repeat(64) }
async function fixture(run: StrataPreparationDependencies['run']) {
  const dir = await mkdtemp(join(tmpdir(), 'strata-preparation-'))
  dirs.push(dir)
  const store = await StrataOperationStore.open(dir),
    emit = vi.fn()
  const service = new StrataPreparationService(store, {
    resolve: async () => ({ backend: 'metal', digest: request.source_digest }),
    run,
    emit,
  })
  return { service, store, emit }
}
it('deduplicates concurrent retries and publishes ordered revisions only after durable completion', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const run = vi.fn(async (_op, _backend, _signal, report) => {
    await report('tokenizer', 1, 2)
    await gate
    await report('verifying')
  })
  const { service, store, emit } = await fixture(run)
  const [a, b] = await Promise.all([service.begin(request), service.begin(request)])
  expect(a.operation_id).toBe(b.operation_id)
  await expect(service.begin({ ...request, source_digest: 'b'.repeat(64) })).rejects.toThrow(/request/i)
  await expect(service.begin({ ...request, request_id: 'another' })).rejects.toThrow(/prepar/i)
  release()
  await service.settled(a.operation_id)
  expect(service.get(a.operation_id).state).toBe('ready')
  expect(run).toHaveBeenCalledTimes(1)
  const revisions = emit.mock.calls.map(([o]) => o.revision)
  expect(revisions).toEqual([1, 2, 3, 4, 5])
  expect(store.snapshot().preparations[0]!.operation).toEqual(service.get(a.operation_id))
  await service.shutdown()
})
it('waits for cancelled work to stop and resumes the same durable operation', async () => {
  let entered!: () => void
  const started = new Promise<void>((r) => {
    entered = r
  })
  let attempts = 0
  const { service } = await fixture(async (_op, _backend, signal) => {
    if (++attempts > 1) return
    entered()
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
  })
  const op = await service.begin(request)
  await started
  expect((await service.cancel(op.operation_id)).state).toBe('cancelled')
  expect((await service.resume(op.operation_id)).operation_id).toBe(op.operation_id)
  await service.settled(op.operation_id)
  expect(service.get(op.operation_id).state).toBe('ready')
  expect(attempts).toBe(2)
  await service.shutdown()
})
it('refuses preparation under maintenance except the held matching replacement target', async () => {
  const { service, store } = await fixture(async () => {})
  await store.change((s) =>
    s.maintenance.push({
      operation: {
        operation_id: 'guard',
        request_id: 'maintenance',
        model_id: 'model',
        action: 'replace',
        target_source_digest: request.source_digest,
        state: 'held',
        ready_to_mutate: true,
        revision: 1,
      },
      originalDigest: 'b'.repeat(64),
    })
  )
  await expect(service.begin(request)).rejects.toThrow(/maintenance/i)
  const op = await service.begin({ ...request, maintenance_id: 'guard' })
  await service.settled(op.operation_id)
  expect(service.get(op.operation_id).state).toBe('ready')
  await service.shutdown()
})

it('waits for a concurrent begin to settle before completing shutdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'strata-shutdown-'))
  dirs.push(dir)
  let release!: () => void, entered!: () => void
  const gated = new Promise<void>((r) => {
      release = r
    }),
    resolving = new Promise<void>((r) => {
      entered = r
    })
  const store = await StrataOperationStore.open(dir)
  const service = new StrataPreparationService(store, {
    resolve: async () => {
      entered()
      await gated
      return { backend: 'metal', digest: request.source_digest }
    },
    run: async (_op, _backend, signal) => {
      if (!signal.aborted)
        await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }))
    },
    emit: () => {},
  })
  const begin = service.begin(request)
  await resolving
  let stopped = false
  const shutdown = service.shutdown().then(() => {
    stopped = true
  })
  await new Promise((r) => setImmediate(r))
  expect(stopped).toBe(false)
  release()
  const op = await begin
  await shutdown
  expect(service.get(op.operation_id).state).toBe('cancelled')
})
