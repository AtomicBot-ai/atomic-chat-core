/**
 * Proves a freshly minted tunnel URL reaches *this* server before it is shown to the user.
 *
 * "Registered" only means cloudflared has an edge connection. The public name still has to
 * propagate, and until it does a visitor gets Cloudflare's own error page. A QR code that opens an
 * error page is worse than a few more seconds of "Starting…", so the URL is fetched once from the
 * outside first.
 *
 * The probe goes through Cloudflare's edge *by SNI* before it ever asks DNS for the new name: the
 * edge routes on the TLS server name, so it serves the tunnel before the hostname resolves anywhere,
 * and an early OS lookup would negative-cache the NXDOMAIN (for up to half an hour on some
 * resolvers) and blind every later attempt. Only when the edge path gives nothing does the probe
 * fall back to the hostname, inside the same overall budget.
 *
 * Through the raw-socket client, not `node:https`: an agent or `lookup` override is what Bun ignores
 * silently (ADR 2026-09-17-probe-the-tunnel-through-the-raw-socket-client-with-an-address-pin).
 *
 * Ported from: src-tauri/src/core/server/remote_access/probe.rs (image-generation line, `767ff6350`).
 */

import { lookup } from 'node:dns/promises'
import { createPolicyFetch } from '../downloads/index.js'
import type { ProxyPolicy } from '../downloads/index.js'
import { hostOf } from './status.js'

/**
 * Served without an API key and exempt from Host validation (it is the Swagger document), so it
 * answers the same whatever the user configured.
 */
export const PROBE_PATH = '/openapi.json'
/**
 * `info.title` of the server's OpenAPI document. A Cloudflare error page, a captive portal or
 * somebody else's server is an *answer*, but not this one.
 */
export const PROBE_MARKER = 'Atomic Chat API Server Endpoints'
/** The real document is ~33 KB; anything far larger is not ours. */
export const PROBE_BODY_CAP = 256 * 1024

const EDGE_HOST = 'trycloudflare.com'
const EDGE_PORT = 443

export interface ProbeTimings {
  /** Leaves most of the budget to the hostname fallback. */
  edgeWaitMaxMs: number
  edgeRetryDelayMs: number
  hostnameRetryDelayMs: number
  attemptTimeoutMs: number
}

export const DEFAULT_PROBE_TIMINGS: ProbeTimings = {
  edgeWaitMaxMs: 15_000,
  edgeRetryDelayMs: 500,
  hostnameRetryDelayMs: 1_000,
  attemptTimeoutMs: 5_000,
}

/** A network that blocks the edge blocks every attempt; stop paying for it. */
const EDGE_MAX_UNREACHABLE_ROUNDS = 2

export interface EdgeAddress {
  host: string
  port: number
}

/** What one fetch established. */
export type ProbeAnswer =
  /** Our document came back. */
  | 'ours'
  /** Something answered, but not this server (yet). */
  | 'foreign'
  /** Nothing answered at all. */
  | 'unreachable'

export interface Prober {
  /**
   * `true` once `url` answers as this core's public server, `false` if it never does within
   * `budgetMs` or `signal` aborts first.
   */
  verify(url: string, budgetMs: number, signal?: AbortSignal): Promise<boolean>
}

export function bodyIsOurs(body: string): boolean {
  try {
    const json = JSON.parse(body) as { info?: { title?: unknown } } | null
    return json?.info?.title === PROBE_MARKER
  } catch {
    return false
  }
}

