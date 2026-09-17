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

/**
 * The host, key and hidden-path checks, in the proxy's order. `undefined` means the request passes
 * and should be routed.
 */
export function gate(
  req: IncomingMessage,
  path: string,
  config: PublicServerConfig
): EarlyResponse | undefined {
  const host = header(req, 'host')
  const origin = header(req, 'origin')
  const cors = corsHeaders(origin, config.trustedHosts)
  const whitelisted = WHITELISTED_PATHS.has(path)

  if (!whitelisted) {
    if (host === '') return { status: 400, headers: cors, body: 'Missing host header', kind: 'bad_request' }
    if (!isValidHost(host, config.trustedHosts))
      return { status: 403, headers: cors, body: hostMessage(host), kind: 'host' }

    if (config.apiKey !== '') {
      // `Bearer ` is matched exactly, case included, as the proxy does.
      const auth = header(req, 'authorization')
      const bearerOk = auth.startsWith('Bearer ') && auth.slice('Bearer '.length) === config.apiKey
      const keyOk = header(req, 'x-api-key') === config.apiKey
      if (!bearerOk && !keyOk) {
        return { status: 401, headers: cors, body: 'Invalid or missing authorization token', kind: 'auth' }
      }
    }
  }

  if (path.includes('/configs')) return { status: 404, headers: cors, body: 'Not Found', kind: 'hidden' }
  return undefined
}
