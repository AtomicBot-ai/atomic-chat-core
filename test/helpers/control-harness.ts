/**
 * A real `ControlServer` on a loopback port, wired to in-memory fakes that record what they were
 * asked. Shared by the control server's own tests and every route-family test next to it: each test
 * file starts one harness per test and closes it afterwards.
 */

import type { LocalApiServerState, SessionInfo, UnloadResult } from '../../src/contracts/index.js'
import { CoreEmitter } from '../../src/events/index.js'
import { HardwareOverrideStore } from '../../src/hardware/index.js'
import type { CtxIncreaseResult } from '../../src/runtime/llamacpp/runtime.js'
import { ClientRegistry } from '../../src/server/clients.js'
import { ControlServer } from '../../src/server/control/index.js'
import type {
  BackendControl,
  ControlServerDeps,
  ModelControl,
  SessionSummary,
} from '../../src/server/control/index.js'
import { fakeSettingsControl } from './fake-settings-control.js'
import type { FakeSettingsControl } from './fake-settings-control.js'

export const CONTROL_TOKEN = 'test-control-token'

export interface ControlHarness {
  server: ControlServer
  emitter: CoreEmitter
  clients: ClientRegistry
  sessions: SessionSummary[]
  serverState: LocalApiServerState
  calls: string[]
  loadResult: () => Promise<SessionInfo>
  /** What `POST …/load/cancel` answers; tests flip it to model "nothing was pending". */
  cancelLoadResult: boolean
  unloadResult: () => Promise<UnloadResult>
  shutdowns: Array<{ force: boolean; requestedBy?: string | undefined }>
  settings: FakeSettingsControl
  hardware: HardwareOverrideStore
  backends: BackendControl
  models: ModelControl
  ctxIncrease: CtxIncreaseResult
  /** What `POST /disk/available` answers; `null` models a platform that cannot say. */
  diskBytes: number | null
  /** What `GET /lan-addresses` answers. */
  lanAddresses: string[]
  get: (path: string, init?: RequestInit) => Promise<Response>
}

export const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  pid: 111,
  port: 3456,
  model_id: 'demo',
  model_path: '/models/demo.gguf',
  is_embedding: false,
  api_key: 'session-key',
  provider: 'llamacpp-upstream',
  ...over,
})

export async function startControlHarness(over: Partial<ControlServerDeps> = {}): Promise<ControlHarness> {
  const emitter = new CoreEmitter({ instanceId: 'instance-under-test' })
  const clients = new ClientRegistry()
  const sessions: SessionSummary[] = []
  const calls: string[] = []
  const shutdowns: ControlHarness['shutdowns'] = []
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
    cancelLoadResult: true,
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
    diskBytes: 5_000_000_000,
    lanAddresses: ['192.168.1.5', '10.0.0.9'],
  } as unknown as ControlHarness
  const server = await ControlServer.start({
    token: CONTROL_TOKEN,
    instanceId: 'instance-under-test',
    version: '9.9.9',
    dataFolder: '/tmp/data',
    emitter,
    clients,
    settings: harness.settings,
    hardware: harness.hardware,
    backends: harness.backends,
    disk: {
      available: async (path) => {
        calls.push(`disk ${JSON.stringify(path)}`)
        return harness.diskBytes
      },
    },
    models: harness.models,
    remoteAccess: { lanAddresses: async () => harness.lanAddresses },
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
    cancelModelLoad: (provider, modelId) => {
      calls.push(`cancel-load ${provider} ${modelId}`)
      return harness.cancelLoadResult
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
      headers: { authorization: `Bearer ${CONTROL_TOKEN}`, ...(init.headers ?? {}) },
    })
  return harness
}
