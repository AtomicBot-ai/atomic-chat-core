/**
 * The control API (`/atomic/v1/*`, PLAN.md §3.6): how the app and the CLI drive a core they did not
 * start. It is deliberately not the inference API — it binds loopback only, always requires the
 * control token, refuses non-loopback `Host` headers (the DNS-rebinding guard that lets a browser
 * page talk to a local port), and sends no CORS headers at all.
 *
 * Stopping the public listener never touches this one: that separation is what keeps a core
 * manageable while its `/v1` surface is down.
 */

import type { CloudProviderInput, CloudProviderView, SubscriptionModel } from '../cloud/index.js'
import type { ChatGptStatus } from '../credentials/index.js'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { AtomicCoreError, CONTROL_API_PREFIX, CONTROL_PROTOCOL_VERSION } from '../contracts/index.js'
import { LOCAL_PROVIDER_IDS } from '../settings/index.js'
import type {
  CoreEventRecord,
  DeviceInfo,
  LocalApiServerState,
  LocalProviderId,
  SessionInfo,
  UnloadResult,
} from '../contracts/index.js'
import type { CoreEmitter } from '../events/index.js'
import type { CtxIncreaseResult } from '../runtime/llamacpp/runtime.js'
import type { GgufValidation, ModelCapabilities } from '../models/index.js'
import type { EmbeddingResponse } from '../models/index.js'
import type { ProxyConfig } from '../downloads/index.js'
import type { HardwareOverrideInput, HardwareOverrideStore } from '../hardware/index.js'
import type {
  InstallBackendResult,
  InstalledBackendPack,
  OptimalBackendCacheRecord,
} from '../backend/index.js'
import type { OptimalState, OptimalUpdate } from '../backend/index.js'
import { bearerToken, controlTokenMatches } from '../lock/index.js'
import type {
  ImportOptions,
  ImportResult,
  MigrationRecord,
  ProviderValues,
  UpdateResult,
} from '../settings/index.js'
import type { ClientRegistry } from './clients.js'
import { CLIENT_HEARTBEAT_INTERVAL_MS } from './clients.js'
import {
  hostHeaderIsLoopback,
  isLoopbackAddress,
  pathOf,
  queryOf,
  readJsonBody,
  Router,
  sendError,
  sendJson,
} from './http.js'

export const SSE_HEARTBEAT_MS = 15_000

export interface SessionSummary extends SessionInfo {
  provider: LocalProviderId
}

export interface PublicServerControl {
  status: () => LocalApiServerState
  start: (options: {
    host?: string
    port?: number
    prefix?: string
    apiKey?: string
    trustedHosts?: string[]
    proxyTimeoutSecs?: number
    writeStateFile?: boolean
    fallbackPort?: boolean
  }) => Promise<LocalApiServerState>
  stop: () => Promise<LocalApiServerState>
  /**
   * Whether the app's API screen is watching the public server. Previews of prompts and replies are
   * collected only while it is (ATO-113). Survives a server restart, like the app's own inspector.
   */
  setInspecting: (enabled: boolean) => void
}

/**
 * The settings surface the control API exposes. Narrower than `SettingsStore` on purpose: the app
 * reads a provider's values, patches them with a revision, and migrates its own copy across — it has
 * no business writing the migration bookkeeping directly.
 */
export interface SettingsControl {
  get: (provider: LocalProviderId) => ProviderValues
  revision: () => number
  migration: (scope: string) => MigrationRecord | null
  update: (
    provider: LocalProviderId,
    patch: ProviderValues,
    options: { expectedRevision?: number }
  ) => Promise<UpdateResult>
  importProvider: (
    provider: LocalProviderId,
    values: ProviderValues,
    options: ImportOptions
  ) => Promise<ImportResult>
  acknowledge: (scope: string, revision: number) => Promise<UpdateResult>
}

