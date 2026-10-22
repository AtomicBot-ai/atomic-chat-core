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

describe('selection route', () => {
  it('replaces the whole selection and reads it back', async () => {
    const put = (body: unknown) =>
      h.get('/atomic/v1/server/selection', { method: 'PUT', body: JSON.stringify(body) })

    const first = await put({ models: [{ model: 'qwen', provider: 'llamacpp-upstream' }] })
    expect(await first.json()).toEqual({ models: [{ model: 'qwen', provider: 'llamacpp-upstream' }] })
    const replaced = await put({ models: [{ model: 'gpt-5', provider: 'openai' }] })
    expect(await replaced.json()).toEqual({ models: [{ model: 'gpt-5', provider: 'openai' }] })
    expect(await (await h.get('/atomic/v1/server/selection')).json()).toEqual({
      models: [{ model: 'gpt-5', provider: 'openai' }],
    })
    expect((await put({ models: [] })).status).toBe(200)
    expect(h.selection).toEqual([])
  })

  it('refuses a body that is not a list of non-empty model and provider strings, and keeps the selection', async () => {
    await h.get('/atomic/v1/server/selection', {
      method: 'PUT',
      body: JSON.stringify({ models: [{ model: 'qwen', provider: 'mlx' }] }),
    })
    for (const body of [
      null,
      {},
      { models: 'qwen' },
      { models: [null] },
      { models: ['qwen'] },
      { models: [{ model: 'qwen' }] },
      { models: [{ model: 1, provider: 'mlx' }] },
      { models: [{ model: '', provider: 'mlx' }] },
      { models: [{ model: 'qwen', provider: '' }] },
      {
        models: [
          { model: 'gemma', provider: 'mlx' },
          { model: 'qwen', provider: 7 },
        ],
      },
    ]) {
      const res = await h.get('/atomic/v1/server/selection', { method: 'PUT', body: JSON.stringify(body) })
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(h.selection).toEqual([{ model: 'qwen', provider: 'mlx' }])
  })
})
