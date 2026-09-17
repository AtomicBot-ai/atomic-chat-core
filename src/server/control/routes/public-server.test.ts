import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'

let h: ControlHarness

beforeEach(async () => {
  h = await start()
})
afterEach(() => h.server.close())

describe('models and public server', () => {
  it('starts and stops the public listener without touching control', async () => {
    const started = await h.get('/atomic/v1/server/start', {
      method: 'POST',
      body: JSON.stringify({
        host: '127.0.0.1',
        port: 8080,
        prefix: '/v1',
        api_key: 'k',
        trusted_hosts: ['lan.example'],
        proxy_timeout_secs: 30,
      }),
    })
    expect((await started.json()) as object).toMatchObject({ running: true, port: 8080 })
    expect(h.calls[0]).toBe(
      'server start {"host":"127.0.0.1","port":8080,"prefix":"/v1","apiKey":"k","trustedHosts":["lan.example"],"proxyTimeoutSecs":30}'
    )
    expect((await (await h.get('/atomic/v1/server')).json()) as object).toMatchObject({ running: true })

    const defaults = await h.get('/atomic/v1/server/start', { method: 'POST', body: '{}' })
    expect(defaults.status).toBe(200)

    const stopped = await h.get('/atomic/v1/server/stop', { method: 'POST' })
    expect((await stopped.json()) as object).toMatchObject({ running: false })
    expect((await h.get('/atomic/v1/health')).status, 'control survives the public listener').toBe(200)
  })
})

describe('inspector route', () => {
  it('accepts only a boolean', async () => {
    const ok = await h.get('/atomic/v1/server/inspector', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    })
    expect(await ok.json()).toEqual({ enabled: true })
    expect(h.calls).toContain('inspector true')
    const bad = await h.get('/atomic/v1/server/inspector', {
      method: 'PUT',
      body: JSON.stringify({ enabled: 'yes' }),
    })
    expect(bad.status).toBe(400)
  })
})
