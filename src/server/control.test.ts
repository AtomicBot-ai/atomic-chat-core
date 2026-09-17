import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LocalApiServerState, SessionInfo, UnloadResult } from '../contracts/index.js'
import { CoreEmitter } from '../events/index.js'
import { ClientRegistry } from './clients.js'
import { ControlServer } from './control.js'
import type { ControlServerDeps, ControlSnapshot, SessionSummary } from './control.js'
import { fakeSettingsControl } from '../../test/helpers/fake-settings-control.js'
import type { FakeSettingsControl } from '../../test/helpers/fake-settings-control.js'
import type { CtxIncreaseResult } from '../runtime/llamacpp/runtime.js'
import type { BackendControl, ModelControl } from './control.js'
import { HardwareOverrideStore } from '../hardware/index.js'

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
  settings: FakeSettingsControl
  hardware: HardwareOverrideStore
  backends: BackendControl
  models: ModelControl
  ctxIncrease: CtxIncreaseResult
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
    settings: fakeSettingsControl({ 'llamacpp-upstream': { ctx_size: 4096 } }),
    hardware: new HardwareOverrideStore(),
    backends: {
      list: async () => [],
      install: async (_provider: string, version: string, backend: string) => ({
        version,
        backend,
        installed: true,
        path: '/tmp/pack',
      }),
      remove: async () => true,
      cancel: () => false,
      getOptimal: async () => ({ revision: 0, optimal: null }),
      setOptimal: async () => ({ status: 'updated', current: { revision: 1, optimal: null } }),
      optimalSnapshot: () => ({}),
    },
    models: {
      capabilities: async (_provider: string, modelId: string) => ({
        modelId,
        mmprojExists: false,
        isEmbedding: false,
        vision: false,
        audio: false,
        gemmaMtp: false,
        dflash: false,
        dflashDrafts: [],
      }),
      validateGguf: async (path: string) => ({ isValid: !path.endsWith('.txt') }),
      devices: async () => [],
      embed: async (_provider: string, modelId: string) => ({
        model: modelId,
        object: 'list',
        usage: { prompt_tokens: 0, total_tokens: 0 },
        data: [],
      }),
    },
    ctxIncrease: { ok: true, new_ctx_len: 32768, session: session() },
  } as unknown as Harness
  const server = await ControlServer.start({
    token: TOKEN,
    instanceId: 'instance-under-test',
    version: '9.9.9',
    dataFolder: '/tmp/data',
    emitter,
    clients,
    settings: harness.settings,
    hardware: harness.hardware,
    backends: harness.backends,
    models: harness.models,
    externalSessions: {
      publish: (_owner: string, generation: number) => ({ generation, sessions: 0 }),
      heartbeat: () => ({ alive: true }),
      unregister: () => true,
      list: () => [],
      answerCtx: () => false,
    },
    cloud: {
      list: () => [],
      upsert: async (input) => ({
        provider: input.provider,
        base_url: input.base_url ?? null,
        custom_headers: input.custom_headers ?? [],
        models: input.models ?? [],
        has_api_key: typeof input.api_key === 'string' && input.api_key !== '',
      }),
      remove: async () => {},
    },
    chatgpt: {
      status: async () => ({ connected: false, email: null, plan_type: null, expires_at: null }),
      startLogin: async () => ({ authorize_url: 'https://auth.example/authorize' }),
      waitLogin: async () => ({ connected: true, email: 'u@example.test', plan_type: 'plus', expires_at: 1 }),
      cancelLogin: () => {},
      logout: async () => ({ connected: false, email: null, plan_type: null, expires_at: null }),
      models: async () => [],
    },
    recreateSession: async (_provider: string, modelId: string) =>
      modelId === 'gone' ? { ok: false, reason: 'not-loaded' } : { ok: true },
    increaseCtx: async (provider, modelId, reason) => {
      calls.push(`increaseCtx ${provider} ${modelId} ${reason ?? '-'}`)
      return harness.ctxIncrease
    },
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
      setInspecting: (enabled: boolean) => {
        calls.push(`inspector ${enabled}`)
      },
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

  it('captures optimal state and cursor in the same snapshot', async () => {
    h.backends.optimalSnapshot = () => ({ 'llamacpp-upstream': { revision: 7, optimal: null } })
    h.emitter.emit('backend:optimal-changed', { provider: 'llamacpp-upstream', revision: 7, optimal: null })
    const snapshot = (await (await h.get('/atomic/v1/snapshot')).json()) as ControlSnapshot
    expect(snapshot.optimal_backends['llamacpp-upstream']).toEqual({ revision: 7, optimal: null })
    expect(snapshot.cursor).toBe(h.emitter.cursor())
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

describe('settings routes', () => {
  const json = (path: string, method: string, body: unknown) =>
    h.get(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('reads a provider’s values with the revision and migration record', async () => {
    const res = await h.get('/atomic/v1/settings/llamacpp-upstream')
    const body = (await res.json()) as {
      provider: string
      revision: number
      values: Record<string, unknown>
      migration: unknown
    }

    expect(res.status).toBe(200)
    expect(body.provider).toBe('llamacpp-upstream')
    expect(body.values['ctx_size']).toBe(4096)
    expect(body.revision).toBe(7)
    expect(body.migration, 'never imported yet').toBeNull()
  })

  it('patches values and passes the expected revision through', async () => {
    const res = await json('/atomic/v1/settings/llamacpp-upstream', 'PATCH', {
      values: { ctx_size: 8192 },
      expected_revision: 7,
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ revision: 8, changed: ['ctx_size'] })
    expect(h.settings.calls).toContain('update llamacpp-upstream {"ctx_size":8192} expected=7')
  })

  it('treats omitted patch values and revision as an empty unconditional patch', async () => {
    const res = await json('/atomic/v1/settings/llamacpp-upstream', 'PATCH', {})

    expect(res.status).toBe(200)
    expect(h.settings.calls.at(-1)).toBe('update llamacpp-upstream {} expected=any')
  })

  it('imports the app’s settings and reports what it applied', async () => {
    const res = await json('/atomic/v1/settings/llamacpp-upstream/import', 'POST', {
      values: { ctx_size: 8192, n_gpu_layers: 20 },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'imported', applied: ['ctx_size', 'n_gpu_layers'] })
  })

  it('answers 409 for a conflict, so the caller cannot mistake it for a migrated scope', async () => {
    h.settings.nextImport = {
      status: 'conflict',
      applied: [],
      conflicts: [{ key: 'ctx_size', base: 4096, core: 2048, legacy: 8192 }],
      revision: 7,
    }

    const res = await json('/atomic/v1/settings/llamacpp-upstream/import', 'POST', {
      values: { ctx_size: 8192 },
    })

    expect(res.status).toBe(409)
    expect((await res.json()) as { conflicts: unknown[] }).toMatchObject({
      status: 'conflict',
      conflicts: [{ key: 'ctx_size' }],
    })
  })

  it('forwards the caller’s conflict resolutions', async () => {
    await json('/atomic/v1/settings/llamacpp-upstream/import', 'POST', {
      values: { ctx_size: 8192 },
      resolutions: { ctx_size: 'core' },
    })

    expect(h.settings.calls.at(-1)).toContain('resolutions={"ctx_size":"core"}')
  })

  it('passes an import revision even when the legacy payload has no values', async () => {
    const res = await json('/atomic/v1/settings/llamacpp-upstream/import', 'POST', {
      expected_revision: 7,
    })

    expect(res.status).toBe(200)
    expect(h.settings.calls.at(-1)).toContain('import llamacpp-upstream {}')
    expect(h.settings.calls.at(-1)).toContain('expected=7')
  })

  it('records an acknowledgement and refuses one without a revision', async () => {
    const ok = await json('/atomic/v1/settings/llamacpp-upstream/acknowledge', 'POST', { revision: 8 })
    expect(ok.status).toBe(200)
    expect(h.settings.calls).toContain('acknowledge llamacpp-upstream 8')

    const bad = await json('/atomic/v1/settings/llamacpp-upstream/acknowledge', 'POST', {})
    expect(bad.status).toBe(400)
    expect((await bad.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'INVALID_ARGUMENT' },
    })
  })
})

describe('context increase route', () => {
  it('reloads a model one step up and returns the new session', async () => {
    const res = await h.get('/atomic/v1/models/llamacpp-upstream/vendor/model-7b/ctx/increase', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'proxy-overflow' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, new_ctx_len: 32768 })
    expect(h.calls).toContain('increaseCtx llamacpp-upstream vendor/model-7b proxy-overflow')
  })

  it('answers 200 with a reason when it declines, not an error', async () => {
    // The proxy branches on this: "the ladder is at its top" means stop retrying and return the
    // model's own overflow error, which is not the same as a reload that failed.
    h.ctxIncrease = { ok: false, reason: 'at_max', current_ctx_len: 8192, max_ctx_len: 8192 }

    const res = await h.get('/atomic/v1/models/llamacpp-upstream/m/ctx/increase', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: false,
      reason: 'at_max',
      current_ctx_len: 8192,
      max_ctx_len: 8192,
    })
  })
})

describe('hardware override routes', () => {
  const put = (body: unknown) =>
    h.get('/atomic/v1/hardware/override', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('accepts what the app measured and reads it back', async () => {
    const gpus = [{ vendor: 'NVIDIA', driver_version: '551.23', nvidia_info: { compute_capability: '8.9' } }]

    const stored = await put({ gpus, cpu_extensions: ['AVX2'], source: 'tauri-plugin-hardware' })
    expect(stored.status).toBe(200)

    const read = (await (await h.get('/atomic/v1/hardware/override')).json()) as {
      override: { gpus: unknown[]; cpu_extensions: string[]; source: string }
    }
    expect(read.override.gpus).toEqual(gpus)
    expect(read.override.cpu_extensions).toEqual(['avx2'])
    expect(read.override.source).toBe('tauri-plugin-hardware')
  })

  it('reports no override before the app injects one', async () => {
    const read = (await (await h.get('/atomic/v1/hardware/override')).json()) as { override: unknown }

    expect(read.override).toBeNull()
  })

  it('refuses a payload it cannot read', async () => {
    const res = await put({ cpu_extensions: ['avx2'] })

    expect(res.status).toBe(400)
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'INVALID_ARGUMENT' },
    })
  })

  it('can be cleared, which puts the core back on its own probe', async () => {
    await put({ gpus: [] })

    const cleared = await h.get('/atomic/v1/hardware/override', { method: 'DELETE' })

    expect(await cleared.json()).toEqual({ cleared: true })
    expect(
      ((await (await h.get('/atomic/v1/hardware/override')).json()) as { override: unknown }).override
    ).toBeNull()
  })
})

