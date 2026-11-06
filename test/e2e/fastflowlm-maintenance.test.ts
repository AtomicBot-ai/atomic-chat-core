import { once } from 'node:events'
import { expect, it } from 'vitest'
import { startDaemon } from '../helpers/compiled-core.js'
import { sdContext, sdCleanup, control } from '../helpers/compiled-diffusion.js'
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