/**
 * The backend surface the app drives. Narrow on purpose: the updater screen installs, removes and
 * lists, and everything else it shows it computes from those three answers.
 */
export interface BackendControl {
  list: (provider: string, currentVersionBackend?: string) => Promise<InstalledBackendPack[]>
  install: (
    provider: string,
    version: string,
    backend: string,
    options: { taskId: string; force?: boolean; proxy?: ProxyConfig | null; assetName?: string }
  ) => Promise<InstallBackendResult>
  remove: (provider: string, version: string, backend: string) => Promise<boolean>
  cancel: (taskId: string) => boolean
  getOptimal: (provider: string) => Promise<OptimalState>
  setOptimal: (
    provider: string,
    record: OptimalBackendCacheRecord | null,
    expectedRevision: number
  ) => Promise<OptimalUpdate>
  optimalSnapshot: () => Record<string, OptimalState>
}

/**
 * The questions the app asks about models it has not loaded. Each answers rather than throws: the
 * caller is usually deciding what to show in a list, and one unreadable file must not empty it.
 */
export interface ModelControl {
  capabilities: (provider: string, modelId: string) => Promise<ModelCapabilities>
  validateGguf: (path: string) => Promise<GgufValidation>
  /** Devices the installed backend reports, which needs a backend to ask. */
  devices: (provider: string) => Promise<DeviceInfo[]>
  embed: (
    provider: string,
    modelId: string,
    input: string[],
    ubatchSize: number
  ) => Promise<EmbeddingResponse>
}

/** Engines another process owns, registered so the public server can route to them (stage 4d). */
export interface ExternalSessionControl {
  publish: (owner: string, generation: number, sessions: unknown) => { generation: number; sessions: number }
  heartbeat: (owner: string, generation: number) => { alive: boolean }
  unregister: (owner: string, generation?: number) => boolean
  list: () => unknown[]
  answerCtx: (owner: string, requestId: string, outcome: unknown) => boolean
}

/** Cloud providers the public server routes to (PLAN.md §4, stage 4c). Keys are never read back. */
export interface CloudControl {
  list: () => CloudProviderView[]
  upsert: (input: CloudProviderInput) => Promise<CloudProviderView>
  remove: (provider: string) => Promise<void>
}

/** The ChatGPT subscription session. Nothing here ever returns a token. */
export interface ChatGptControl {
  status: () => Promise<ChatGptStatus>
  reload?: () => Promise<ChatGptStatus>
  startLogin: () => Promise<{ authorize_url: string }>
  waitLogin: () => Promise<ChatGptStatus>
  cancelLogin: () => void
  logout: () => Promise<ChatGptStatus>
  models: () => Promise<SubscriptionModel[]>
}

export interface ControlServerDeps {
  token: string
  instanceId: string
  version: string
  ownerScope?: 'app' | 'cli'
  dataFolder: string
  emitter: CoreEmitter
  clients: ClientRegistry
  sessions: () => SessionSummary[]
  loadModel: (
    provider: string,
    modelId: string,
    body: Record<string, unknown>
  ) => Promise<SessionInfo | { session: SessionInfo; created: boolean }>
  unloadModel: (provider: string, modelId: string) => Promise<UnloadResult>
  /**
   * Reload a model one context step larger because a request overflowed. Answers rather than
   * throws when it declines: "the ladder is at its top" is an outcome the caller acts on, not an
   * error, and the proxy has to tell it apart from a failed reload.
   */
  increaseCtx: (provider: string, modelId: string, reason?: string) => Promise<CtxIncreaseResult>
  /**
   * Restart a model at the context it already has, because its engine is poisoned (a compute
   * failure). The app's extension asks for this when the core owns the runtime but the app's own
   * proxy saw the failure.
   */
  recreateSession: (provider: string, modelId: string) => Promise<{ ok: boolean; reason?: string }>
  publicServer: PublicServerControl
  /** The settings store, for the routes that read and migrate provider settings (PLAN.md §3.4). */
  settings: SettingsControl
  /** Hardware facts the app injects, which outrank the core's own probe (PLAN.md §2 decision 10). */
  hardware: HardwareOverrideStore
  /** Installing and removing llama.cpp backends (PLAN.md §4, stage 3c). */
  backends: BackendControl
  /** What a model is and can do, without loading it (PLAN.md §4, stage 3d). */
  models: ModelControl
  /**
   * Whether Apple's on-device model can run here: the server's own `--check` token (`available`,
   * `notEligible`, `appleIntelligenceNotEnabled`, `modelNotReady`, `unavailable`, `binaryNotFound`).
   * Answers `unavailable` on a platform without the runtime.
   */
  foundationModelsAvailability?: (force: boolean) => Promise<string>
  cloud: CloudControl
  chatgpt: ChatGptControl
  externalSessions: ExternalSessionControl
  /** Stop the whole core. The server has already answered by the time this runs. */
  shutdown: (options: { force: boolean; requestedBy?: string | undefined }) => Promise<void>
  startedAt?: number
  now?: () => number
}

