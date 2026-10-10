/**
 * The checks every request passes before it is routed: prefix stripping, the trusted-host gate, the
 * API key, and CORS (PLAN.md §4 stage 4b).
 *
 * Ported from: src-tauri/src/core/server/proxy.rs (`inner_proxy_request` preamble,
 * `add_cors_headers_with_host_and_origin`), src-tauri/utils/src/{http,path}.rs.
 *
 * Error bodies here are plain text, not JSON, because that is what clients of the app's server have
 * always received; the wording is part of the contract (the host message tells the user where in
 * Settings to fix it).
 */

import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { PublicServerConfig } from './types.js'

/** Paths that answer without the host and key checks: the API documentation. */
export const WHITELISTED_PATHS = new Set([
  '/',
  '/openapi.json',
  '/docs/swagger-ui.css',
  '/docs/swagger-ui-bundle.js',
  '/docs/swagger-ui-standalone-preset.js',
])

/** Preflight skips the host check only for these. */
const PREFLIGHT_WHITELIST = new Set(['/', '/openapi.json'])

const DEFAULT_VALID_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', 'host.docker.internal']

export const CORS_ALLOW_METHODS = 'GET, POST, PUT, DELETE, OPTIONS, PATCH'
export const CORS_ALLOW_HEADERS =
  'Authorization, Content-Type, Host, Accept, Accept-Language, Cache-Control, Connection, DNT, If-Modified-Since, Keep-Alive, Origin, User-Agent, X-Requested-With, X-CSRF-Token, X-Forwarded-For, X-Forwarded-Proto, X-Forwarded-Host, authorization, content-type, x-api-key'

const PREFLIGHT_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']
const PREFLIGHT_HEADERS = [
  'accept',
  'accept-language',
  'authorization',
  'cache-control',
  'connection',
  'content-type',
  'dnt',
  'host',
  'if-modified-since',
  'keep-alive',
  'origin',
  'user-agent',
  'x-api-key',
  'x-csrf-token',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-requested-with',
  'x-stainless-arch',
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-package-version',
  'x-stainless-retry-count',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'x-stainless-timeout',
]

/** A response decided before routing: status, headers in insertion order, body. */
export interface EarlyResponse {
  status: number
  headers: Array<[string, string]>
  body: string
  /** Why the request was refused, as analytics labels it; `hidden` is not reported at all. */
  kind?: 'host' | 'bad_request' | 'auth' | 'hidden'
}

/**
 * `remove_prefix`: strips the prefix when the path starts with it — as a string, not a path segment,
 * so `/v1models` becomes `/models` under `/v1`. That is how the Rust proxy has always behaved, and a
 * client relying on it would break if this were tightened.
 */
export function removePrefix(path: string, prefix: string): string {
  if (prefix === '' || !path.startsWith(prefix)) return path
  const rest = path.slice(prefix.length)
  if (rest === '') return '/'
  return rest.startsWith('/') ? rest : `/${rest}`
}

/** `extract_host_from_origin`: `scheme://host[:port][/path]` → `host[:port]`. */
export function extractHostFromOrigin(origin: string): string {
  const parts = origin.split('://')
  const afterScheme = parts[1]
  if (afterScheme === undefined) return origin
  return afterScheme.split('/')[0] ?? afterScheme
}

function hostWithoutPort(host: string): string {
  if (host.startsWith('[')) return (host.split(']')[0] ?? host).replace(/^\[+/, '')
  return host.split(':')[0] ?? host
}

/**
 * `is_valid_host`. Note what is *not* trusted by default: the IPv6 loopback `[::1]`. That is the
 * existing behaviour, recorded by the fixtures, and changing it would widen what a default install
 * accepts.
 */
export function isValidHost(host: string, trustedHosts: readonly string[]): boolean {
  if (trustedHosts.includes('*')) return true
  if (host === '') return false
  const bare = hostWithoutPort(host).toLowerCase()
  if (DEFAULT_VALID_HOSTS.includes(bare)) return true
  const lower = host.toLowerCase()
  return trustedHosts.some((valid) => {
    const validLower = valid.toLowerCase()
    return lower === validLower || bare === hostWithoutPort(valid).toLowerCase()
  })
}

/** The CORS headers every routed response carries. The origin is reflected only when trusted. */
export function corsHeaders(origin: string, trustedHosts: readonly string[]): Array<[string, string]> {
  const headers: Array<[string, string]> = [
    ['Access-Control-Allow-Methods', CORS_ALLOW_METHODS],
    ['Access-Control-Allow-Headers', CORS_ALLOW_HEADERS],
    ['Vary', 'Origin'],
  ]
  if (origin !== '' && isValidHost(extractHostFromOrigin(origin), trustedHosts)) {
    headers.push(['Access-Control-Allow-Origin', origin], ['Access-Control-Allow-Credentials', 'true'])
  }
  return headers
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name]
  return typeof value === 'string' ? value : Array.isArray(value) ? (value[0] ?? '') : ''
}

