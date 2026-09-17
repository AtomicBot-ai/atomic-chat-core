import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'

let h: ControlHarness

beforeEach(async () => {
  h = await start()
})
afterEach(() => h.server.close())

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
