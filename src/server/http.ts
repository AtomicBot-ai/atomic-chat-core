/**
 * The little bit of HTTP the core needs: a path router, JSON body reading with a cap, the shared
 * error envelope `{error:{code,message,details?}}` that the app already parses, and the loopback
 * checks the control listener relies on (PLAN.md §3.6).
 *
 * Deliberately not a framework: the control surface is a dozen routes, and a dependency here would
 * have to be audited for the signed binary.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { AtomicCoreError } from '../contracts/index.js'
import type { ErrorCode } from '../contracts/index.js'

export const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024

export interface RouteMatch {
  params: Record<string, string>
}

export type Handler = (req: IncomingMessage, res: ServerResponse, match: RouteMatch) => void | Promise<void>

export interface Route {
  method: string
  /** `/atomic/v1/models/:provider/*rest/load` — `:name` matches one segment, `*name` the rest. */
  pattern: string
  handler: Handler
}

interface CompiledRoute extends Route {
  segments: string[]
}

export class Router {
  private readonly routes: CompiledRoute[] = []

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, pattern, handler, segments: splitPath(pattern) })
    return this
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler)
  }

  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler)
  }

  put(pattern: string, handler: Handler): this {
    return this.add('PUT', pattern, handler)
  }

  patch(pattern: string, handler: Handler): this {
    return this.add('PATCH', pattern, handler)
  }

  delete(pattern: string, handler: Handler): this {
    return this.add('DELETE', pattern, handler)
  }

  /** The matching route, or `undefined`; `methodMismatch` distinguishes 404 from 405. */
  find(
    method: string,
    path: string
  ): { route: Route; match: RouteMatch } | { methodMismatch: true } | undefined {
    const segments = splitPath(path)
    let methodMismatch = false
    for (const route of this.routes) {
      const params = matchSegments(route.segments, segments)
      if (!params) continue
      if (route.method !== method) {
        methodMismatch = true
        continue
      }
      return { route, match: { params } }
    }
    return methodMismatch ? { methodMismatch: true } : undefined
  }
}

function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0)
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | undefined {
  const params: Record<string, string> = {}
  let p = 0
  let a = 0
  while (p < pattern.length) {
    const seg = pattern[p] as string
    if (seg.startsWith('*')) {
      // Greedy rest-parameter, leaving room for the fixed segments that follow it.
      const remainingFixed = pattern.length - p - 1
      const take = actual.length - a - remainingFixed
      if (take < 1) return undefined
      params[seg.slice(1)] = actual.slice(a, a + take).join('/')
      a += take
      p++
      continue
    }
    if (a >= actual.length) return undefined
    const value = actual[a] as string
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(value)
    else if (seg !== value) return undefined
    p++
    a++
  }
  return a === actual.length ? params : undefined
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** HTTP status for a core error code. Anything unmapped is a 500: an unknown failure is not the caller's fault. */
export function statusForCode(code: ErrorCode): number {
  switch (code) {
    case 'UNAUTHORIZED':
    case 'AUTH_REQUIRED':
      return 401
    case 'FORBIDDEN_HOST':
      return 403
    case 'MODEL_NOT_FOUND':
    case 'MODEL_FILE_NOT_FOUND':
    case 'PROVIDER_NOT_FOUND':
    case 'MODEL_NOT_LOADED':
    case 'NO_MODEL_LOADED':
      return 404
    case 'CORE_ALREADY_RUNNING':
    case 'AUTH_CANCELLED':
      return 409
    case 'AUTH_FAILED':
    case 'UPSTREAM_ERROR':
      return 502
    case 'INVALID_ARGUMENT':
      return 400
    case 'CORE_NOT_RUNNING':
    case 'FOUNDATION_MODELS_UNAVAILABLE':
      return 503
    case 'MODEL_LOAD_TIMED_OUT':
    case 'SERVER_START_TIMED_OUT':
      return 504
    default:
      return 500
  }
}

export function toCoreError(error: unknown): AtomicCoreError {
  if (error instanceof AtomicCoreError) return error
  const e = error as { code?: unknown; message?: unknown }
  const code = typeof e?.code === 'string' ? (e.code as ErrorCode) : 'INTERNAL_ERROR'
  return new AtomicCoreError(code, typeof e?.message === 'string' ? e.message : String(error))
}

export function sendError(res: ServerResponse, error: unknown, status?: number): void {
  const coreError = toCoreError(error)
  sendJson(res, status ?? statusForCode(coreError.code), { error: coreError.toJSON() })
}

export async function readJsonBody<T = unknown>(
  req: IncomingMessage,
  limit = MAX_JSON_BODY_BYTES
): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > limit)
      throw new AtomicCoreError('INVALID_ARGUMENT', 'Request body is too large.', `> ${limit} bytes`)
    chunks.push(buf)
  }
  if (size === 0) return {} as T
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
  } catch (e) {
    throw new AtomicCoreError('INVALID_ARGUMENT', 'Request body is not valid JSON.', (e as Error).message)
  }
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1'])

/** Peer address check: the control listener answers only to processes on this machine. */
export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false
  const clean = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return clean === '127.0.0.1' || clean.startsWith('127.') || clean === '::1' || clean === '0:0:0:0:0:0:0:1'
}

/**
 * Host-header check, which is what stops a browser page from posting to the control port through
 * DNS rebinding: the name must itself be loopback, not merely resolve to it today.
 */
export function hostHeaderIsLoopback(host: string | undefined | null): boolean {
  if (!host) return false
  const value = host.trim().toLowerCase()
  const hostname = value.startsWith('[') ? value.slice(1, value.indexOf(']')) : (value.split(':')[0] ?? '')
  return LOOPBACK_HOSTNAMES.has(hostname)
}

/** `?name=value` for a request path. */
export function queryOf(req: IncomingMessage): URLSearchParams {
  const raw = req.url ?? '/'
  const q = raw.indexOf('?')
  return new URLSearchParams(q >= 0 ? raw.slice(q + 1) : '')
}

export function pathOf(req: IncomingMessage): string {
  const raw = req.url ?? '/'
  const q = raw.indexOf('?')
  return q >= 0 ? raw.slice(0, q) : raw
}