/** One fetch of the probe document from `baseUrl`, on its own connection. */
export async function probeOnce(
  fetchImpl: typeof fetch,
  baseUrl: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ProbeAnswer> {
  const limit = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, limit]) : limit
  let response: Response
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}${PROBE_PATH}`, {
      signal: combined,
      headers: { 'user-agent': 'atomic-chat-remote-access-probe', 'accept': 'application/json' },
    })
  } catch {
    return 'unreachable'
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    return 'foreign'
  }
  try {
    const reader = (response.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() })).getReader()
    const decoder = new TextDecoder()
    let body = ''
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > PROBE_BODY_CAP) {
        await reader.cancel().catch(() => {})
        return 'foreign'
      }
      body += decoder.decode(value, { stream: true })
    }
    return bodyIsOurs(body + decoder.decode()) ? 'ours' : 'foreign'
  } catch {
    return 'foreign'
  }
}

export interface PublicProberDeps {
  /** Cloudflare's edge addresses; at most two are tried, IPv4 first. */
  edgeAddresses?: () => Promise<EdgeAddress[]>
  /** The client for one attempt; the seam that lets a test stand in for the edge. */
  fetchFor?: (policy: ProxyPolicy) => typeof fetch
  timings?: Partial<ProbeTimings>
  /** Extra trusted CA certificates, PEM — a test hook, as for the ChatGPT endpoints. */
  ca?: ProxyPolicy['ca']
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** Cloudflare's edge addresses, IPv4 first, at most two distinct ones. */
export async function resolveEdgeAddresses(
  resolve: (host: string) => Promise<Array<{ address: string; family: number }>> = (host) =>
    lookup(host, { all: true })
): Promise<EdgeAddress[]> {
  let resolved: Array<{ address: string; family: number }>
  try {
    resolved = await resolve(EDGE_HOST)
  } catch {
    return []
  }
  const distinct = resolved.filter(
    (entry, index) => resolved.findIndex((other) => other.address === entry.address) === index
  )
  return [...distinct]
    .sort((left, right) => Number(left.family !== 4) - Number(right.family !== 4))
    .slice(0, 2)
    .map((entry) => ({ host: entry.address, port: EDGE_PORT }))
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    timer.unref?.()
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** The production prober: edge-by-SNI first, then the hostname. */
export class PublicProber implements Prober {
  private readonly timings: ProbeTimings
  private readonly edgeAddresses: () => Promise<EdgeAddress[]>
  private readonly fetchFor: (policy: ProxyPolicy) => typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>

  constructor(private readonly deps: PublicProberDeps = {}) {
    this.timings = { ...DEFAULT_PROBE_TIMINGS, ...deps.timings }
    this.edgeAddresses = deps.edgeAddresses ?? (() => resolveEdgeAddresses())
    this.fetchFor = deps.fetchFor ?? createPolicyFetch
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? defaultSleep
  }

  async verify(url: string, budgetMs: number, signal?: AbortSignal): Promise<boolean> {
    if (hostOf(url) === undefined) return false
    const deadline = this.now() + budgetMs
    if (await this.verifyThroughEdge(url, deadline, signal)) return true
    return this.verifyThroughHostname(url, deadline, signal)
  }

  private policy(extra: ProxyPolicy = {}): ProxyPolicy {
    return this.deps.ca === undefined ? extra : { ...extra, ca: this.deps.ca }
  }

  private async verifyThroughEdge(url: string, deadline: number, signal?: AbortSignal): Promise<boolean> {
    const edgeDeadline = Math.min(deadline, this.now() + this.timings.edgeWaitMaxMs)
    const addresses = await this.edgeAddresses()
    if (addresses.length === 0) return false
    let unreachableRounds = 0
    while (this.now() < edgeDeadline && !signal?.aborted) {
      let anyAnswer = false
      for (const address of addresses) {
        // The pin keeps the connection on the edge address while the TLS server name and `Host`
        // stay the tunnel's: the SNI route. A fresh client per attempt means a fresh connection.
        const pinned = this.fetchFor(this.policy({ connectTo: address }))
        const answer = await probeOnce(pinned, url, this.timings.attemptTimeoutMs, signal)
        if (answer === 'ours') return true
        if (answer === 'foreign') anyAnswer = true
      }
      if (anyAnswer) unreachableRounds = 0
      else if (++unreachableRounds >= EDGE_MAX_UNREACHABLE_ROUNDS) return false
      await this.sleep(this.timings.edgeRetryDelayMs, signal)
    }
    return false
  }

  private async verifyThroughHostname(url: string, deadline: number, signal?: AbortSignal): Promise<boolean> {
    while (this.now() < deadline && !signal?.aborted) {
      const direct = this.fetchFor(this.policy())
      if ((await probeOnce(direct, url, this.timings.attemptTimeoutMs, signal)) === 'ours') return true
      await this.sleep(this.timings.hostnameRetryDelayMs, signal)
    }
    return false
  }
}
