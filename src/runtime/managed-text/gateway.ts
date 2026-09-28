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
 * `routes`/`rewritableRoutes`/`rewriteRequestBody` (task 2.13 fix rounds 1-2; ADR
 * `docs/decisions/2026-09-28-tensorrt-llm-output-cap-enforced-by-the-session-gateway.md`) are the
 * deliberate exceptions to design D11's own Risks/Trade-offs entry, "только копирование байтов без
 * парсинга" (only copies bytes, never parses):
 * - every request's route is checked against the adapter's own declared `routes` before anything is
 *   forwarded — a route the adapter never declared gets `404` straight back, without ever reaching
 *   the upstream, closing off whatever else the engine's own HTTP server happens to also expose;
 * - a request to a declared route the adapter also lists as rewritable gets its JSON body parsed,
 *   handed to `rewriteRequestBody`, and re-serialized before forwarding.
 * Every other declared route still proxies byte-for-byte, exactly as before this existed. This
 * module stays engine-neutral about *why* an adapter wants either of these — it only enforces the
 * mechanics (route matching on the decoded path, POST-only rewriting, a body-size cap enforced while
 * the body streams in, a parse failure or a rewriter's own throw answering `400` instead of
 * forwarding) and never touches the response, streamed or not.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { AtomicCoreError } from '../../contracts/index.js'
import { hostAndKeyGate } from '../../server/public/index.js'
import type { HostAndKeyConfig } from '../../server/public/index.js'
import { forwardableHeaders, readBody, relay, sendUpstream, sendWhole } from '../../server/public/index.js'
import type { HeaderPairs, UpstreamResponse } from '../../server/public/index.js'

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
   * The adapter's own declared routes (`ManagedTextAdapter.routes`; absolute paths, no query, no
   * method). Matched against the request's percent-decoded path — see `decodedRoute` — before
   * anything is forwarded; anything that does not match gets `404` and never reaches the upstream
   * at all.
   */
  routes: readonly string[]
  /** The subset of `routes` `rewriteRequestBody` may rewrite (`ManagedTextAdapter.rewritableRoutes`).
   *  Absent or empty: nothing is ever parsed as JSON, even with `rewriteRequestBody` set. */
  rewritableRoutes?: readonly string[]
  /**
   * Optional: rewrites a POST request's parsed JSON body before it is forwarded, already bound to
   * whatever settings the adapter needs (the lifecycle does that binding; this callback takes just
   * `route` and the parsed `body`). Called only for a route listed in `rewritableRoutes`. Absent,
   * every request proxies exactly as before. See the file header and
   * `ManagedTextAdapter.rewriteRequestBody`.
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
 * The largest request body the rewrite path will read at all. Enforced *while the body streams in*
 * (`readCappedBody`, below), not after it is fully buffered: reading stops the moment the running
 * total crosses the cap, so an oversized body is never held in memory in full just to then be thrown
 * away (findings-2.13-r2.md item 2). A declared route that is not rewritable never goes through this
 * cap at all; it proxies through the same unbounded `readBody` every request used before any of this
 * existed.
 */
export const MANAGED_GATEWAY_REWRITE_BODY_CAP_BYTES = 8 * 1024 * 1024

const OPENAI_ERROR_HEADERS: HeaderPairs = [['content-type', 'application/json']]

/**
 * An OpenAI-shaped `{"error": {message, type, code}}` body (findings-2.13-r2.md item 5) — the same
 * envelope convention `server/public/errors.ts`'s `structureBackendErrorBody` already uses for
 * llama.cpp/MLX, and `tensorrtLlmAdapter`'s own `context_length_exceeded` mapping, so a client never
 * has to special-case a third error shape for the one gateway that happens to front a container.
 */
function sendOpenAIError(
  res: ServerResponse,
  status: number,
  message: string,
  type: string,
  code: string
): void {
  sendWhole(res, status, OPENAI_ERROR_HEADERS, JSON.stringify({ error: { message, type, code } }))
}

/**
 * Answers `413` for a body abandoned mid-read (over the rewrite cap) and only *then* — once the
 * response has actually finished writing, via `res.end`'s own callback — destroys the connection.
 * Order matters: `readCappedBody` stopped before consuming the whole request, so the socket still
 * has unread client bytes sitting in it; keeping it alive for a next, pipelined request is not safe,
 * but destroying it before the response leaves would race the client into seeing a truncated
 * response as a bare socket error instead of a clean `413` (this raced and failed exactly that way
 * during development, when the destroy happened immediately instead of after the write).
 */
function sendTooLargeAndClose(req: IncomingMessage, res: ServerResponse): void {
  const body = JSON.stringify({
    error: {
      message: 'Request body exceeds the maximum size accepted here.',
      type: 'invalid_request_error',
      code: 'request_too_large',
    },
  })
  res.writeHead(413, [...OPENAI_ERROR_HEADERS, ['connection', 'close']].flat())
  res.end(body, () => {
    req.destroy()
  })
}

/** The request path, with no query string — what a route is matched and rewritten on. */
function routeOf(url: string | undefined): string {
  if (url === undefined) return '/'
  const qIndex = url.indexOf('?')
  return qIndex === -1 ? url : url.slice(0, qIndex)
}

