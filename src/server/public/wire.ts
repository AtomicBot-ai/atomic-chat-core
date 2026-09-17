/**
 * Talking to upstreams and writing answers back: the plumbing every public route shares.
 *
 * Upstream requests go through `node:http` rather than `fetch`. The proxy forwards the client's own
 * headers, and `fetch` refuses or rewrites several of them; it also cannot report a transport error
 * apart from a timeout without guessing. A plain request keeps the forwarded header set, the body
 * and the error under this module's control.
 *
 * Ported from: src-tauri/src/core/server/proxy.rs (`build_streaming_response`, `next_stream_chunk`,
 * the header loops in `inner_proxy_request`), utils/src/http.rs (`is_cors_header`).
 */

import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** A stream that delivers nothing for this long is abandoned (the proxy's `STREAM_IDLE_TIMEOUT`). */
export const STREAM_IDLE_TIMEOUT_MS = 600_000

export type HeaderPairs = Array<[string, string]>

/** Connection-scoped headers: they describe one hop and are never copied to the next. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
])

export function isCorsHeader(name: string): boolean {
  return name.toLowerCase().startsWith('access-control-')
}

/** The client's headers as sent, names and duplicates preserved. */
export function rawHeaderPairs(req: IncomingMessage): HeaderPairs {
  const pairs: HeaderPairs = []
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    pairs.push([req.rawHeaders[i] as string, req.rawHeaders[i + 1] as string])
  }
  return pairs
}

/** The client's headers minus the named ones (case-insensitive) and the hop-by-hop set. */
export function forwardableHeaders(req: IncomingMessage, exclude: readonly string[]): HeaderPairs {
  const skip = new Set(exclude.map((n) => n.toLowerCase()))
  return rawHeaderPairs(req).filter(([name]) => {
    const lower = name.toLowerCase()
    return !skip.has(lower) && !HOP_BY_HOP.has(lower)
  })
}

export async function readBody(stream: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

export interface UpstreamResponse {
  status: number
  headers: HeaderPairs
  contentType: string | undefined
  body: IncomingMessage
}

export interface UpstreamInit {
  method: string
  headers: HeaderPairs
  body?: Buffer | string
  /** Bounds getting connected, not the exchange: a slow but live generation is never cut off. */
  connectTimeoutMs: number
  /** Aborted when the client goes away, so a half-finished generation stops too. */
  signal?: AbortSignal
}

/** A transport failure, worded like the proxy's so logs and error bodies stay recognisable. */
export class UpstreamUnreachable extends Error {}

export function sendUpstream(url: string, init: UpstreamInit): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    let target: URL
    try {
      target = new URL(url)
    } catch (e) {
      reject(new UpstreamUnreachable(`builder error for url (${url}): ${(e as Error).message}`))
      return
    }
    const body = init.body === undefined ? undefined : Buffer.from(init.body)
    // Headers given as a list are sent exactly as listed, so `Host` has to be supplied here.
    const headers: HeaderPairs = [
      ['Host', target.host],
      ...init.headers.filter(([n]) => !['host', 'content-length'].includes(n.toLowerCase())),
    ]
    if (body !== undefined) headers.push(['Content-Length', String(body.length)])

    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    const req = send(target, { method: init.method, headers: headers.flat(), signal: init.signal })
    const fail = (e: Error) =>
      reject(new UpstreamUnreachable(`error sending request for url (${url}): ${e.message}`))

    const connectTimer = setTimeout(() => {
      req.destroy(new Error('operation timed out'))
    }, init.connectTimeoutMs)
    req.once('socket', (socket) => {
      if (!socket.connecting) clearTimeout(connectTimer)
      else socket.once('connect', () => clearTimeout(connectTimer))
    })
    req.once('error', (e) => {
      clearTimeout(connectTimer)
      fail(e)
    })
    req.once('response', (res) => {
      clearTimeout(connectTimer)
      const pairs: HeaderPairs = []
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
        pairs.push([res.rawHeaders[i] as string, res.rawHeaders[i + 1] as string])
      }
      const contentType = res.headers['content-type']
      resolve({ status: res.statusCode ?? 502, headers: pairs, contentType, body: res })
    })
    req.end(body)
  })
}

export async function readUpstreamText(response: UpstreamResponse): Promise<string> {
  try {
    return (await readBody(response.body)).toString('utf8')
  } catch (e) {
    return `Failed to read error body: ${(e as Error).message}`
  }
}

/** Write a complete answer. */
export function sendWhole(
  res: ServerResponse,
  status: number,
  headers: HeaderPairs,
  body: string | Buffer
): void {
  const bytes = Buffer.from(body)
  res.writeHead(status, [...headers, ['Content-Length', String(bytes.length)]].flat())
  res.end(bytes)
}

/** The upstream's headers as the proxy relays them: its own CORS and length dropped, ours added. */
export function relayedHeaders(upstream: UpstreamResponse, cors: HeaderPairs): HeaderPairs {
  const kept = upstream.headers.filter(([name]) => {
    const lower = name.toLowerCase()
    return !isCorsHeader(lower) && lower !== 'content-length' && !HOP_BY_HOP.has(lower)
  })
  return [...kept, ...cors]
}

/**
 * Stream an upstream body to the client as it arrives. A stall longer than the idle timeout ends
 * the response; a client that disconnects tears the upstream down.
 */
export async function pipeBody(
  res: ServerResponse,
  source: AsyncIterable<Buffer | string>,
  onClose?: () => void
): Promise<void> {
  let closed = false
  const onClientClose = () => {
    if (!res.writableFinished) {
      closed = true
      onClose?.()
    }
  }
  res.once('close', onClientClose)
  try {
    for await (const chunk of withIdleTimeout(source, STREAM_IDLE_TIMEOUT_MS)) {
      if (closed) break
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve))
    }
  } catch {
    // The upstream failed or stalled mid-stream; the client gets what arrived before it.
  } finally {
    res.off('close', onClientClose)
    if (!closed) res.end()
  }
}

/** Relay an upstream answer unchanged (`build_streaming_response`). */
export async function relay(
  res: ServerResponse,
  upstream: UpstreamResponse,
  cors: HeaderPairs
): Promise<void> {
  res.writeHead(upstream.status, relayedHeaders(upstream, cors).flat())
  await pipeBody(res, upstream.body, () => upstream.body.destroy())
}

export async function* withIdleTimeout<T>(source: AsyncIterable<T>, idleMs: number): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]()
  for (;;) {
    let timer: NodeJS.Timeout | undefined
    const idle = new Promise<'idle'>((resolve) => {
      timer = setTimeout(() => resolve('idle'), idleMs)
    })
    const step = await Promise.race([iterator.next(), idle]).finally(() => clearTimeout(timer))
    if (step === 'idle') {
      await iterator.return?.()
      return
    }
    if (step.done) return
    yield step.value
  }
}
