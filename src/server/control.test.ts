import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LocalApiServerState, SessionInfo, UnloadResult } from '../contracts/index.js'
import { CoreEmitter } from '../events/index.js'
import { ClientRegistry } from './clients.js'
import { ControlServer } from './control.js'
import type { ControlServerDeps, ControlSnapshot, SessionSummary } from './control.js'

const TOKEN = 'test-control-token'

interface Harness {
  server: ControlServer
  emitter: CoreEmitter
  clients: ClientRegistry
  sessions: SessionSummary[]
  serverState: LocalApiServerState
  calls: string[]
  loadResult: () => Promise<SessionInfo>
  unloadResult: () => Promise<UnloadResult>
  shutdowns: Array<{ force: boolean; requestedBy?: string | undefined }>
  get: (path: string, init?: RequestInit) => Promise<Response>
}

let h: Harness

const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  pid: 111,
  port: 3456,
  model_id: 'demo',
  model_path: '/models/demo.gguf',
  is_embedding: false,
  api_key: 'session-key',
  provider: 'llamacpp-upstream',
  ...over,
})

async function start(over: Partial<ControlServerDeps> = {}): Promise<Harness> {
  const emitter = new CoreEmitter({ instanceId: 'instance-under-test' })
  const clients = new ClientRegistry()
  const sessions: SessionSummary[] = []
  const calls: string[] = []
  const shutdowns: Harness['shutdowns'] = []
  const serverState: LocalApiServerState = {
    running: false,
    host: '127.0.0.1',
    port: 1337,
    prefix: '/v1',
    requires_api_key: false,
    pid: null,
  }
  const harness = {
    emitter,
    clients,
    sessions,
    serverState,
    calls,
    shutdowns,
    loadResult: async () => session(),
    unloadResult: async () => ({ success: true }),
  } as unknown as Harness
  const server = await ControlServer.start({
    token: TOKEN,
    instanceId: 'instance-under-test',
    version: '9.9.9',
    dataFolder: '/tmp/data',
    emitter,
    clients,
    sessions: () => sessions,
    loadModel: async (provider, modelId, body) => {
      calls.push(`load ${provider} ${modelId} ${JSON.stringify(body)}`)
      return harness.loadResult()
    },
    unloadModel: async (provider, modelId) => {
      calls.push(`unload ${provider} ${modelId}`)
      return harness.unloadResult()
    },
    publicServer: {
      status: () => ({ ...serverState }),
      start: async (options) => {
        calls.push(`server start ${JSON.stringify(options)}`)
        Object.assign(serverState, { running: true, ...options, pid: process.pid })
        return { ...serverState }
      },
      stop: async () => {
        calls.push('server stop')
        Object.assign(serverState, { running: false, pid: null })
        return { ...serverState }
      },
    },
    shutdown: async (options) => {
      shutdowns.push(options)
    },
    ...over,
  })
  harness.server = server
  harness.get = (path, init = {}) =>
    fetch(`${server.url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
    })
  return harness
}

beforeEach(async () => {
  h = await start()
})
afterEach(() => h.server.close())

describe('gates', () => {
  it('rejects a missing, malformed or wrong token', async () => {
    expect((await fetch(`${h.server.url}/atomic/v1/health`)).status).toBe(401)
    expect(
      (await fetch(`${h.server.url}/atomic/v1/health`, { headers: { authorization: 'Basic x' } })).status
    ).toBe(401)
    expect(
      (await fetch(`${h.server.url}/atomic/v1/health`, { headers: { authorization: `Bearer ${TOKEN}x` } }))
        .status
    ).toBe(401)
    const body = (await (await fetch(`${h.server.url}/atomic/v1/health`)).json()) as {
      error: { code: string }
    }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('rejects a non-loopback Host header even with a valid token', async () => {
    // `fetch` refuses to set Host, so this goes through the raw client — the header is exactly what
    // a DNS-rebinding attempt from a browser would carry.
    const res = await rawRequest('/atomic/v1/health', {
      host: 'evil.example.com',
      authorization: `Bearer ${TOKEN}`,
    })
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body) as object).toMatchObject({ error: { code: 'FORBIDDEN_HOST' } })
  })

  it('binds loopback only', () => {
    expect(h.server.host).toBe('127.0.0.1')
    expect(h.server.port).toBeGreaterThan(0)
  })

  it('answers 404 for an unknown route and 405 for the wrong method', async () => {
    expect((await h.get('/atomic/v1/nope')).status).toBe(404)
    expect((await h.get('/atomic/v1/health', { method: 'POST' })).status).toBe(405)
  })
})

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

  it('returns sessions, server state, clients and a cursor in one snapshot', async () => {
    h.sessions.push(session({ model_id: 'loaded' }))
    h.emitter.emit('server:stopped', {})
    const snapshot = (await (await h.get('/atomic/v1/snapshot')).json()) as ControlSnapshot
    expect(snapshot.sessions).toHaveLength(1)
    expect(snapshot.sessions[0]).toMatchObject({ model_id: 'loaded', provider: 'llamacpp-upstream' })
    expect(snapshot.server.running).toBe(false)
    expect(snapshot.cursor).toBe('instance-under-test:1')
    expect(snapshot.instance_id).toBe('instance-under-test')
    const sessions = (await (await h.get('/atomic/v1/sessions')).json()) as { sessions: SessionSummary[] }
    expect(sessions.sessions).toHaveLength(1)
  })
})

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

describe('models and public server', () => {
  it('loads and unloads a model whose id contains slashes', async () => {
    const res = await h.get('/atomic/v1/models/llamacpp-upstream/Owner/Repo-GGUF/load', {
      method: 'POST',
      body: JSON.stringify({ is_embedding: false }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as object).toMatchObject({ session: { model_id: 'demo' } })
    expect(h.calls[0]).toBe('load llamacpp-upstream Owner/Repo-GGUF {"is_embedding":false}')

    const unload = await h.get('/atomic/v1/models/llamacpp-upstream/Owner/Repo-GGUF/unload', {
      method: 'POST',
    })
    expect(await unload.json()).toEqual({ success: true })
    expect(h.calls[1]).toBe('unload llamacpp-upstream Owner/Repo-GGUF')
  })

  it('passes a load failure through with its code and status', async () => {
    const failing = await start({
      loadModel: async () => {
        throw Object.assign(new Error('nope'), { code: 'MODEL_NOT_FOUND' })
      },
    })
    const res = await failing.get('/atomic/v1/models/llamacpp-upstream/x/load', { method: 'POST' })
    expect(res.status).toBe(404)
    expect((await res.json()) as object).toMatchObject({ error: { code: 'MODEL_NOT_FOUND' } })
    await failing.server.close()
  })

  it('starts and stops the public listener without touching control', async () => {
    const started = await h.get('/atomic/v1/server/start', {
      method: 'POST',
      body: JSON.stringify({ host: '127.0.0.1', port: 8080, prefix: '/v1', api_key: 'k' }),
    })
    expect((await started.json()) as object).toMatchObject({ running: true, port: 8080 })
    expect(h.calls[0]).toContain('server start')
    expect((await (await h.get('/atomic/v1/server')).json()) as object).toMatchObject({ running: true })

    const defaults = await h.get('/atomic/v1/server/start', { method: 'POST', body: '{}' })
    expect(defaults.status).toBe(200)

    const stopped = await h.get('/atomic/v1/server/stop', { method: 'POST' })
    expect((await stopped.json()) as object).toMatchObject({ running: false })
    expect((await h.get('/atomic/v1/health')).status, 'control survives the public listener').toBe(200)
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

function rawRequest(
  path: string,
  headers: Record<string, string>
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: h.server.host, port: h.server.port, path, method: 'GET', headers },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

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
