/**
 * The public, OpenAI-compatible listener (`/v1/*`). Separate from the control listener on purpose:
 * it can be started, stopped and rebound without touching control, sessions or the SSE stream
 * (PLAN.md §3.6, risk 1). The app's `:1337` proxy keeps that role until phase 4; this is the same
 * surface for a core that runs on its own.
 *
 * Requests are forwarded to the `llama-server` of the session that owns the requested model. The
 * per-session API key never leaves the core: clients authenticate with the server's own key, and
 * the upstream key is attached here. Disconnecting a client aborts the upstream request, which is
 * what makes cancel work for a half-streamed completion.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { AtomicCoreError } from '../contracts/index.js'
import type { CoreEvents, LocalApiServerState } from '../contracts/index.js'
import { hostHeaderIsLoopback, pathOf, sendError, sendJson } from './http.js'

export const DEFAULT_PUBLIC_PORT = 1337
export const DEFAULT_PUBLIC_HOST = '127.0.0.1'
export const DEFAULT_PUBLIC_PREFIX = '/v1'

export interface ForwardTarget {
  /** Base URL of the backend that owns the model, e.g. `http://127.0.0.1:3412`. */
  baseUrl: string
  /** Bearer the backend expects; never disclosed to the caller. */
  apiKey: string
}

export interface PublicModel {
  id: string
  owned_by?: string
  created?: number
}

export interface PublicServerOptions {
  host?: string
  port?: number
  prefix?: string
  /** Key clients must present; empty means the server is open (still loopback unless host says otherwise). */
  apiKey?: string
  /** Extra `Host` values accepted besides loopback; `*` disables the check. */
  trustedHosts?: string[]
  corsEnabled?: boolean
}

export interface PublicServerDeps {
  listModels: () => PublicModel[]
  resolveTarget: (model: string) => ForwardTarget | undefined
  emit?: <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) => void
  fetch?: typeof fetch
}

/** Routes that answer without the API key: liveness probes must work on a locked-down server. */
const OPEN_PATHS = new Set(['/', '/health'])

export class PublicServer {
  private constructor(
    private readonly server: Server,
    readonly host: string,
    readonly port: number,
    readonly prefix: string,
    private readonly requiresApiKey: boolean
  ) {}

  static async start(deps: PublicServerDeps, options: PublicServerOptions = {}): Promise<PublicServer> {
    const host = options.host ?? DEFAULT_PUBLIC_HOST
    const port = options.port ?? DEFAULT_PUBLIC_PORT
    const prefix = normalisePrefix(options.prefix ?? DEFAULT_PUBLIC_PREFIX)
    const apiKey = options.apiKey ?? ''
    const server = createServer((req, res) => {
      void serve(req, res, { deps, prefix, apiKey, options }).catch((e) => sendError(res, e))
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (e: NodeJS.ErrnoException) => {
        reject(
          e.code === 'EADDRINUSE'
            ? new AtomicCoreError('IO_ERROR', `Port ${port} is already in use.`, `${host}:${port}`)
            : e
        )
      }
      server.once('error', onError)
      server.listen(port, host, () => {
        server.off('error', onError)
        resolve()
      })
    })
    const address = server.address()
    return new PublicServer(
      server,
      host,
      typeof address === 'object' && address ? address.port : port,
      prefix,
      apiKey.length > 0
    )
  }

  get url(): string {
    return `http://${this.host}:${this.port}${this.prefix}`
  }

  state(): LocalApiServerState {
    return {
      running: true,
      host: this.host,
      port: this.port,
      prefix: this.prefix,
      requires_api_key: this.requiresApiKey,
      pid: process.pid,
    }
  }