/**
 * Percent-decodes a route path for matching against `options.routes`, refusing to do so at all when
 * that would be ambiguous. An encoded slash (`%2f`/`%2F`) decoding into a literal `/` is the classic
 * path-confusion trick — two request paths that look different before decoding could otherwise land
 * on the same declared route, or a path that looks like it climbs into an unrelated route once
 * decoded — so its mere presence makes the whole path unmatchable (`null`, which equals no entry in
 * `routes`, so it always 404s) rather than trying to reason about which reading is "the real one".
 * Malformed percent-encoding that `decodeURIComponent` itself rejects does the same.
 */
function decodedRoute(rawPath: string): string | null {
  if (/%2f/i.test(rawPath)) return null
  try {
    return decodeURIComponent(rawPath)
  } catch {
    return null
  }
}

/**
 * Reads a body up to `capBytes` from any chunked async source (an `IncomingMessage` satisfies
 * `AsyncIterable<Buffer>` on its own), counting while chunks arrive. The moment the running total
 * would exceed the cap, reading stops immediately — the source is never asked for another chunk,
 * and nothing past the cap is ever buffered — and `'too-large'` comes back instead of a `Buffer`
 * (findings-2.13-r2.md item 2: exported, and typed against the generic interface rather than
 * `IncomingMessage` specifically, so this exact claim — stops pulling before the cap, not after —
 * has a direct unit test against a source that never ends, instead of only an HTTP-level test whose
 * client would have to keep sending past a connection the server has already closed, which is an
 * inherently racy thing to assert on at the TCP level). Does not itself touch the connection: the
 * caller (`sendTooLargeAndClose`) decides when it is safe to close it, after the `413` has actually
 * been written, not before.
 */
export async function readCappedBody(
  source: AsyncIterable<Buffer>,
  capBytes: number
): Promise<Buffer | 'too-large'> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of source) {
    total += chunk.length
    if (total > capBytes) return 'too-large'
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * A fresh, unguessable session key: 256 bits of `crypto.randomBytes`, base64url so it fits a Bearer
 * header verbatim. Call this once per generation — a reload gets a new key, so a caller holding the
 * previous one is refused (`SESSION_GENERATION_STALE` at the session layer; here, plain 401).
 */
export function generateGatewayKey(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Sends `body` (already fully read) to the upstream and relays its answer back unmodified,
 * streamed or not. Shared by the rewritten and the byte-for-byte paths — everything from here down
 * has never cared, and still does not care, which one a request came through.
 */
async function sendBodyToUpstream(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: ManagedGatewayUpstream,
  body: Buffer
): Promise<void> {
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

/**
 * Reads the client's body under the rewrite cap, parses it as JSON, hands it to `rewriteRequestBody`
 * and re-serializes the result — or answers `413`/`400` itself and returns `null`, meaning the
 * caller must not proceed to the upstream at all. `sendUpstream` derives `Content-Length` from
 * whatever buffer it is actually given, so a body that grew or shrank under rewriting is never sent
 * with the client's original, now-stale length (and never as `Transfer-Encoding: chunked`, whatever
 * the client itself sent it as — the whole point of reading it here first).
 */
async function readAndRewriteBody(
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  rewriteRequestBody: (route: string, body: unknown) => unknown
): Promise<Buffer | null> {
  const capped = await readCappedBody(req, MANAGED_GATEWAY_REWRITE_BODY_CAP_BYTES)
  if (capped === 'too-large') {
    sendTooLargeAndClose(req, res)
    return null
  }
  if (capped.length === 0) return capped

  let parsed: unknown
  try {
    parsed = JSON.parse(capped.toString('utf8'))
  } catch {
    sendOpenAIError(res, 400, 'Request body is not valid JSON.', 'invalid_request_error', 'invalid_json')
    return null
  }

  let rewritten: unknown
  try {
    rewritten = rewriteRequestBody(route, parsed)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request body could not be processed.'
    sendOpenAIError(res, 400, message, 'invalid_request_error', 'invalid_request_error')
    return null
  }
  return Buffer.from(JSON.stringify(rewritten), 'utf8')
}

/**
 * Matches the request against `options.routes` (`404` and never forwarded if it does not match —
 * findings-2.13-r2.md item 3), then either rewrites its body (a declared, rewritable route, `POST`,
 * `rewriteRequestBody` configured) or proxies it through untouched — the same byte-for-byte path
 * every request took before rewriting existed at all, still used for every other route/method.
 */
async function proxyToUpstream(
  req: IncomingMessage,
  res: ServerResponse,
  options: ManagedGatewayOptions
): Promise<void> {
  const route = decodedRoute(routeOf(req.url))
  if (route === null || !options.routes.includes(route)) {
    sendOpenAIError(
      res,
      404,
      'No route on this session matches this request.',
      'invalid_request_error',
      'not_found'
    )
    return
  }

  const rewriteRequestBody = options.rewriteRequestBody
  const rewritable =
    rewriteRequestBody !== undefined &&
    (options.rewritableRoutes ?? []).includes(route) &&
    req.method === 'POST'

  let body: Buffer
  if (rewritable) {
    const rewritten = await readAndRewriteBody(req, res, route, rewriteRequestBody)
    if (rewritten === null) return // readAndRewriteBody already answered the client.
    body = rewritten
  } else {
    try {
      body = await readBody(req)
    } catch {
      if (!res.headersSent)
        sendOpenAIError(
          res,
          400,
          'Failed to read the request body.',
          'invalid_request_error',
          'invalid_request_error'
        )
      return
    }
  }

  await sendBodyToUpstream(req, res, options.upstream, body)
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
    proxyToUpstream(req, res, options).catch(() => {
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