describe('backend routes', () => {
  it('lists installed packs and passes the selected one through', async () => {
    const seen: string[] = []
    h.backends.list = async (provider: string, current?: string) => {
      seen.push(`${provider} ${current ?? ''}`)
      return [{ version: 'b6325', backend: 'macos-arm64', path: '/packs/b6325', active: true }]
    }

    const res = await h.get('/atomic/v1/backends/llamacpp-upstream?current=b6325/macos-arm64')

    expect(res.status).toBe(200)
    expect((await res.json()) as { backends: unknown[] }).toMatchObject({
      backends: [{ version: 'b6325', active: true }],
    })
    expect(seen).toEqual(['llamacpp-upstream b6325/macos-arm64'])
  })

  it('installs under the task id the caller named', async () => {
    // The progress bar listens on a name built from this id; the core must not invent its own.
    const res = await h.get('/atomic/v1/backends/llamacpp-upstream/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'b6325', backend: 'macos-arm64', task_id: 'install-1' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ version: 'b6325', installed: true })
  })

  it('refuses an install that does not say what to install or under which task', async () => {
    const missing = await h.get('/atomic/v1/backends/llamacpp-upstream/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'b6325' }),
    })

    expect(missing.status).toBe(400)
    expect((await missing.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'INVALID_ARGUMENT' },
    })
  })

  it('removes a pack and says whether there was one', async () => {
    const res = await h.get('/atomic/v1/backends/llamacpp-upstream/b6325/macos-arm64', {
      method: 'DELETE',
    })

    expect(await res.json()).toEqual({ removed: true })
  })

  it('passes proxy policy to install without changing its response', async () => {
    let seen: unknown
    h.backends.install = async (_provider, version, backend, options) => {
      seen = options.proxy
      return { version, backend, installed: true, path: '/pack' }
    }
    const res = await h.get('/atomic/v1/backends/llamacpp-upstream/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 'b1',
        backend: 'macos-arm64',
        task_id: 't',
        proxy: { url: 'http://proxy:8080' },
      }),
    })
    expect(res.status).toBe(200)
    expect(seen).toEqual({ url: 'http://proxy:8080' })
  })

  it('passes the TurboQuant asset name through, and ignores an empty one', async () => {
    const seen: unknown[] = []
    h.backends.install = async (_provider, version, backend, options) => {
      seen.push(options.assetName)
      return { version, backend, installed: true, path: '/pack' }
    }
    for (const asset_name of ['llama-turboquant-macos-arm64.tar.gz', '']) {
      await h.get('/atomic/v1/backends/llamacpp/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: 'b10018-1.3.0', backend: 'macos-arm64', task_id: 't', asset_name }),
      })
    }
    expect(seen).toEqual(['llama-turboquant-macos-arm64.tar.gz', undefined])
  })

  it('cancels the task id that owns the UI row', async () => {
    let seen = ''
    h.backends.cancel = (taskId) => {
      seen = taskId
      return true
    }
    const res = await h.get('/atomic/v1/downloads/llamacpp-backend-b1/macos-arm64/cancel', { method: 'POST' })
    expect(await res.json()).toEqual({ cancelled: true })
    expect(seen).toBe('llamacpp-backend-b1/macos-arm64')
  })

  it('returns revisioned optimal state and refuses an obsolete write with 409', async () => {
    h.backends.getOptimal = async () => ({ revision: 2, optimal: null })
    h.backends.setOptimal = async () => ({ status: 'conflict', current: { revision: 2, optimal: null } })
    expect(await (await h.get('/atomic/v1/backends/llamacpp-upstream/optimal')).json()).toEqual({
      revision: 2,
      optimal: null,
    })
    const res = await h.get('/atomic/v1/backends/llamacpp-upstream/optimal', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optimal: null, expected_revision: 1 }),
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ status: 'conflict', current: { revision: 2, optimal: null } })
  })
})

