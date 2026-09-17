import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'

let h: ControlHarness

beforeEach(async () => {
  h = await start()
})
afterEach(() => h.server.close())

describe('health, snapshot and sessions', () => {
  it('reports identity and uptime', async () => {
    const body = (await (await h.get('/atomic/v1/health')).json()) as Record<string, unknown>
    expect(body).toMatchObject({
      ok: true,
      pid: process.pid,
      version: '9.9.9',
      instance_id: 'instance-under-test',
      protocol: 1,
      dataFolder: '/tmp/data',
    })
    expect(body['uptime_ms']).toBeGreaterThanOrEqual(0)
  })
})

describe('shutdown', () => {
  it('refuses while another client is attached, and proceeds when forced', async () => {
    const other = h.clients.register({ name: 'app', pid: 123 })
    const refused = await h.get('/atomic/v1/shutdown', { method: 'POST' })
    expect(refused.status).toBe(409)
    expect((await refused.json()) as object).toMatchObject({ error: { code: 'CORE_ALREADY_RUNNING' } })
    expect(h.shutdowns).toEqual([])

    const forced = await h.get('/atomic/v1/shutdown', {
      method: 'POST',
      body: JSON.stringify({ force: true }),
    })
    expect((await forced.json()) as object).toMatchObject({ ok: true, stopping: true })
    await waitFor(() => h.shutdowns.length === 1)
    expect(h.shutdowns[0]).toMatchObject({ force: true })
    h.clients.unregister(other.id)
  })

  it('proceeds without force when the caller is the only client', async () => {
    const me = h.clients.register({ name: 'cli' })
    const res = await h.get('/atomic/v1/shutdown', {
      method: 'POST',
      body: JSON.stringify({ client_id: me.id }),
    })
    expect(res.status).toBe(200)
    await waitFor(() => h.shutdowns.length === 1)
    expect(h.shutdowns[0]).toMatchObject({ force: false, requestedBy: me.id })
  })
})

describe('events stream', () => {
  it('delivers live events with instance-scoped ids', async () => {
    const controller = new AbortController()
    const res = await h.get('/atomic/v1/events', { signal: controller.signal })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    h.emitter.emit('session:unloaded', { provider: 'llamacpp-upstream', model_id: 'demo', pid: 1 })
    const frame = await readFrame(reader)
    expect(frame).toContain('event: session:unloaded')
    expect(frame).toContain('id: instance-under-test:1')
    expect(frame).toContain('"model_id":"demo"')
    controller.abort()
  })

  it('keeps an idle SSE client alive with heartbeat comments', async () => {
    const controller = new AbortController()
    const res = await h.get('/atomic/v1/events', { signal: controller.signal })
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    ;(h.server as unknown as { ping: () => void }).ping()
    expect(await readFrame(reader)).toContain(': ping')
    controller.abort()
  })

  it('replays what a reconnecting client missed', async () => {
    h.emitter.emit('server:started', { host: '127.0.0.1', port: 1337 })
    h.emitter.emit('server:stopped', {})
    const controller = new AbortController()
    const res = await h.get('/atomic/v1/events?cursor=instance-under-test:1', { signal: controller.signal })
    const frame = await readFrame((res.body as ReadableStream<Uint8Array>).getReader())
    expect(frame).toContain('event: server:stopped')
    expect(frame).toContain('id: instance-under-test:2')
    controller.abort()
  })

  it('asks for a resync when the cursor belongs to another instance', async () => {
    const controller = new AbortController()
    const res = await h.get('/atomic/v1/events?cursor=some-other-instance:5', { signal: controller.signal })
    const frame = await readFrame((res.body as ReadableStream<Uint8Array>).getReader())
    expect(frame).toContain('event: resync')
    expect(frame).toContain('cursor-expired')
    controller.abort()
  })
})

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  while (!text.includes('\n\n')) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  await reader.cancel().catch(() => {})
  return text
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}
