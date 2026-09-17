import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ControlSnapshot } from '../types.js'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'

let h: ControlHarness

beforeEach(async () => {
  h = await start()
})
afterEach(() => h.server.close())

describe('clients', () => {
  it('registers with a snapshot, heartbeats, and rejects an unknown id', async () => {
    const res = await h.get('/atomic/v1/clients', {
      method: 'POST',
      body: JSON.stringify({ name: 'cli', pid: 4242 }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      client: { id: string; name: string }
      heartbeat_interval_ms: number
      snapshot: ControlSnapshot
    }
    expect(body.client.name).toBe('cli')
    expect(body.heartbeat_interval_ms).toBeGreaterThan(0)
    expect(body.snapshot.instance_id).toBe('instance-under-test')

    const beat = await h.get(`/atomic/v1/clients/${body.client.id}/heartbeat`, { method: 'POST' })
    expect(beat.status).toBe(200)
    expect((await h.get('/atomic/v1/clients/not-a-client/heartbeat', { method: 'POST' })).status).toBe(410)

    const gone = await h.get(`/atomic/v1/clients/${body.client.id}`, { method: 'DELETE' })
    expect(gone.status).toBe(200)
    expect(h.clients.list()).toEqual([])

    const unnamed = await h.get('/atomic/v1/clients', { method: 'POST', body: '{}' })
    expect((await unnamed.json()) as object).toMatchObject({ client: { name: 'unnamed', pid: null } })
  })
})
