/**
 * The Local API Server: the OpenAI- and Anthropic-compatible listener (`:1337/v1` by default) that
 * external agents and the app's own chat talk to. Separate from the control listener on purpose: it
 * can be started, stopped and rebound without touching control, sessions or the event stream
 * (PLAN.md §3.6, risk 1).
 *
 * Ported from: src-tauri/src/core/server/proxy.rs (`inner_proxy_request`, `start_server_internal`).
 * Contract: test/fixtures/app/proxy-http, replayed by test/contract/proxy-http.test.ts.
 *
 * A request passes, in this order: CORS preflight (answered outright), prefix removal, the
 * host/key/hidden-path gates, then routing. The trusted hosts those gates read are the configured
 * ones plus a group that is only known per request (the live tunnel name, the accepted socket's
 * address); it is appended to a copy, so the gates themselves and the listener's identity stay as
 * they were. Per-session engine keys never leave the server:
 * clients authenticate with the server's own key and the upstream key is attached on the way out.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { AtomicCoreError } from '../../contracts/index.js'
import type { LocalApiServerState } from '../../contracts/index.js'
import { answer, newExchange } from './exchange.js'
import { serveForward } from './forward.js'
import { serveImagesGenerations } from './images.js'
import { serveSubscriptionIfOwned } from './subscription.js'
import { gate, preflight, removePrefix } from './gates.js'
import { serveMetrics, serveModels, serveMuseCatalog } from './listing.js'
import { serveResponses } from './responses.js'
import { serveStatic } from './static.js'
import { RequestTrace, endpointFromPath } from './trace.js'
import type { PublicServerConfig, PublicServerDeps } from './types.js'
import { sendWhole } from './wire.js'

export type {
  CtxIncreaseOutcome,
  ImagesBackend,
  LocalTarget,
  PublicServerConfig,
  PublicServerDeps,
} from './types.js'
export { isValidHost, removePrefix } from './gates.js'
export { DynamicTrustedHosts, socketAddressLiteral } from './dynamic-hosts.js'

export const DEFAULT_PUBLIC_PORT = 1337
export const DEFAULT_PUBLIC_HOST = '127.0.0.1'
export const DEFAULT_PUBLIC_PREFIX = '/v1'
/** The app's default for "proxy timeout", in seconds. */
export const DEFAULT_PROXY_TIMEOUT_SECS = 600

export interface PublicServerOptions {
  host?: string
  port?: number
  prefix?: string
  /** Key clients must present; empty means the server is open (host checks still apply). */
  apiKey?: string
  /** Hosts accepted besides the built-in loopback names; `*` accepts every host. */
  trustedHosts?: string[]
  proxyTimeoutSecs?: number
  /**
   * When the requested port cannot be bound, take any free port instead of failing — what the app's
   * own server has always done (ATO-189: a port held by another process, or inside a Windows
   * excluded range). The bound port is reported back. Only a failure to bind even a free port fails.
   */
  fallbackPort?: boolean
}

/** Routes the server knows, and the only method each accepts: anything else there is a 405. */
const ALLOWED_METHODS: Record<string, string> = {
  '/': 'GET',
  '/openapi.json': 'GET',
  '/docs/swagger-ui.css': 'GET',
  '/docs/swagger-ui-bundle.js': 'GET',
  '/models': 'GET',
  '/metrics': 'GET',
  '/muse-code/models': 'GET',
  '/messages': 'POST',
  '/chat/completions': 'POST',
  '/responses': 'POST',
  '/completions': 'POST',
  '/embeddings': 'POST',
  '/messages/count_tokens': 'POST',
  '/images/generations': 'POST',
}

const FORWARDED = new Set([
  '/messages',
  '/chat/completions',
  '/completions',
  '/embeddings',
  '/messages/count_tokens',
])

export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim()
  if (!trimmed || trimmed === '/') return ''
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash
}

/** The path of a request target, whether origin-form (`/v1/models?x`) or absolute-form. */
function requestPath(url: string | undefined): string {
  let target = url ?? '/'
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(target)
  if (scheme) target = target.slice(scheme[0].length) || '/'
  const q = target.indexOf('?')
  return q >= 0 ? target.slice(0, q) : target
}

/** The configuration one request is checked against: the listener's, plus what is trusted just for it. */
function configFor(
  req: IncomingMessage,
  listener: PublicServerConfig,
  deps: PublicServerDeps
): PublicServerConfig {
  const dynamic = deps.dynamicTrustedHosts?.(req.socket.localAddress) ?? []
  return dynamic.length === 0
    ? listener
    : { ...listener, trustedHosts: [...listener.trustedHosts, ...dynamic] }
}

