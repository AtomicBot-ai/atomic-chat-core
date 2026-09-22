/**
 * One request as the route handlers see it: where it is going, who sent it, and how to answer with
 * the proxy's CORS headers attached.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { corsHeaders } from './gates.js'
import { sendWhole } from './wire.js'
import type { HeaderPairs } from './wire.js'
import type { PublicServerConfig, PublicServerDeps } from './types.js'
import type { RequestTrace } from './trace.js'

export interface Exchange {
  req: IncomingMessage
  res: ServerResponse
  method: string
  /** The path after prefix removal. */
  path: string
  /** The raw query string, without `?`; `undefined` when the URL had none. */
  query: string | undefined
  cors: HeaderPairs
  config: PublicServerConfig
  deps: PublicServerDeps
  /** The request body, when a route already had to read it to decide where the request goes. */
  body?: Buffer
  trace: RequestTrace
}

export function newExchange(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  config: PublicServerConfig,
  deps: PublicServerDeps,
  trace: RequestTrace
): Exchange {
  const url = req.url ?? '/'
  const q = url.indexOf('?')
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
  return {
    req,
    res,
    method: req.method ?? 'GET',
    path,
    query: q >= 0 ? url.slice(q + 1) : undefined,
    cors: corsHeaders(origin, config.trustedHosts),
    config,
    deps,
    trace,
  }
}

/** A plain-text (or pre-serialised) answer carrying the CORS headers, and `extra` before them. */
export function answer(ex: Exchange, status: number, body: string | Buffer, extra: HeaderPairs = []): void {
  sendWhole(ex.res, status, [...extra, ...ex.cors], body)
}

export function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()]
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined
}

/** Upstream connect timeout: the configured proxy timeout, which bounds connecting only. */
export function connectTimeoutMs(ex: Exchange): number {
  return Math.max(1, ex.config.proxyTimeoutSecs) * 1000
}

/** How often a request still waiting for its answer is checked for a client that already left. */
export const CLIENT_GONE_POLL_MS = 500

/**
 * Bun's `node:http` (1.3.10) tells nobody when the client hangs up before the response has started:
 * no `close` on the response or the socket, `socket.readyState` stays `open`. The native handle
 * behind the pair does flip an `aborted` flag, which is the only trace left. It hangs off the
 * response (the request drops it once its body is consumed) under a symbol described `handle`,
 * looked up once per process; absent under Node, whose `close` event is enough.
 */
let handleSymbol: symbol | null | undefined
function bunHandleAborted(res: ServerResponse): boolean {
  if (handleSymbol === undefined)
    handleSymbol = Object.getOwnPropertySymbols(res).find((s) => s.description === 'handle') ?? null
  if (handleSymbol === null) return false
  const handle = (res as unknown as Record<symbol, unknown>)[handleSymbol]
  return typeof handle === 'object' && handle !== null && (handle as { aborted?: unknown }).aborted === true
}

/** Whether the client of this request has already gone away, on either runtime. */
export function requestAborted(req: IncomingMessage, res: ServerResponse): boolean {
  return req.socket?.destroyed === true || bunHandleAborted(res)
}

/**
 * An `AbortSignal` that fires when the client disconnects before the answer is complete. Node says
 * so with `close` on the response; under Bun that event never comes for a request whose answer has
 * not started, so the request is also polled while it waits (ADR
 * 2026-09-22-detect-a-client-that-hangs-up-before-the-answer-under-bun).
 */
export function clientGone(ex: Exchange, pollMs = CLIENT_GONE_POLL_MS): AbortSignal {
  const controller = new AbortController()
  const timer = setInterval(() => {
    if (!requestAborted(ex.req, ex.res)) return
    clearInterval(timer)
    if (!ex.res.writableFinished) controller.abort()
  }, pollMs)
  timer.unref()
  ex.res.once('finish', () => clearInterval(timer))
  ex.res.once('close', () => {
    clearInterval(timer)
    if (!ex.res.writableFinished) controller.abort()
  })
  return controller.signal
}

/** `serde_json` would reject this body; the proxy answers with its own wording. */
export function invalidJsonMessage(e: unknown): string {
  return `Invalid JSON body: ${(e as Error).message}`
}
