import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../../contracts/index.js'
import type { ErrorCode } from '../../../contracts/index.js'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'

let h: ControlHarness

beforeEach(async () => {
  h = await start()
})
afterEach(() => h.server.close())

describe('remote access routes', () => {
  it("answers the tunnel status in the app's camelCase shape", async () => {
    const res = await h.get('/atomic/v1/remote-access')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      state: 'off',
      url: null,
      error: null,
      blockReason: null,
      canStart: true,
      canStop: false,
      serverHasApiKey: false,
    })
  })

  it('starts at once with `starting`, and stops once the tunnel is gone', async () => {
    const started = await h.get('/atomic/v1/remote-access/start', { method: 'POST' })
    expect(started.status).toBe(200)
    expect(await started.json()).toMatchObject({ state: 'starting', canStart: false, canStop: true })
    const stopped = await h.get('/atomic/v1/remote-access/stop', { method: 'POST' })
    expect(await stopped.json()).toMatchObject({ state: 'off', canStart: true, canStop: false })
    expect(h.calls).toEqual(['remote-access start', 'remote-access stop'])
  })

  it.each([
    ['REMOTE_ACCESS_SERVER_STOPPED', 'server_stopped'],
    ['REMOTE_ACCESS_OPERATION_IN_PROGRESS', 'operation_in_progress'],
    ['REMOTE_ACCESS_STOP_FAILED', 'stop_failed'],
  ])('refuses a start with 409 %s and the reason the app parses in details', async (code, reason) => {
    h.remoteAccessRefusal = Object.assign(new AtomicCoreError(code as ErrorCode, 'refused', reason))
    const res = await h.get('/atomic/v1/remote-access/start', { method: 'POST' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: { code, message: 'refused', details: reason } })
  })

  it('reads the status with GET only, and changes it with POST only', async () => {
    expect((await h.get('/atomic/v1/remote-access', { method: 'POST' })).status).toBe(405)
    expect((await h.get('/atomic/v1/remote-access/start')).status).toBe(405)
    expect((await h.get('/atomic/v1/remote-access/stop')).status).toBe(405)
  })
})

describe('LAN addresses route', () => {
  it('answers what a device on the network can dial, default-route address first', async () => {
    const res = await h.get('/atomic/v1/lan-addresses')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ addresses: ['192.168.1.5', '10.0.0.9'] })
  })

  it('answers an empty list on a machine with no network, which is not an error', async () => {
    h.lanAddresses = []
    const res = await h.get('/atomic/v1/lan-addresses')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ addresses: [] })
  })

  it('is read-only', async () => {
    expect((await h.get('/atomic/v1/lan-addresses', { method: 'POST' })).status).toBe(405)
  })
})