export async function handlePublicRequest(
  req: IncomingMessage,
  res: ServerResponse,
  listener: PublicServerConfig,
  deps: PublicServerDeps
): Promise<void> {
  const trace = new RequestTrace(req.method ?? 'GET', deps)
  trace.attach(res)
  const config = configFor(req, listener, deps)

  if (req.method === 'OPTIONS') {
    // Preflight is browser bookkeeping, not a product signal, whatever its outcome.
    trace.skipEmit = true
    const r = preflight(req, config)
    sendWhole(res, r.status, r.headers, r.body)
    return
  }

  const path = removePrefix(requestPath(req.url), config.prefix)
  const refused = gate(req, path, config)
  if (refused) {
    if (refused.kind === 'hidden') trace.skipEmit = true
    else {
      trace.endpoint = endpointFromPath(path)
      trace.errorKind = refused.kind ?? null
    }
    sendWhole(res, refused.status, refused.headers, refused.body)
    return
  }

  const ex = newExchange(req, res, path, config, deps, trace)
  if (ex.method === 'POST') {
    if (path === '/responses') return serveResponses(ex)
    // A model served by the ChatGPT subscription speaks another protocol and takes other headers,
    // so it is answered in full here and never reaches the generic forwarder.
    if (path === '/chat/completions' && deps.chatgpt && (await serveSubscriptionIfOwned(ex, deps.chatgpt)))
      return
    if (FORWARDED.has(path)) return serveForward(ex)
    // Served here, never forwarded: the image model is the core's own, and it is not in `/models`.
    if (path === '/images/generations') {
      trace.endpoint = endpointFromPath(path)
      return serveImagesGenerations(ex)
    }
  }
  if (ex.method === 'GET') {
    // Model polling, metrics scraping and the docs are client bookkeeping: never reported.
    if (path === '/models' || path === '/muse-code/models' || path === '/metrics') {
      trace.endpoint = endpointFromPath(path)
      trace.skipEmit = true
    }
    if (path === '/models') return serveModels(ex)
    if (path === '/muse-code/models') return serveMuseCatalog(ex)
    if (path === '/metrics') return serveMetrics(ex)
    if (serveStatic(ex)) {
      trace.skipEmit = true
      return
    }
  }

  const allowed = ALLOWED_METHODS[path]
  if (allowed) {
    trace.endpoint = endpointFromPath(path)
    trace.errorKind = 'method_not_allowed'
    answer(ex, 405, 'Method Not Allowed', [['Allow', allowed]])
    return
  }
  // Catch-all 404s are mostly scanners and misconfigured clients: no product signal.
  trace.skipEmit = true
  answer(ex, 404, 'Not Found')
}

export class PublicServer {
  private constructor(
    private readonly server: Server,
    private readonly config: PublicServerConfig
  ) {}

  static async start(deps: PublicServerDeps, options: PublicServerOptions = {}): Promise<PublicServer> {
    const host = options.host ?? DEFAULT_PUBLIC_HOST
    const port = options.port ?? DEFAULT_PUBLIC_PORT
    // The OpenAPI document advertises the bound port, so the config is completed after listening.
    const config: PublicServerConfig = {
      host,
      port,
      prefix: normalizePrefix(options.prefix ?? DEFAULT_PUBLIC_PREFIX),
      apiKey: options.apiKey ?? '',
      trustedHosts: [...(options.trustedHosts ?? [])],
      proxyTimeoutSecs: options.proxyTimeoutSecs ?? DEFAULT_PROXY_TIMEOUT_SECS,
    }
    // `requireHostHeader: false` lets a request without `Host` reach the gate, which answers it with
    // the proxy's own 400 instead of Node's bare one.
    const server = createServer({ requireHostHeader: false }, (req, res) => {
      handlePublicRequest(req, res, config, deps).catch((e: unknown) => {
        if (res.headersSent) res.destroy(e as Error)
        else sendWhole(res, 500, [], 'Internal server error')
      })
    })
    const listen = (bindPort: number) =>
      new Promise<void>((resolve, reject) => {
        const onError = (e: NodeJS.ErrnoException) => {
          reject(
            e.code === 'EADDRINUSE'
              ? new AtomicCoreError('IO_ERROR', `Port ${bindPort} is already in use.`, `${host}:${bindPort}`)
              : e
          )
        }
        server.once('error', onError)
        server.listen(bindPort, host, () => {
          server.off('error', onError)
          resolve()
        })
      })
    try {
      await listen(port)
    } catch (e) {
      if (!options.fallbackPort || port === 0) throw e
      await listen(0).catch((fallback: Error) => {
        throw new AtomicCoreError(
          'IO_ERROR',
          `Cannot listen on ${host}:${port}, nor on any free port there.`,
          `${(e as Error).message}; fallback: ${fallback.message}`
        )
      })
    }
    const address = server.address()
    if (typeof address === 'object' && address) config.port = address.port
    return new PublicServer(server, config)
  }

  get host(): string {
    return this.config.host
  }

  get port(): number {
    return this.config.port
  }

  get prefix(): string {
    return this.config.prefix
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
      requires_api_key: this.config.apiKey.length > 0,
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