describe('model capability routes', () => {
  it('delegates embeddings with input and ubatch size intact', async () => {
    let seen: unknown
    h.models.embed = async (provider, modelId, input, ubatchSize) => {
      seen = { provider, modelId, input, ubatchSize }
      return {
        model: modelId,
        object: 'list',
        usage: { prompt_tokens: 1, total_tokens: 1 },
        data: [{ embedding: [1], index: 0 }],
      }
    }
    const res = await h.get('/atomic/v1/models/llamacpp-upstream/sentence-transformer-mini/embed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: ['hello'], ubatch_size: 64 }),
    })
    expect(res.status).toBe(200)
    expect(seen).toEqual({
      provider: 'llamacpp-upstream',
      modelId: 'sentence-transformer-mini',
      input: ['hello'],
      ubatchSize: 64,
    })
    expect(await res.json()).toMatchObject({ object: 'list', data: [{ index: 0 }] })
  })
  it('answers what a model is without loading it', async () => {
    const res = await h.get('/atomic/v1/models/llamacpp-upstream/vendor/model-7b/capabilities')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ modelId: 'vendor/model-7b', isEmbedding: false })
  })

  it('answers "not a model" with 200, because that is the answer to the question asked', async () => {
    // The user pointed at a file. Rendering "not a model" is the caller's job; a 4xx would make it
    // look like the request was malformed.
    const res = await h.get('/atomic/v1/gguf/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/x/notes.txt' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ isValid: false })
  })

  it('refuses a validate that names no file', async () => {
    const res = await h.get('/atomic/v1/gguf/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
  })

  it('lists devices, defaulting to the provider the core owns first', async () => {
    const asked: string[] = []
    h.models.devices = async (provider: string) => {
      asked.push(provider)
      return []
    }

    await h.get('/atomic/v1/hardware/devices')
    await h.get('/atomic/v1/hardware/devices?provider=llamacpp')

    expect(asked).toEqual(['llamacpp-upstream', 'llamacpp'])
  })
})