  async close(): Promise<void> {
    this.server.closeAllConnections?.()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

export function stoppedState(previous?: LocalApiServerState): LocalApiServerState {
  return {
    running: false,
    host: previous?.host ?? DEFAULT_PUBLIC_HOST,
    port: previous?.port ?? DEFAULT_PUBLIC_PORT,
    prefix: previous?.prefix ?? DEFAULT_PUBLIC_PREFIX,
    requires_api_key: previous?.requires_api_key ?? false,
    pid: null,
  }
}

function normalisePrefix(prefix: string): string {
  const trimmed = prefix.trim()
  if (!trimmed || trimmed === '/') return ''
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash
}

interface ServeContext {
  deps: PublicServerDeps
  prefix: string
  apiKey: string
  options: PublicServerOptions
}

async function serve(req: IncomingMessage, res: ServerResponse, ctx: ServeContext): Promise<void> {
  const path = pathOf(req)
  if (ctx.options.corsEnabled) {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key')
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
  }
  if (!hostAllowed(req.headers.host, ctx.options.trustedHosts)) {
    return sendError(
      res,
      new AtomicCoreError(
        'FORBIDDEN_HOST',
        'This host is not allowed to reach the local API server.',
        req.headers.host ?? ''
      )
    )
  }
  if (path === '/' || path === '/health') return sendJson(res, 200, { status: 'ok' })

  const relative = ctx.prefix && path.startsWith(ctx.prefix) ? path.slice(ctx.prefix.length) || '/' : path
  if (ctx.prefix && !path.startsWith(ctx.prefix)) {
    return sendError(res, new AtomicCoreError('INVALID_ARGUMENT', `No such route: ${path}`), 404)
  }
  if (!OPEN_PATHS.has(relative) && !apiKeyAccepted(req, ctx.apiKey)) {
    return sendError(res, new AtomicCoreError('UNAUTHORIZED', 'Invalid API key.'))
  }

  if (relative === '/models' && req.method === 'GET') {
    return sendJson(res, 200, {
      object: 'list',
      data: ctx.deps.listModels().map((m) => ({
        id: m.id,
        object: 'model',
        created: m.created ?? 0,
        owned_by: m.owned_by ?? 'atomic-chat',
      })),
    })
  }
  if (req.method !== 'POST') {
    return sendError(res, new AtomicCoreError('INVALID_ARGUMENT', `No such route: ${path}`), 404)
  }
  return forward(req, res, relative, ctx)
}

function hostAllowed(host: string | undefined, trusted: string[] | undefined): boolean {
  if (trusted?.includes('*')) return true
  if (hostHeaderIsLoopback(host)) return true
  if (!host) return false
  const name = host.split(':')[0] ?? ''
  return (trusted ?? []).some((t) => t === host || t === name)
}

function apiKeyAccepted(req: IncomingMessage, expected: string): boolean {
  if (!expected) return true
  const auth = req.headers.authorization ?? ''
  const bearer = /^Bearer\s+(.+)$/i.exec(auth.trim())?.[1]?.trim()
  const header = req.headers['x-api-key']
  const presented = bearer ?? (typeof header === 'string' ? header : undefined)
  return presented === expected
}

/** The backend always speaks the OpenAI paths under `/v1`, whatever prefix this server exposes. */
export function upstreamPath(relative: string): string {
  return relative.startsWith('/v1/') ? relative : `/v1${relative}`
}

/** Read the body, pick the session by `model`, and stream the backend's answer straight back. */
async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  relative: string,
  ctx: ServeContext
): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks)
  let body: { model?: unknown; stream?: unknown } = {}
  if (raw.length) {
    try {
      body = JSON.parse(raw.toString('utf8')) as typeof body
    } catch (e) {
      return sendError(
        res,
        new AtomicCoreError('INVALID_ARGUMENT', 'Request body is not valid JSON.', (e as Error).message)
      )
    }
  }
  const model = typeof body.model === 'string' ? body.model : ''
  if (!model) {
    return sendError(res, new AtomicCoreError('INVALID_ARGUMENT', 'Request is missing the "model" field.'))
  }
  const target = ctx.deps.resolveTarget(model)
  if (!target) {
    return sendError(
      res,
      new AtomicCoreError(
        'MODEL_NOT_LOADED',
        `Model "${model}" is not loaded.`,
        'load it first, or use /v1/models to see what is'
      )
    )
  }

  const started = Date.now()
  const requestId = `${started.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  ctx.deps.emit?.('api:request', {
    id: requestId,
    phase: 'started',
    endpoint: relative,
    model,
    backend: target.baseUrl,
  })

  const controller = new AbortController()
  // A client that hangs up mid-stream must stop the generation, not leave the backend running.
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })
  const fetchImpl = ctx.deps.fetch ?? fetch
  let upstream: Response
  try {
    upstream = await fetchImpl(`${target.baseUrl}${upstreamPath(relative)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
      },
      body: raw,
      signal: controller.signal,
    })
  } catch (e) {
    if (controller.signal.aborted) return
    return sendError(
      res,
      new AtomicCoreError('IO_ERROR', 'The model backend did not answer.', (e as Error).message),
      502
    )
  }

  const headers: Record<string, string> = {}
  for (const name of ['content-type', 'cache-control', 'transfer-encoding']) {
    const value = upstream.headers.get(name)
    if (value) headers[name] = value
  }
  res.writeHead(upstream.status, headers)
  if (upstream.body) {
    const reader = upstream.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!res.write(Buffer.from(value))) await new Promise((r) => res.once('drain', r))
      }
    } catch {
      // aborted by the client, or the backend died mid-stream; the socket is already gone
    } finally {
      reader.cancel().catch(() => {})
    }
  }
  res.end()
  ctx.deps.emit?.('api:request', {
    id: requestId,
    phase: 'finished',
    endpoint: relative,
    model,
    backend: target.baseUrl,
    status: upstream.status,
    duration_ms: Date.now() - started,
  })
}
