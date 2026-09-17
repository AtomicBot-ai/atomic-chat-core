/**
 * Driven against a real `ControlServer` over a real socket: a client that only type-checks against
 * the route table proves nothing about the wire. The module under test stays fetch-only; this test
 * file imports the server (and through it `node:http`), which never ships to a browser.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LocalApiServerState, SessionInfo } from '../contracts/index.js'
import { CoreEmitter } from '../events/index.js'
import { ClientRegistry } from '../server/clients.js'
import { ControlServer } from '../server/control/index.js'
import { CoreClient } from './control-client.js'
import { fakeSettingsControl } from '../../test/helpers/fake-settings-control.js'
import { HardwareOverrideStore } from '../hardware/index.js'
import { CORE_VERSION } from '../version.js'

const TOKEN = 'client-test-token'

let server: ControlServer
let client: CoreClient
let emitter: CoreEmitter
let clients: ClientRegistry
let sessions: Array<SessionInfo & { provider: 'llamacpp-upstream' }>
let serverState: LocalApiServerState
let shutdowns: number
let loadFailure: Error | undefined
let inspecting = false

beforeEach(async () => {
  emitter = new CoreEmitter({ instanceId: 'client-test-instance' })
  clients = new ClientRegistry()
  sessions = []
  shutdowns = 0
  loadFailure = undefined
  serverState = {
    running: false,
    host: '127.0.0.1',
    port: 1337,
    prefix: '/v1',
    requires_api_key: false,
    pid: null,
  }
  server = await ControlServer.start({
    token: TOKEN,
    instanceId: 'client-test-instance',
    version: CORE_VERSION,
    dataFolder: '/tmp/data',
    emitter,
    clients,
    recreateSession: async (_provider: string, modelId: string) =>
      modelId === 'gone' ? { ok: false, reason: 'not-loaded' } : { ok: true },
    increaseCtx: async () => ({ ok: false, reason: 'not-loaded' as const }),
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
    backends: {
      list: async () => [],
      install: async (_p: string, version: string, backend: string) => ({
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
      embed: async (_provider, modelId) => ({
        model: modelId,
        object: 'list',
        usage: { prompt_tokens: 0, total_tokens: 0 },
        data: [],
      }),
    },
    hardware: new HardwareOverrideStore(),
    settings: fakeSettingsControl(),
    sessions: () => sessions,
    loadModel: async (_provider, modelId) => {
      if (loadFailure) throw loadFailure
      const session: SessionInfo & { provider: 'llamacpp-upstream' } = {
        pid: 7,
        port: 3456,
        model_id: modelId,
        model_path: `/models/${modelId}.gguf`,
        is_embedding: false,
        api_key: 'k',
        provider: 'llamacpp-upstream',
      }
      sessions.push(session)
      return session
    },
    cancelModelLoad: (_provider, modelId) => modelId === 'Owner/Loading-GGUF',
    disk: { available: async (path) => (path === undefined ? 42 : null) },
    remoteAccess: { lanAddresses: async () => ['192.168.1.5'] },
    unloadModel: async (_provider, modelId) => {
      sessions = sessions.filter((s) => s.model_id !== modelId)
      return { success: true }
    },
    publicServer: {
      setInspecting: (enabled: boolean) => {
        inspecting = enabled
      },
      status: () => ({ ...serverState }),
      start: async (options) => {
        Object.assign(serverState, { running: true, ...options, pid: process.pid })
        return { ...serverState }
      },
      stop: async () => {
        Object.assign(serverState, { running: false, pid: null })
        return { ...serverState }
      },
    },
    shutdown: async () => {
      shutdowns++
    },
  })
  client = new CoreClient({ baseUrl: server.url, token: TOKEN, name: 'cli-under-test' })
})
afterEach(() => server.close())

describe('handshake and registration', () => {
  it('reads health, snapshot and registers with a heartbeat interval', async () => {
    expect(await client.health()).toMatchObject({ ok: true, version: CORE_VERSION, protocol: 1 })
    const snapshot = await client.handshake()
    expect(snapshot.instance_id).toBe('client-test-instance')
    expect(snapshot.cursor).toBe('client-test-instance:0')

    const registration = await client.register(process.pid)
    expect(registration.client.name).toBe('cli-under-test')
    expect(registration.heartbeat_interval_ms).toBeGreaterThan(0)
    expect(await client.heartbeat(registration.client.id)).toEqual({ ok: true })
    expect(await client.unregister(registration.client.id)).toEqual({ ok: true })
    expect(clients.list()).toEqual([])
  })

  it('refuses an owner whose protocol differs', async () => {
    const older = new CoreClient({ baseUrl: server.url, token: TOKEN })
    const original = CoreClient.prototype.snapshot
    CoreClient.prototype.snapshot = async () => ({ ...(await original.call(older)), protocol: 99 })
    try {
      await expect(older.handshake()).rejects.toMatchObject({
        code: 'CORE_PROTOCOL_MISMATCH',
        details: expect.stringContaining('core protocol 99') as unknown as string,
      })
    } finally {
      CoreClient.prototype.snapshot = original
    }
  })

  it('rejects an incompatible version or ownership scope even with the same wire protocol', async () => {
    const original = CoreClient.prototype.snapshot
    CoreClient.prototype.snapshot = async () => ({ ...(await original.call(client)), version: '0.1.0' })
    try {
      await expect(client.handshake('cli')).rejects.toMatchObject({
        code: 'CORE_PROTOCOL_MISMATCH',
        details: expect.stringContaining('0.1.0') as unknown as string,
      })
    } finally {
      CoreClient.prototype.snapshot = original
    }
    await expect(client.handshake('app')).rejects.toMatchObject({
      code: 'CORE_PROTOCOL_MISMATCH',
      details: expect.stringContaining('expected') as unknown as string,
    })
  })
})

describe('failures', () => {
  it('turns a wrong token into UNAUTHORIZED and an unreachable core into CORE_NOT_RUNNING', async () => {
    const wrong = new CoreClient({ baseUrl: server.url, token: 'nope' })
    await expect(wrong.health()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    const gone = new CoreClient({ baseUrl: 'http://127.0.0.1:1', token: TOKEN })
    await expect(gone.health()).rejects.toMatchObject({
      code: 'CORE_NOT_RUNNING',
      message: expect.stringContaining('Cannot reach') as unknown as string,
    })
  })

  it('rethrows the code the core sent for a failed load', async () => {
    loadFailure = Object.assign(new Error('Model not installed'), { code: 'MODEL_NOT_FOUND' })
    await expect(client.loadModel('llamacpp-upstream', 'ghost')).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
      message: 'Model not installed',
    })
  })
})

describe('sessions and public server', () => {
  it('loads, lists and unloads through the control API', async () => {
    const session = await client.loadModel('llamacpp-upstream', 'Owner/Repo-GGUF', { is_embedding: false })
    expect(session).toMatchObject({ model_id: 'Owner/Repo-GGUF', port: 3456 })
    expect((await client.sessions()).sessions.map((s) => s.model_id)).toEqual(['Owner/Repo-GGUF'])
    expect(await client.unloadModel('llamacpp-upstream', 'Owner/Repo-GGUF')).toEqual({ success: true })
    expect((await client.sessions()).sessions).toEqual([])
  })

  it('starts, reads and stops the public listener', async () => {
    expect(await client.serverStatus()).toMatchObject({ running: false })
    expect(await client.startServer({ host: '127.0.0.1', port: 8081, api_key: 'k' })).toMatchObject({
      running: true,
      port: 8081,
    })
    expect(await client.stopServer()).toMatchObject({ running: false })
  })

  it('asks the core to shut down', async () => {
    expect(await client.shutdown({ force: true })).toMatchObject({ ok: true })
    await new Promise((r) => setTimeout(r, 50))
    expect(shutdowns).toBe(1)
  })
})

describe('event stream', () => {
  it('parses frames into typed messages and stops on abort', async () => {
    const seen: Array<{ event: string; id: string }> = []
    const controller = new AbortController()
    // Subscribing with the current cursor removes the race between "the stream is open" and "the
    // event happened": anything after the cursor is replayed, anything later arrives live.
    const cursor = emitter.cursor()
    const streaming = client.events((message) => seen.push({ event: message.event, id: message.id }), {
      cursor,
      signal: controller.signal,
    })
    emitter.emit('server:started', { host: '127.0.0.1', port: 1337 })
    await waitFor(() => seen.length > 0)
    expect(seen[0]).toMatchObject({ event: 'server:started', id: 'client-test-instance:1' })
    controller.abort()
    await expect(streaming).rejects.toThrow()
  })

  it('replays from a cursor and reports a resync for a foreign one', async () => {
    emitter.emit('server:started', { host: '127.0.0.1', port: 1337 })
    emitter.emit('server:stopped', {})
    const replayed: string[] = []
    const first = new AbortController()
    void client
      .events((m) => replayed.push(m.event), { cursor: 'client-test-instance:1', signal: first.signal })
      .catch(() => {})
    await waitFor(() => replayed.length > 0)
    expect(replayed).toEqual(['server:stopped'])
    first.abort()

    const resync: string[] = []
    const second = new AbortController()
    void client
      .events((m) => resync.push(m.event), { cursor: 'other-instance:9', signal: second.signal })
      .catch(() => {})
    await waitFor(() => resync.length > 0)
    expect(resync).toEqual(['resync'])
    second.abort()
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('cloud providers and the ChatGPT subscription', () => {
  it('registers, lists and removes a cloud provider without ever reading a key back', async () => {
    expect(
      await client.setCloudProvider('openai', {
        api_key: 'sk',
        base_url: 'https://api.openai.com/v1',
        models: ['gpt-4o'],
      })
    ).toEqual({
      provider: 'openai',
      base_url: 'https://api.openai.com/v1',
      custom_headers: [],
      models: ['gpt-4o'],
      has_api_key: true,
    })
    expect(await client.cloudProviders()).toEqual({ providers: [] })
    expect(await client.removeCloudProvider('open/ai')).toEqual({ removed: true })
  })

  it('walks a sign-in through start, wait and cancel, and reads status, models and logout', async () => {
    expect(await client.chatgptStatus()).toMatchObject({ connected: false })
    expect(await client.chatgptStartLogin()).toEqual({ authorize_url: 'https://auth.example/authorize' })
    expect(await client.chatgptWaitLogin()).toMatchObject({ connected: true, email: 'u@example.test' })
    expect(await client.chatgptCancelLogin()).toEqual({ cancelled: true })
    expect(await client.chatgptModels()).toEqual({ models: [] })
    expect(await client.chatgptLogout()).toMatchObject({ connected: false })
  })
})

describe('inspector gate', () => {
  it('tells the core when the API screen starts and stops watching', async () => {
    expect(await client.setInspecting(true)).toEqual({ enabled: true })
    expect(inspecting).toBe(true)
    await client.setInspecting(false)
    expect(inspecting).toBe(false)
  })
})

describe('disk space', () => {
  it('asks for the data folder by default, for a path when given one, and passes an unknown through', async () => {
    expect(await client.availableDiskSpace()).toBe(42)
    expect(await client.availableDiskSpace('/data/diffusion/models')).toBeNull()
  })
})

describe('LAN addresses', () => {
  it('lists what a device on the network can dial', async () => {
    expect(await client.lanAddresses()).toEqual(['192.168.1.5'])
  })
})

describe('load cancellation', () => {
  it('reports whether a load was pending, for a model id with slashes', async () => {
    expect(await client.cancelModelLoad('llamacpp-upstream', 'Owner/Loading-GGUF')).toBe(true)
    expect(await client.cancelModelLoad('llamacpp-upstream', 'Owner/Idle-GGUF')).toBe(false)
  })
})

describe('recreate', () => {
  it('asks the core to restart a poisoned engine and reports a model it does not hold', async () => {
    expect(await client.recreateSession('llamacpp-upstream', 'Owner/Repo-GGUF')).toEqual({ ok: true })
    expect(await client.recreateSession('llamacpp-upstream', 'gone')).toEqual({
      ok: false,
      reason: 'not-loaded',
    })
  })
})
