/**
 * The control listener: binds loopback, gates every request (loopback peer, loopback `Host`, control
 * token), dispatches through the router, and fans core events out to attached SSE clients.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { AtomicCoreError } from '../../contracts/index.js'
import type { CoreEventRecord } from '../../contracts/index.js'
import { bearerToken, controlTokenMatches } from '../../lock/index.js'
import { hostHeaderIsLoopback, isLoopbackAddress, pathOf, sendError } from '../http.js'
import type { Router } from '../http.js'
import { buildRouter } from './router.js'
import { sseFrame } from './routes/lifecycle.js'
import { SSE_HEARTBEAT_MS } from './types.js'
import type { ControlServerDeps } from './types.js'

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
