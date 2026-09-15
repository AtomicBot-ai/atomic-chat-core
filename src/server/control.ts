/**
 * The control API (`/atomic/v1/*`, PLAN.md §3.6): how the app and the CLI drive a core they did not
 * start. It is deliberately not the inference API — it binds loopback only, always requires the
 * control token, refuses non-loopback `Host` headers (the DNS-rebinding guard that lets a browser
 * page talk to a local port), and sends no CORS headers at all.
 *
 * Stopping the public listener never touches this one: that separation is what keeps a core
 * manageable while its `/v1` surface is down.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { AtomicCoreError, CONTROL_API_PREFIX, CONTROL_PROTOCOL_VERSION } from '../contracts/index.js'
import type {
  CoreEventRecord,
  LocalApiServerState,
  LocalProviderId,
  SessionInfo,
  UnloadResult,
} from '../contracts/index.js'
import type { CoreEmitter } from '../events/index.js'
import { bearerToken, controlTokenMatches } from '../lock/index.js'
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
  }) => Promise<LocalApiServerState>
  stop: () => Promise<LocalApiServerState>
}

export interface ControlServerDeps {
  token: string
  instanceId: string
  version: string
  dataFolder: string
  emitter: CoreEmitter
  clients: ClientRegistry
  sessions: () => SessionSummary[]
  loadModel: (provider: string, modelId: string, body: Record<string, unknown>) => Promise<SessionInfo>
  unloadModel: (provider: string, modelId: string) => Promise<UnloadResult>
  publicServer: PublicServerControl
  /** Stop the whole core. The server has already answered by the time this runs. */
  shutdown: (options: { force: boolean; requestedBy?: string | undefined }) => Promise<void>
  startedAt?: number
  now?: () => number
}

export interface ControlSnapshot {
  instance_id: string
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
  })

  const router = new Router()

  router.get(p('/health'), (_req, res) => {
    sendJson(res, 200, {
      ok: true,
      pid: process.pid,
      version: deps.version,
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
    const session = await deps.loadModel(params['provider'] as string, params['modelId'] as string, body)
    sendJson(res, 200, { session })
  })

  router.post(p('/models/:provider/*modelId/unload'), async (_req, res, { params }) => {
    const result = await deps.unloadModel(params['provider'] as string, params['modelId'] as string)
    sendJson(res, 200, result)
  })

  router.get(p('/server'), (_req, res) => sendJson(res, 200, deps.publicServer.status()))

  router.post(p('/server/start'), async (req, res) => {
    const body = await readJsonBody<{ host?: string; port?: number; prefix?: string; api_key?: string }>(req)
    const state = await deps.publicServer.start({
      ...(body.host !== undefined ? { host: body.host } : {}),
      ...(body.port !== undefined ? { port: body.port } : {}),
      ...(body.prefix !== undefined ? { prefix: body.prefix } : {}),
      ...(body.api_key !== undefined ? { apiKey: body.api_key } : {}),
    })
    sendJson(res, 200, state)
  })

  router.post(p('/server/stop'), async (_req, res) => sendJson(res, 200, await deps.publicServer.stop()))

  router.post(p('/shutdown'), async (req, res) => {
    const body = await readJsonBody<{ force?: boolean; client_id?: string }>(req)
    const others = deps.clients.others(body.client_id)
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
