import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { StrataOperationStore } from './strata-operation-store.js'
import { StrataPreparationService } from './strata-preparation.js'
import { StrataMaintenanceService } from './strata-maintenance.js'
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
const oldDigest = 'a'.repeat(64),
  newDigest = 'b'.repeat(64)
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'strata-maintenance-'))
  dirs.push(dir)
  const store = await StrataOperationStore.open(dir)
  const preparations = new StrataPreparationService(store, {
    resolve: async (r) => ({ digest: r.source_digest, backend: 'metal' }),
    run: async () => {},
    emit: () => {},
  })
  const inspect = vi.fn(async (): Promise<{ digest: string; ready: boolean } | null> => ({
    digest: oldDigest,
    ready: true,
  }))
  const stop = vi.fn(async () => {}),
    cleanup = vi.fn(async () => {})
  const service = new StrataMaintenanceService(preparations, { inspect, stop, cleanup })
  return { service, preparations, inspect, stop, cleanup, store, dir }
}
it('publishes mutation permission only after stop and excludes racing loads', async () => {
  const f = await fixture()
  let stop!: () => void, entered!: () => void
  const stopping = new Promise<void>((r) => {
    entered = r
  })
  f.stop.mockImplementationOnce(async () => {
    entered()
    await new Promise<void>((r) => {
      stop = r
    })
  })
  const begin = f.service.begin({ request_id: 'remove', model_id: 'model', action: 'remove' })
  await stopping
  expect(f.service.list()[0]).toMatchObject({ state: 'stopping', ready_to_mutate: false })
  await expect(f.service.withLoad('model', async () => 'loaded')).rejects.toThrow(/maintenance/i)
  stop()
  const guard = await begin
  expect(guard).toMatchObject({ state: 'held', ready_to_mutate: true })
  await expect(f.service.complete(guard.operation_id)).rejects.toThrow(/still|removed/i)
  f.inspect.mockResolvedValue(null)
  expect((await f.service.complete(guard.operation_id)).state).toBe('completed')
  expect(f.cleanup).toHaveBeenCalledWith('model', null)
  expect(await f.service.withLoad('model', async () => 'loaded')).toBe('loaded')
})
it('retains the guard after failed replacement and allows only verified target or verified rollback', async () => {
  const f = await fixture()
  const request = {
    request_id: 'replace',
    model_id: 'model',
    action: 'replace' as const,
    target_source_digest: newDigest,
  }
  const guard = await f.service.begin(request)
  expect((await f.service.begin(request)).operation_id).toBe(guard.operation_id)
  f.inspect.mockResolvedValue({ digest: newDigest, ready: false })
  await expect(f.service.complete(guard.operation_id)).rejects.toThrow(/verified/i)
  await expect(f.service.withLoad('model', async () => {})).rejects.toThrow()
  f.inspect.mockResolvedValue({ digest: oldDigest, ready: true })
  expect((await f.service.complete(guard.operation_id)).state).toBe('completed')
  expect(f.cleanup).toHaveBeenCalledWith('model', oldDigest)
})
it('rechecks stop after restart and never clears exclusion when stop fails', async () => {
  const f = await fixture(),
    request = { request_id: 'remove', model_id: 'model', action: 'remove' as const }
  const guard = await f.service.begin(request)
  const store = await StrataOperationStore.open(f.dir)
  const preparations = new StrataPreparationService(store, {
    resolve: async (r) => ({ backend: 'metal', digest: r.source_digest }),
    run: async () => {},
    emit: () => {},
  })
  const service = new StrataMaintenanceService(preparations, {
    inspect: f.inspect,
    stop: async () => {
      throw new Error('GPU still occupied')
    },
    cleanup: f.cleanup,
  })
  await expect(service.begin(request)).rejects.toThrow('GPU still occupied')
  expect(service.get(guard.operation_id)).toMatchObject({ state: 'stopping', ready_to_mutate: false })
  await expect(service.complete(guard.operation_id)).rejects.toThrow()
})