describe('foundation models availability', () => {
  it('answers the runtime token, forwarding force', async () => {
    const asked: boolean[] = []
    h.server.close()
    h = await start({
      foundationModelsAvailability: async (force) => {
        asked.push(force)
        return 'appleIntelligenceNotEnabled'
      },
    })
    expect(await (await h.get('/atomic/v1/runtimes/foundation-models/availability')).json()).toEqual({
      status: 'appleIntelligenceNotEnabled',
    })
    await h.get('/atomic/v1/runtimes/foundation-models/availability?force=1')
    expect(asked).toEqual([false, true])
  })

  it('says unavailable where the runtime does not exist', async () => {
    expect(await (await h.get('/atomic/v1/runtimes/foundation-models/availability')).json()).toEqual({
      status: 'unavailable',
    })
  })
})

describe('settings status', () => {
  it('reports a scope that has never been imported as not migrated', async () => {
    const body = (await (await h.get('/atomic/v1/settings/status')).json()) as {
      revision: number
      scopes: Record<string, { migrated: boolean; in_sync: boolean }>
    }

    expect(body.scopes['llamacpp-upstream']).toMatchObject({ migrated: false, in_sync: false })
  })

  it('reports a migrated scope, and whether the app has confirmed it saw the result', async () => {
    // The runtime flag must not be turned on for a scope that is not migrated: the core would load
    // with its own defaults instead of the user's.
    h.settings.migrations['llamacpp-upstream'] = {
      baseline: { ctx_size: 8192 },
      legacy_hash: 'abc',
      acknowledged_revision: 7,
    }

    const body = (await (await h.get('/atomic/v1/settings/status')).json()) as {
      scopes: Record<string, { migrated: boolean; in_sync: boolean; acknowledged_revision: number }>
    }

    expect(body.scopes['llamacpp-upstream']).toMatchObject({
      migrated: true,
      acknowledged_revision: 7,
      in_sync: true,
    })
  })

  it('reports a scope whose mirror has fallen behind as out of sync', async () => {
    h.settings.migrations['llamacpp-upstream'] = {
      baseline: {},
      legacy_hash: 'abc',
      acknowledged_revision: 3,
    }

    const body = (await (await h.get('/atomic/v1/settings/status')).json()) as {
      scopes: Record<string, { migrated: boolean; in_sync: boolean }>
    }

    expect(body.scopes['llamacpp-upstream']).toMatchObject({ migrated: true, in_sync: false })
  })
})