/**
 * `a === b`, but on the time a key comparison takes rather than where the first differing byte is —
 * a client guessing the key one byte at a time cannot use response latency to find it. Unequal
 * lengths are rejected before `timingSafeEqual`, which throws rather than compares on those; the
 * length itself is not the secret, so leaking it costs nothing a `===` check would not already.
 */
function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

export function hostMessage(host: string): string {
  return (
    `Host '${host}' is not in Trusted Hosts. Add this server's address (e.g. its LAN IP or hostname) ` +
    `in Settings → Local API Server → Trusted Hosts, or use '*' to allow all.`
  )
}

/** Answer a CORS preflight. Preflight never checks the API key: browsers do not send it. */
export function preflight(req: IncomingMessage, config: PublicServerConfig): EarlyResponse {
  const host = header(req, 'host')
  const origin = header(req, 'origin')
  const requestedMethod = header(req, 'access-control-request-method')
  if (
    requestedMethod !== '' &&
    !PREFLIGHT_METHODS.some((m) => m.toLowerCase() === requestedMethod.toLowerCase())
  ) {
    return { status: 405, headers: [], body: 'Method not allowed' }
  }

  // The raw path, before prefix stripping: the preflight whitelist is matched as the client sent it.
  const path = (req.url ?? '/').split('?')[0] ?? '/'
  const trusted = PREFLIGHT_WHITELIST.has(path) || (host !== '' && isValidHost(host, config.trustedHosts))
  if (!trusted) return { status: 403, headers: [], body: hostMessage(host) }

  const requestedHeaders = header(req, 'access-control-request-headers')
  if (requestedHeaders !== '') {
    const ok = requestedHeaders
      .split(',')
      .map((h) => h.trim())
      .every((h) => PREFLIGHT_HEADERS.some((allowed) => allowed.toLowerCase() === h.toLowerCase()))
    if (!ok) return { status: 403, headers: [], body: 'Headers not allowed' }
  }

  const headers: Array<[string, string]> = [
    ['Access-Control-Allow-Methods', PREFLIGHT_METHODS.join(', ')],
    ['Access-Control-Allow-Headers', PREFLIGHT_HEADERS.join(', ')],
    ['Access-Control-Max-Age', '86400'],
    ['Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers'],
  ]
  if (origin !== '' && isValidHost(extractHostFromOrigin(origin), config.trustedHosts)) {
    headers.push(['Access-Control-Allow-Origin', origin], ['Access-Control-Allow-Credentials', 'true'])
  }
  return { status: 200, headers, body: '' }
}

/** What {@link hostAndKeyGate} needs: a shape `PublicServerConfig` also satisfies. */
export interface HostAndKeyConfig {
  /** Key clients must present; empty disables the check. Ignored when `apiKeys` is set. */
  apiKey: string
  /**
   * The host's keyring (`AtomicCoreOptions.publicApiKeys`): when set, a client must present one of
   * these and `apiKey` is ignored. An empty list refuses every client; an empty entry matches nothing.
   */
  apiKeys?: readonly string[]
  /** Hosts allowed besides the built-in loopback names; `*` allows every host. */
  trustedHosts: readonly string[]
}

/**
 * The Host and Bearer-key checks alone, with no path whitelist, CORS or hidden-path behaviour: what
 * a listener that has no docs endpoints and must authenticate every request needs (the managed
 * session gateway, `runtime/managed-text/gateway.ts`). `undefined` means both checks passed.
 */
export function hostAndKeyGate(req: IncomingMessage, config: HostAndKeyConfig): EarlyResponse | undefined {
  const host = header(req, 'host')
  if (host === '') return { status: 400, headers: [], body: 'Missing host header', kind: 'bad_request' }
  if (!isValidHost(host, config.trustedHosts))
    return { status: 403, headers: [], body: hostMessage(host), kind: 'host' }

  const keys = config.apiKeys ?? (config.apiKey !== '' ? [config.apiKey] : undefined)
  if (keys !== undefined) {
    // `Bearer ` is matched exactly, case included, as the proxy does.
    const auth = header(req, 'authorization')
    const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined
    const xApiKey = header(req, 'x-api-key')
    const matches = (presented: string) =>
      keys.some((key) => key !== '' && timingSafeEqualString(presented, key))
    const bearerOk = bearer !== undefined && matches(bearer)
    const keyOk = matches(xApiKey)
    if (!bearerOk && !keyOk) {
      return { status: 401, headers: [], body: 'Invalid or missing authorization token', kind: 'auth' }
    }
  }
  return undefined
}

/**
 * The host, key and hidden-path checks, in the proxy's order. `undefined` means the request passes
 * and should be routed.
 */
export function gate(
  req: IncomingMessage,
  path: string,
  config: PublicServerConfig
): EarlyResponse | undefined {
  const origin = header(req, 'origin')
  const cors = corsHeaders(origin, config.trustedHosts)
  const whitelisted = WHITELISTED_PATHS.has(path)

  if (!whitelisted) {
    const refused = hostAndKeyGate(req, config)
    if (refused) return { ...refused, headers: cors }
  }

  if (path.includes('/configs')) return { status: 404, headers: cors, body: 'Not Found', kind: 'hidden' }
  return undefined
}
