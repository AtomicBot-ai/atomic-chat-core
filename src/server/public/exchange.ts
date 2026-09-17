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

/** An `AbortSignal` that fires when the client disconnects before the answer is complete. */
export function clientGone(ex: Exchange): AbortSignal {
  const controller = new AbortController()
  ex.res.once('close', () => {
    if (!ex.res.writableFinished) controller.abort()
  })
  return controller.signal
}

/** `serde_json` would reject this body; the proxy answers with its own wording. */
export function invalidJsonMessage(e: unknown): string {
  return `Invalid JSON body: ${(e as Error).message}`
}