describe('cloud and auth routes', () => {
  it('maps a missing subscription to 401 and a failed sign-in to 502 with the error envelope', async () => {
    const { AtomicCoreError } = await import('../contracts/index.js')
    const server = await start({
      chatgpt: {
        status: async () => ({ connected: false, email: null, plan_type: null, expires_at: null }),
        startLogin: async () => {
          throw new AtomicCoreError('IO_ERROR', 'cannot listen on 127.0.0.1:1455 for the sign-in callback')
        },
        waitLogin: async () => {
          throw new AtomicCoreError('AUTH_FAILED', 'callback state did not match this sign-in')
        },
        cancelLogin: () => {},
        logout: async () => ({ connected: false, email: null, plan_type: null, expires_at: null }),
        models: async () => {
          throw new AtomicCoreError('AUTH_REQUIRED', 'no ChatGPT subscription is connected')
        },
      },
    })
    try {
      const models = await server.get('/atomic/v1/auth/chatgpt/models')
      expect(models.status).toBe(401)
      expect(await models.json()).toEqual({
        error: { code: 'AUTH_REQUIRED', message: 'no ChatGPT subscription is connected' },
      })
      expect((await server.get('/atomic/v1/auth/chatgpt/login/wait', { method: 'POST' })).status).toBe(502)
      expect((await server.get('/atomic/v1/auth/chatgpt/login', { method: 'POST' })).status).toBe(500)
      expect(
        (await server.get('/atomic/v1/cloud/providers', { headers: { authorization: 'Bearer nope' } })).status
      ).toBe(401)
    } finally {
      await server.server.close()
    }
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
