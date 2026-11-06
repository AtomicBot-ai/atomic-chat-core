import { once } from 'node:events'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { startDaemon } from '../helpers/compiled-core.js'
import { sdContext, sdCleanup, control } from '../helpers/compiled-diffusion.js'
import { writeFlmInstallation } from '../helpers/fastflowlm-installation.js'
it('restores a mutation guard across a compiled owner restart and completes an absent removal exactly once', async () => {
  const ctx = await sdContext('flm-guard-')
  try {
    let owner = await startDaemon(ctx.dataFolder, ctx.daemons)
    const root = '/models/fastflowlm/maintenance'
    const post = (path: string, body: object) =>
      control(ctx, owner.ready, path, { method: 'POST', body: JSON.stringify(body) })
    const req = { model_id: 'old-variant', request_id: 'remove-one', kind: 'remove' }
    const r = await post(root, req)
    expect(r.status).toBe(200)
    const record = (await r.json()) as { operation_id: string; ready_to_mutate: boolean }
    expect(record.ready_to_mutate).toBe(true)
    const exit = once(owner.child, 'exit')
    owner.child.kill('SIGKILL')
    await exit
    owner = await startDaemon(ctx.dataFolder, ctx.daemons)
    expect(await (await post(root, req)).json()).toEqual(record)
    expect(await (await control(ctx, owner.ready, root + '/' + record.operation_id)).json()).toMatchObject({
      state: 'held',
    })
    const done = await (await post(root + '/' + record.operation_id + '/complete', {})).json()
    expect(done).toMatchObject({ state: 'completed', ready_to_mutate: false })
    expect(await (await post(root + '/' + record.operation_id + '/complete', {})).json()).toEqual(done)
  } finally {
    await sdCleanup(ctx)
  }
})

// The fixture is the installer: the owner only holds a durable guard and scans at complete.
// Every row kills the compiled owner at a distinct client-journal boundary.
it.each(['prepared', 'old-renamed', 'new-promoted', 'marker-written', 'rollback', 'completed'])(
  'recovers a client replacement after owner death at %s',
  async (boundary) => {
    const ctx = await sdContext('flm-replace-')
    try {
      const old = await writeFlmInstallation(ctx.dataFolder)
      const next = await writeFlmInstallation(
        join(ctx.dataFolder, 'staged'),
        { flm_version: '1.0.11', max_position_embeddings: 40960 },
        old.metadata.variant_id,
        'replacement-weights'
      )
      const saved = join(ctx.dataFolder, 'previous-installation')
      const marker = await readFile(join(next.dir, 'model.yml'))
      await rm(join(next.dir, 'model.yml')) // The client commits the marker last.
      let owner = await startDaemon(ctx.dataFolder, ctx.daemons)
      const root = '/models/fastflowlm/maintenance'
      const post = (path: string, body: object) =>
        control(ctx, owner.ready, path, { method: 'POST', body: JSON.stringify(body) })
      const req = { model_id: old.metadata.variant_id, request_id: 'replace-one', kind: 'replace' }
      const begin = await post(root, req)
      expect(begin.status).toBe(200)
      const guard = (await begin.json()) as { operation_id: string; ready_to_mutate: boolean }
      expect(guard.ready_to_mutate).toBe(true)
      const op = root + '/' + guard.operation_id
      if (boundary !== 'prepared') await rename(old.dir, saved)
      if (!['prepared', 'old-renamed'].includes(boundary)) await rename(next.dir, old.dir)
      if (['marker-written', 'completed'].includes(boundary))
        await writeFile(join(old.dir, 'model.yml'), marker)
      if (boundary === 'rollback') {
        await rm(old.dir, { recursive: true })
        await rename(saved, old.dir)
      }
      if (boundary === 'completed') expect((await post(op + '/complete', {})).status).toBe(200)
      const journalPath = join(ctx.dataFolder, 'installer-journal.json')
      const journal = JSON.stringify({ boundary, operation_id: guard.operation_id })
      await writeFile(journalPath, journal)
      const exited = once(owner.child, 'exit')
      owner.child.kill('SIGKILL')
      await exited
      owner = await startDaemon(ctx.dataFolder, ctx.daemons)
      expect(await readFile(journalPath, 'utf8')).toBe(journal)
      expect(await (await control(ctx, owner.ready, op)).json()).toMatchObject({
        state: boundary === 'completed' ? 'completed' : 'held',
      })
      expect(await (await post(root, req)).json()).toEqual({
        ...guard,
        ready_to_mutate: boundary !== 'completed',
      })
      if (['old-renamed', 'new-promoted'].includes(boundary)) {
        expect((await post(op + '/complete', {})).status).not.toBe(200)
        expect(await (await control(ctx, owner.ready, op)).json()).toMatchObject({ state: 'held' })
        if (boundary === 'new-promoted') await rm(old.dir, { recursive: true })
        await rename(saved, old.dir) // Client recovery rolls back the incomplete candidate.
      }
      const expected = ['marker-written', 'completed'].includes(boundary)
        ? 'replacement-weights'
        : 'model.q4nx'
      const bytesBefore = await readFile(join(old.dir, 'model.q4nx'), 'utf8')
      expect(bytesBefore).toBe(expected)
      const done = await post(op + '/complete', {})
      expect(done.status).toBe(200)
      const record = await done.json()
      expect(record).toMatchObject({ state: 'completed', ready_to_mutate: false })
      expect(await (await post(op + '/complete', {})).json()).toEqual(record)
      expect(await readFile(join(old.dir, 'model.q4nx'), 'utf8')).toBe(bytesBefore)
      expect(await readFile(journalPath, 'utf8')).toBe(journal)
    } finally {
      await sdCleanup(ctx)
    }
  },
  120_000
)