export interface ControlSnapshot {
  instance_id: string
  owner_scope?: 'app' | 'cli' | undefined
  protocol: number
  version: string
  pid: number
  data_folder: string
  started_at: number
  uptime_ms: number
  cursor: string
  sessions: SessionSummary[]
  server: LocalApiServerState
  clients: ReturnType<ClientRegistry['list']>
  downloads: unknown[]
  optimal_backends: Record<string, OptimalState>
}

export class ControlServer {
  private readonly sseClients = new Set<ServerResponse>()
  private heartbeat: NodeJS.Timeout | undefined

  private constructor(
    private readonly server: Server,
    private readonly deps: ControlServerDeps,
    readonly host: string,
    readonly port: number,
    private readonly detachEmitter: () => void
  ) {}

  get url(): string {
    return `http://${this.host}:${this.port}`
  }

  static async start(
    deps: ControlServerDeps,
    options: { host?: string; port?: number } = {}
  ): Promise<ControlServer> {
    const host = options.host ?? '127.0.0.1'
    // The events route needs the instance that is being constructed, so it reads it through a holder.
    const holder: { instance?: ControlServer } = {}
    const router = buildRouter(deps, () => holder.instance)
    const server = createServer((req, res) => {
      void handle(req, res, router, deps).catch((e) => sendError(res, e))
    })
    // A control connection must never keep the process alive on its own; shutdown is explicit.
    server.on('connection', (socket) => socket.unref?.())
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port ?? 0, host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const detach = deps.emitter.onAny((record) => holder.instance?.broadcast(record))
    const instance = new ControlServer(server, deps, host, port, detach)
    holder.instance = instance
    instance.heartbeat = setInterval(() => instance.ping(), SSE_HEARTBEAT_MS)
    instance.heartbeat.unref?.()
    return instance
  }

  private broadcast(record: CoreEventRecord): void {
    const frame = sseFrame(this.deps.emitter.cursor(record.seq), record.name, record.payload)
    for (const res of this.sseClients) res.write(frame)
  }

  private ping(): void {
    for (const res of this.sseClients) res.write(': ping\n\n')
  }

