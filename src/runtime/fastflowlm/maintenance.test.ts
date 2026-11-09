import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AsyncMutex } from '../../diffusion/index.js'
import { FlmMaintenance } from './maintenance.js'
it('holds across owner restart, retries interrupted unload and requires a successful rescan before release', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flm-maint-'))
  const stop = vi.fn(async () => {}).mockRejectedValueOnce(Error('busy'))
  const scan = vi.fn(async () => {}).mockRejectedValueOnce(Error('partial'))
  const owner = () => new FlmMaintenance(dir, new AsyncMutex(), stop, scan)
  const req = { request_id: 'one', model_id: 'model', kind: 'replace' as const }
  try {
    await expect(owner().begin(req)).rejects.toThrow('busy')
    const op = (await owner().list())[0]!
    expect(op.state).toBe('stopping')
    await expect(owner().assertLoadable('model')).rejects.toThrow()
    expect(await owner().begin(req)).toEqual({ operation_id: op.operation_id, ready_to_mutate: true })
    await expect(owner().begin({ ...req, kind: 'remove' })).rejects.toThrow()
    await expect(owner().complete(op.operation_id)).rejects.toThrow('partial')
    expect((await owner().get(op.operation_id)).state).toBe('held')
    expect((await owner().complete(op.operation_id)).state).toBe('completed')
    await owner().assertLoadable('model')
    expect((await owner().begin(req)).ready_to_mutate).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
