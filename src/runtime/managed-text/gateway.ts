/**
 * The per-session authenticating gateway that sits in front of a managed engine's port.
 *
 * `trtllm-serve` (and any future container-hosted engine) listens on loopback but checks no API key
 * of its own, so anything on the machine — and, through DNS rebinding, any web page the user has
 * open — could reach it directly. Core instead binds a listener of its own on `127.0.0.1:<random>`
 * for each session, hands that port and a fresh key out as `SessionInfo.port`/`api_key`, and proxies
 * through to the container's real port only once a request presents that key from an allowed Host.
 * The container's own port is never handed to a caller.
 *
 * The Host and Bearer-key checks are the public server's own (`server/public/gates.ts`,
 * `hostAndKeyGate`) — the same code `:1337` gates on, so the trusted-Host allowlist behaves
 * identically everywhere in the process. Streaming is the public server's own upstream plumbing too
 * (`server/public/wire.ts`): `sendUpstream` for the request, `relay`/`pipeBody` to copy the response
 * to the client as it arrives, with no buffering, and to close the upstream connection the moment
 * the client goes away.
 *
 * New for TensorRT-LLM managed sessions (design D11, spec `managed-session-gateway`). Engine-neutral:
 * nothing here knows about `trtllm-serve` specifically, only that it speaks HTTP on loopback.
 *
 * `rewriteRequestBody` (task 2.13 fix round 1; ADR
 * `docs/decisions/2026-09-28-tensorrt-llm-output-cap-enforced-by-the-session-gateway.md`) is the one
 * deliberate exception to "copies bytes without parsing" (design D11's own Risks/Trade-offs entry):
 * an adapter may ask to rewrite a POST request's JSON body before it reaches the upstream. This
 * module stays engine-neutral about *why* — it only enforces the mechanics (POST only, a body-size
 * cap, a parse failure answers 400 instead of forwarding) and never touches the response, streamed
 * or not.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { AtomicCoreError } from '../../contracts/index.js'
import { hostAndKeyGate } from '../../server/public/index.js'
import type { HostAndKeyConfig } from '../../server/public/index.js'
import { forwardableHeaders, readBody, relay, sendUpstream, sendWhole } from '../../server/public/index.js'
import type { UpstreamResponse } from '../../server/public/index.js'

/** Hosts accepted as "loopback" for the upstream the gateway proxies to. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** The gateway's own listener never binds anywhere else. */
const GATEWAY_HOST = '127.0.0.1'

/**
 * `host`, bracketed when it is a bare IPv6 literal — what has to follow `http://` for `new URL` (and
 * everything downstream of it) to parse the address instead of tripping over its colons. `::1` alone
 * would otherwise be read as `host "::1"` with a bogus port after the last colon; `[::1]` already
 * carries its own brackets and is left alone, as is every other accepted loopback spelling.
 */