  /** Registered by the events route; kept private to the module through the holder. */
  attachSse(res: ServerResponse): void {
    this.sseClients.add(res)
    res.on('close', () => this.sseClients.delete(res))
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.detachEmitter()
    for (const res of this.sseClients) res.end()
    this.sseClients.clear()
    this.server.closeAllConnections?.()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

function sseFrame(id: string, event: string, data: unknown): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  router: Router,
  deps: ControlServerDeps
): Promise<void> {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    return sendError(
      res,
      new AtomicCoreError(
        'FORBIDDEN_HOST',
        'The control API answers only on loopback.',
        req.socket.remoteAddress ?? ''
      )
    )
  }
  if (!hostHeaderIsLoopback(req.headers.host)) {
    return sendError(
      res,
      new AtomicCoreError(
        'FORBIDDEN_HOST',
        'Unexpected Host header on the control API.',
        req.headers.host ?? ''
      )
    )
  }
  if (!controlTokenMatches(bearerToken(req.headers.authorization), deps.token)) {
    return sendError(res, new AtomicCoreError('UNAUTHORIZED', 'A valid control token is required.'))
  }
  const path = pathOf(req)
  const found = router.find(req.method ?? 'GET', path)
  if (!found) {
    return sendError(res, new AtomicCoreError('INVALID_ARGUMENT', `No such control route: ${path}`), 404)
  }
  if ('methodMismatch' in found) {
    return sendError(
      res,
      new AtomicCoreError('INVALID_ARGUMENT', `${req.method} is not allowed on ${path}`),
      405
    )
  }
  await found.route.handler(req, res, found.match)
}

function buildRouter(deps: ControlServerDeps, self: () => ControlServer | undefined): Router {
  const now = deps.now ?? Date.now
  const startedAt = deps.startedAt ?? now()
  const p = (suffix: string) => `${CONTROL_API_PREFIX}${suffix}`
  const snapshot = (): ControlSnapshot => ({
    instance_id: deps.instanceId,
    owner_scope: deps.ownerScope,
    protocol: CONTROL_PROTOCOL_VERSION,
    version: deps.version,
    pid: process.pid,
    data_folder: deps.dataFolder,
    started_at: startedAt,
    uptime_ms: now() - startedAt,
    cursor: deps.emitter.cursor(),
    sessions: deps.sessions(),
    server: deps.publicServer.status(),
    clients: deps.clients.list(),
    downloads: [],
    optimal_backends: deps.backends.optimalSnapshot(),
  })

  const router = new Router()

  router.get(p('/health'), (_req, res) => {
    sendJson(res, 200, {
      ok: true,
      pid: process.pid,
      version: deps.version,
      owner_scope: deps.ownerScope,
      instance_id: deps.instanceId,
      protocol: CONTROL_PROTOCOL_VERSION,
      dataFolder: deps.dataFolder,
      uptime_ms: now() - startedAt,
    })
  })

  router.get(p('/snapshot'), (_req, res) => sendJson(res, 200, snapshot()))

  router.get(p('/events'), (req, res) => {
    const cursor = queryOf(req).get('cursor') ?? (req.headers['last-event-id'] as string | undefined) ?? ''
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // Headers must reach the client before any event does: a reader that is waiting for the response
    // would otherwise block until the first event, which may be minutes away.
    res.flushHeaders()
    const afterSeq = cursor ? deps.emitter.parseCursor(cursor) : deps.emitter.lastSeq
    const replay = afterSeq === undefined ? undefined : deps.emitter.replayAfter(afterSeq)
    if (replay === undefined) {
      // Cursor from another instance, or older than the ring: the client must take a fresh snapshot.
      res.write(
        sseFrame(deps.emitter.cursor(), 'resync', { reason: cursor ? 'cursor-expired' : 'no-cursor' })
      )
    } else {
      for (const record of replay)
        res.write(sseFrame(deps.emitter.cursor(record.seq), record.name, record.payload))
    }
    self()?.attachSse(res)
    req.on('close', () => res.end())
  })

  router.post(p('/clients'), async (req, res) => {
    const body = await readJsonBody<{ name?: string; pid?: number }>(req)
    const client = deps.clients.register({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.pid !== undefined ? { pid: body.pid } : {}),
    })
    sendJson(res, 201, {
      client,
      heartbeat_interval_ms: CLIENT_HEARTBEAT_INTERVAL_MS,
      snapshot: snapshot(),
    })
  })

  router.post(p('/clients/:id/heartbeat'), (_req, res, { params }) => {
    const ok = deps.clients.heartbeat(params['id'] as string)
    if (!ok)
      return sendError(
        res,
        new AtomicCoreError('CORE_NOT_RUNNING', 'This client registration has expired; register again.'),
        410
      )
    sendJson(res, 200, { ok: true })
  })

  router.delete(p('/clients/:id'), (_req, res, { params }) => {
    deps.clients.unregister(params['id'] as string)
    sendJson(res, 200, { ok: true })
  })

  router.get(p('/sessions'), (_req, res) => sendJson(res, 200, { sessions: deps.sessions() }))

  router.post(p('/models/:provider/*modelId/load'), async (req, res, { params }) => {
    const body = await readJsonBody<Record<string, unknown>>(req)
    const result = await deps.loadModel(params['provider'] as string, params['modelId'] as string, body)
    sendJson(res, 200, 'session' in result ? result : { session: result, created: true })
  })

  router.post(p('/models/:provider/*modelId/unload'), async (_req, res, { params }) => {
    const result = await deps.unloadModel(params['provider'] as string, params['modelId'] as string)
    sendJson(res, 200, result)
  })

  router.post(p('/models/:provider/*modelId/recreate'), async (_req, res, { params }) => {
    sendJson(res, 200, await deps.recreateSession(params['provider'] as string, params['modelId'] as string))
  })

  router.post(p('/models/:provider/*modelId/ctx/increase'), async (req, res, { params }) => {
    const body = await readJsonBody<{ reason?: string }>(req)
    const result = await deps.increaseCtx(
      params['provider'] as string,
      params['modelId'] as string,
      body.reason
    )
    sendJson(res, 200, result)
  })

  router.get(p('/models/:provider/*modelId/capabilities'), async (_req, res, { params }) => {
    sendJson(
      res,
      200,
      await deps.models.capabilities(params['provider'] as string, params['modelId'] as string)
    )
  })

  router.post(p('/models/:provider/*modelId/embed'), async (req, res, { params }) => {
    const body = await readJsonBody<{ input?: string[]; ubatch_size?: number }>(req)
    sendJson(
      res,
      200,
      await deps.models.embed(
        params['provider'] as string,
        params['modelId'] as string,
        body.input as string[],
        body.ubatch_size ?? 512
      )
    )
  })

  // Answers `{isValid:false, error}` for a file that is not a model: the user pointed at it, and
  // "that is not a model" is the answer to their question, not a failure of the core.
  router.post(p('/gguf/validate'), async (req, res) => {
    const body = await readJsonBody<{ path?: string }>(req)
    if (!body.path) return sendError(res, new AtomicCoreError('INVALID_ARGUMENT', 'validate needs a path'))
    sendJson(res, 200, await deps.models.validateGguf(body.path))
  })

  router.get(p('/runtimes/foundation-models/availability'), async (req, res) => {
    const force = queryOf(req).get('force') === '1'
    const status = deps.foundationModelsAvailability
      ? await deps.foundationModelsAvailability(force)
      : 'unavailable'
    sendJson(res, 200, { status })
  })

  router.get(p('/hardware/devices'), async (req, res) => {
    const provider = queryOf(req).get('provider') ?? 'llamacpp-upstream'
    sendJson(res, 200, { devices: await deps.models.devices(provider) })
  })

  router.get(p('/backends/:provider'), async (req, res, { params }) => {
    const current = queryOf(req).get('current') ?? ''
    sendJson(res, 200, {
      backends: await deps.backends.list(params['provider'] as string, current),
    })
  })

  // The task id comes from the caller, because the app's progress bar listens on an event named
  // after it. A core-invented id would leave that bar stranded.
  router.post(p('/backends/:provider/install'), async (req, res, { params }) => {
    const body = await readJsonBody<{
      version?: string
      backend?: string
      task_id?: string
      force?: boolean
      proxy?: ProxyConfig | null
      /** TurboQuant: the asset name the release index gives this pair. */
      asset_name?: string
    }>(req)
    if (!body.version || !body.backend || !body.task_id)
      return sendError(
        res,
        new AtomicCoreError('INVALID_ARGUMENT', 'install needs version, backend and task_id')
      )
    sendJson(
      res,
      200,
      await deps.backends.install(params['provider'] as string, body.version, body.backend, {
        taskId: body.task_id,
        ...(body.force !== undefined ? { force: body.force } : {}),
        ...(body.proxy !== undefined ? { proxy: body.proxy } : {}),
        ...(typeof body.asset_name === 'string' && body.asset_name ? { assetName: body.asset_name } : {}),
      })
    )
  })

  // Where the detection result lives now. The CLI could not see the webview's `localStorage`;
  // this route gives both clients one revisioned answer. Hardware-change invalidation is separate.
  router.get(p('/backends/:provider/optimal'), async (_req, res, { params }) => {
    sendJson(res, 200, await deps.backends.getOptimal(params['provider'] as string))
  })

  router.put(p('/backends/:provider/optimal'), async (req, res, { params }) => {
    const body = await readJsonBody<{
      optimal?: OptimalBackendCacheRecord | null
      expected_revision?: number
    }>(req)
    if (!Object.hasOwn(body, 'optimal') || body.expected_revision === undefined) {
      return sendError(
        res,
        new AtomicCoreError('INVALID_ARGUMENT', 'optimal and expected_revision are required')
      )
    }
    const result = await deps.backends.setOptimal(
      params['provider'] as string,
      body.optimal ?? null,
      body.expected_revision
    )
    sendJson(res, result.status === 'conflict' ? 409 : 200, result)
  })

  router.post(p('/downloads/*taskId/cancel'), (_req, res, { params }) => {
    sendJson(res, 200, { cancelled: deps.backends.cancel(params['taskId'] as string) })
  })

  router.delete(p('/backends/:provider/:version/:backend'), async (_req, res, { params }) => {
    sendJson(res, 200, {
      removed: await deps.backends.remove(
        params['provider'] as string,
        params['version'] as string,
        params['backend'] as string
      ),
    })
  })

  // The app measures the machine with NVML and Vulkan; the core cannot. Injection has to land
  // before a backend is chosen, which is why the app sends it as soon as it attaches.
  router.get(p('/hardware/override'), (_req, res) =>
    sendJson(res, 200, { override: deps.hardware.get() ?? null })
  )

  router.put(p('/hardware/override'), async (req, res) => {
    const body = await readJsonBody<HardwareOverrideInput>(req)
    sendJson(res, 200, { override: deps.hardware.set(body) })
  })

  router.delete(p('/hardware/override'), (_req, res) =>
    sendJson(res, 200, { cleared: deps.hardware.clear() })
  )

  // Whether a provider's settings have been handed over, and whether the app has confirmed it saw
  // the result. The migration flag must not be turned on for a scope that has not reached
  // `migrated` — the core would load with its own defaults instead of the user's (PLAN.md §3.4).
  router.get(p('/settings/status'), (_req, res) => {
    const scopes: Record<string, unknown> = {}
    for (const provider of LOCAL_PROVIDER_IDS) {
      const migration = deps.settings.migration(provider)
      scopes[provider] = {
        migrated: migration?.legacy_hash != null,
        acknowledged_revision: migration?.acknowledged_revision ?? null,
        // True once the app has confirmed it mirrored everything the core currently holds; a
        // planned rollback needs this before handing ownership back.
        in_sync:
          migration?.acknowledged_revision != null &&
          migration.acknowledged_revision === deps.settings.revision(),
      }
    }
    sendJson(res, 200, { revision: deps.settings.revision(), scopes })
  })

  router.get(p('/settings/:provider'), (_req, res, { params }) => {
    const provider = params['provider'] as LocalProviderId
    sendJson(res, 200, {
      provider,
      revision: deps.settings.revision(),
      values: deps.settings.get(provider),
      migration: deps.settings.migration(provider),
    })
  })

  router.patch(p('/settings/:provider'), async (req, res, { params }) => {
    const body = await readJsonBody<{ values?: ProviderValues; expected_revision?: number }>(req)
    const result = await deps.settings.update(params['provider'] as LocalProviderId, body.values ?? {}, {
      ...(typeof body.expected_revision === 'number' ? { expectedRevision: body.expected_revision } : {}),
    })
    sendJson(res, 200, result)
  })

  // Hand the app's own settings over (PLAN.md §3.4). Answers 409 on a conflict, because the caller
  // has to put the choice to the user before this scope can be migrated at all.
  router.post(p('/settings/:provider/import'), async (req, res, { params }) => {
    const body = await readJsonBody<{
      values?: ProviderValues
      resolutions?: ImportOptions['resolutions']
      expected_revision?: number
    }>(req)
    const result = await deps.settings.importProvider(
      params['provider'] as LocalProviderId,
      body.values ?? {},
      {
        ...(body.resolutions ? { resolutions: body.resolutions } : {}),
        ...(typeof body.expected_revision === 'number' ? { expectedRevision: body.expected_revision } : {}),
      }
    )
    sendJson(res, result.status === 'conflict' ? 409 : 200, result)
  })

  router.post(p('/settings/:scope/acknowledge'), async (req, res, { params }) => {
    const body = await readJsonBody<{ revision?: number }>(req)
    if (typeof body.revision !== 'number')
      return sendError(
        res,
        new AtomicCoreError('INVALID_ARGUMENT', 'acknowledge needs the revision being confirmed')
      )
    sendJson(res, 200, await deps.settings.acknowledge(params['scope'] as string, body.revision))
  })

  router.get(p('/external-sessions'), (_req, res) =>
    sendJson(res, 200, { sessions: deps.externalSessions.list() })
  )

  router.put(p('/external-sessions/:owner'), async (req, res, { params }) => {
    const body = await readJsonBody<{ generation?: number; sessions?: unknown }>(req)
    sendJson(
      res,
      200,
      deps.externalSessions.publish(params['owner'] as string, body.generation as number, body.sessions)
    )
  })

  router.post(p('/external-sessions/:owner/heartbeat'), async (req, res, { params }) => {
    const body = await readJsonBody<{ generation?: number }>(req)
    sendJson(res, 200, deps.externalSessions.heartbeat(params['owner'] as string, Number(body.generation)))
  })

  router.delete(p('/external-sessions/:owner'), async (req, res, { params }) => {
    const body = await readJsonBody<{ generation?: number }>(req)
    sendJson(res, 200, {
      unregistered: deps.externalSessions.unregister(params['owner'] as string, body.generation),
    })
  })

  router.post(p('/external-sessions/:owner/ctx/:requestId'), async (req, res, { params }) => {
    const body = await readJsonBody<unknown>(req)
    sendJson(res, 200, {
      accepted: deps.externalSessions.answerCtx(
        params['owner'] as string,
        params['requestId'] as string,
        body
      ),
    })
  })

  router.get(p('/cloud/providers'), (_req, res) => sendJson(res, 200, { providers: deps.cloud.list() }))

  router.put(p('/cloud/providers/:provider'), async (req, res, { params }) => {
    const body = await readJsonBody<Omit<CloudProviderInput, 'provider'>>(req)
    sendJson(res, 200, await deps.cloud.upsert({ ...body, provider: params['provider'] as string }))
  })

  router.delete(p('/cloud/providers/:provider'), async (_req, res, { params }) => {
    await deps.cloud.remove(params['provider'] as string)
    sendJson(res, 200, { removed: true })
  })

  router.get(p('/auth/chatgpt'), async (_req, res) => sendJson(res, 200, await deps.chatgpt.status()))

  router.post(p('/auth/chatgpt/reload'), async (_req, res) => {
    if (!deps.chatgpt.reload)
      return sendError(res, new AtomicCoreError('INVALID_ARGUMENT', 'reload is unavailable'))
    sendJson(res, 200, await deps.chatgpt.reload())
  })

  // Sign-in is two calls because the core cannot open a browser: this one binds the callback
  // listener on :1455 and says where to send the user, `/login/wait` resolves when they are back.
  router.post(p('/auth/chatgpt/login'), async (_req, res) =>
    sendJson(res, 200, await deps.chatgpt.startLogin())
  )

  router.post(p('/auth/chatgpt/login/wait'), async (_req, res) =>
    sendJson(res, 200, await deps.chatgpt.waitLogin())
  )

  router.post(p('/auth/chatgpt/login/cancel'), (_req, res) => {
    deps.chatgpt.cancelLogin()
    sendJson(res, 200, { cancelled: true })
  })

  router.post(p('/auth/chatgpt/logout'), async (_req, res) => sendJson(res, 200, await deps.chatgpt.logout()))

  router.get(p('/auth/chatgpt/models'), async (_req, res) =>
    sendJson(res, 200, { models: await deps.chatgpt.models() })
  )

  router.get(p('/server'), (_req, res) => sendJson(res, 200, deps.publicServer.status()))

  router.post(p('/server/start'), async (req, res) => {
    const body = await readJsonBody<{
      host?: string
      port?: number
      prefix?: string
      api_key?: string
      trusted_hosts?: string[]
      proxy_timeout_secs?: number
      state_file?: boolean
      fallback_port?: boolean
    }>(req)
    const state = await deps.publicServer.start({
      ...(body.host !== undefined ? { host: body.host } : {}),
      ...(body.port !== undefined ? { port: body.port } : {}),
      ...(body.prefix !== undefined ? { prefix: body.prefix } : {}),
      ...(body.api_key !== undefined ? { apiKey: body.api_key } : {}),
      ...(body.trusted_hosts !== undefined ? { trustedHosts: body.trusted_hosts } : {}),
      ...(body.proxy_timeout_secs !== undefined ? { proxyTimeoutSecs: body.proxy_timeout_secs } : {}),
      ...(body.state_file !== undefined ? { writeStateFile: body.state_file === true } : {}),
      ...(body.fallback_port !== undefined ? { fallbackPort: body.fallback_port === true } : {}),
    })
    sendJson(res, 200, state)
  })

  router.post(p('/server/stop'), async (_req, res) => sendJson(res, 200, await deps.publicServer.stop()))

  router.put(p('/server/inspector'), async (req, res) => {
    const body = await readJsonBody<{ enabled?: unknown }>(req)
    if (typeof body.enabled !== 'boolean')
      return sendError(
        res,
        new AtomicCoreError('INVALID_ARGUMENT', 'inspector needs {"enabled": true|false}')
      )
    deps.publicServer.setInspecting(body.enabled)
    sendJson(res, 200, { enabled: body.enabled })
  })

  router.post(p('/shutdown'), async (req, res) => {
    const body = await readJsonBody<{ force?: boolean; client_id?: string }>(req)
    const others = deps.clients.acceptShutdown(body.client_id, body.force === true)
    if (others.length > 0 && body.force !== true) {
      return sendError(
        res,
        new AtomicCoreError(
          'CORE_ALREADY_RUNNING',
          'Other clients are still attached to this core.',
          others.map((c) => `${c.name}${c.pid ? ` (pid ${c.pid})` : ''}`).join(', ')
        )
      )
    }
    sendJson(res, 200, { ok: true, stopping: true })
    setTimeout(() => {
      void deps.shutdown({ force: body.force === true, requestedBy: body.client_id })
    }, 10).unref?.()
  })

  return router
}