export function bracketIfIpv6(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/** The container port the gateway proxies to. Always loopback: never a LAN or public address. */
export interface ManagedGatewayUpstream {
  host: string
  port: number
}

export interface ManagedGatewayOptions {
  upstream: ManagedGatewayUpstream
  /** Bearer key clients must present; unique per session generation, see {@link generateGatewayKey}. */
  apiKey: string
  /** The same trusted-hosts list the public server (`:1337`) is configured with. */
  allowedHosts: string[]
  /**
   * Optional: rewrites a POST request's parsed JSON body before it is forwarded, already bound to
   * whatever settings the adapter needs (the lifecycle does that binding; this callback takes just
   * `route` and the parsed `body`). Absent, every request proxies exactly as before. See the file
   * header and `ManagedTextAdapter.rewriteRequestBody`.
   */
  rewriteRequestBody?: (route: string, body: unknown) => unknown
}

export interface ManagedGateway {
  /** Always `127.0.0.1`: the gateway never binds anything else. */
  host: string
  /** The gateway's own loopback port; this, not `upstream.port`, is what `SessionInfo.port` gets. */
  port: number
  /** Stops accepting connections and drops whatever is in flight; no drain, no deferral. */
  close: () => Promise<void>
}

/** Upstream connect timeout: generous because the container is local, but requests must not hang forever. */
const CONNECT_TIMEOUT_MS = 30_000

/**
 * The largest request body `rewriteRequestBody` will attempt to `JSON.parse`. Only bounds this
 * rewrite path — every request body is already read into memory in full before this point
 * (`readBody`, below) regardless of whether a rewriter is configured at all; this cap exists so a
 * huge POST cannot also be handed to `JSON.parse` for no reason when nothing will use the parse.
 */
export const MANAGED_GATEWAY_REWRITE_BODY_CAP_BYTES = 8 * 1024 * 1024

/** The request path, with no query string — what `rewriteRequestBody` sees as `route`. */
function routeOf(url: string | undefined): string {
  if (url === undefined) return '/'
  const qIndex = url.indexOf('?')
  return qIndex === -1 ? url : url.slice(0, qIndex)
}

/**
 * A fresh, unguessable session key: 256 bits of `crypto.randomBytes`, base64url so it fits a Bearer
 * header verbatim. Call this once per generation — a reload gets a new key, so a caller holding the
 * previous one is refused (`SESSION_GENERATION_STALE` at the session layer; here, plain 401).
 */
export function generateGatewayKey(): string {
  return randomBytes(32).toString('base64url')
}

/** Proxy one request to the upstream, streaming the response back without buffering it. */
async function proxyToUpstream(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: ManagedGatewayUpstream,
  rewriteRequestBody?: (route: string, body: unknown) => unknown
): Promise<void> {
  let body: Buffer
  try {
    body = await readBody(req)
  } catch {
    if (!res.headersSent) sendWhole(res, 400, [], 'Failed to read request body')
    return
  }

  if (rewriteRequestBody !== undefined && req.method === 'POST' && body.length > 0) {
    if (body.length > MANAGED_GATEWAY_REWRITE_BODY_CAP_BYTES) {
      sendWhole(res, 413, [], 'Request body too large')
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      sendWhole(res, 400, [], 'Invalid JSON request body')
      return
    }
    let rewritten: unknown
    try {
      rewritten = rewriteRequestBody(routeOf(req.url), parsed)
    } catch {
      sendWhole(res, 400, [], 'Request body could not be processed')
      return
    }
    // `sendUpstream` derives `Content-Length` from this buffer's own byte length, so a body that
    // grew or shrank under rewriting is never sent with the client's original (now stale) length.
    body = Buffer.from(JSON.stringify(rewritten), 'utf8')
  }

  // A client that disconnects before the upstream has even answered must not leave that connect
  // attempt, or a slow-to-respond container, running unattended.
  const controller = new AbortController()
  const onEarlyClose = () => controller.abort()
  res.once('close', onEarlyClose)

  let upstreamResponse: UpstreamResponse
  try {
    const origin = `http://${bracketIfIpv6(upstream.host)}:${upstream.port}`
    upstreamResponse = await sendUpstream(`${origin}${req.url ?? '/'}`, {
      method: req.method ?? 'GET',
      // The client's own auth headers are this gateway's secret, not the container's; they stop here.
      headers: forwardableHeaders(req, ['authorization', 'x-api-key']),
      ...(body.length > 0 ? { body } : {}),
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
      signal: controller.signal,
    })
  } catch {
    res.off('close', onEarlyClose)
    if (!res.headersSent && !res.destroyed) sendWhole(res, 502, [], 'Bad Gateway')
    return
  }
  res.off('close', onEarlyClose)
  // `relay` owns the rest: it writes the status/headers, pipes the body with backpressure, and
  // tears the upstream connection down itself if the client disconnects mid-stream.
  await relay(res, upstreamResponse, [])
}

function assertLoopback(host: string): void {
  if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      'Managed session gateway upstream must be loopback.',
      `got host "${host}"`
    )
  }
}

/**
 * `trtllm-serve` checks no key of its own — this gateway is the *only* thing standing between the
 * container's port and anything on the machine (or, via DNS rebinding, a web page). `hostAndKeyGate`
 * treats an empty `apiKey` as "auth disabled", which is the right default for `:1337` (a user opted
 * out in Settings) but is never correct here: nobody can opt a managed session out of its own only
 * guard. A caller starting one without a key is a bug, not a configuration choice, so it fails loud.
 */
function assertApiKeyPresent(apiKey: string): void {
  if (apiKey === '') {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      'Managed session gateway requires a non-empty api key: it is the only auth in front of an ' +
        'engine that checks none of its own.'
    )
  }
}

/**
 * Start a gateway for one managed session: binds `127.0.0.1:0`, gates every request on the Host and
 * Bearer checks, and streams whatever passes through to `options.upstream`.
 */
export async function startManagedGateway(options: ManagedGatewayOptions): Promise<ManagedGateway> {
  assertLoopback(options.upstream.host)
  assertApiKeyPresent(options.apiKey)
  const gateConfig: HostAndKeyConfig = { apiKey: options.apiKey, trustedHosts: options.allowedHosts }

  const server: Server = createServer({ requireHostHeader: false }, (req, res) => {
    const refused = hostAndKeyGate(req, gateConfig)
    if (refused) {
      sendWhole(res, refused.status, [], refused.body)
      return
    }
    proxyToUpstream(req, res, options.upstream, options.rewriteRequestBody).catch(() => {
      if (!res.headersSent && !res.destroyed) sendWhole(res, 502, [], 'Bad Gateway')
      else res.destroy()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, GATEWAY_HOST, () => resolve())
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    host: GATEWAY_HOST,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
