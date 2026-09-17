/**
 * Replay of the Local API Server exchanges recorded from the Rust proxy (PLAN.md §4, stage 4b).
 *
 * Every case is re-run exactly as the dump ran it (`proxy_http_fixture_dump.rs`): a scriptable stub
 * upstream, the server started with the case's setup, one raw HTTP/1.1 request over a socket. The
 * response and the upstream calls are then described and normalised the way the dump described and
 * normalised Rust's, and compared as a whole. Raw sockets, not an HTTP client, so a case can send
 * exactly the headers it lists — including no `Host` at all.
 */

import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { loadFixtureSet } from './fixtures.js'
import { PublicServer } from '../../src/server/public/index.js'
import type { CtxIncreaseOutcome, LocalTarget, PublicServerDeps } from '../../src/server/public/index.js'
import { modelIdsMatch } from '../../src/router/index.js'
import type { RemoteProvider } from '../../src/router/index.js'
import type { JsonValue } from '../../src/server/shims/index.js'

interface Reply {
  status: number
  content_type: string
  body: string
}

interface Input {
  setup: {
    prefix: string
    api_key: string
    trusted_hosts: string[]
    sessions: 'loaded' | 'none' | 'unreachable'
    remote_provider: boolean
    ctx_responder: CtxIncreaseOutcome | null
  }
  request: { method: string; path: string; headers: Array<[string, string]>; body: string | null }
  upstream: Array<{ path: string; replies: Reply[] }>
}

interface Expected {
  response: { status: number; headers: Record<string, string>; body: JsonValue }
  upstream_calls: Array<{ method: string; path: string; headers: Record<string, string>; body: JsonValue }>
}

const UPSTREAM_HEADERS = [
  'authorization',
  'x-api-key',
  'content-type',
  'x-custom',
  'x-client-trace',
  'anthropic-version',
  'openai-beta',
  'origin',
]
const RESPONSE_HEADERS = [
  'content-type',
  'allow',
  'vary',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-max-age',
  'x-upstream-trace',
]
const LARGE_BODY_BYTES = 64 * 1024
const TRANSPORT_ERROR_LEADS = [
  'The model backend is not reachable: ',
  'Proxy request to model failed: ',
  'Failed to fetch metrics from llama-server: ',
]

/**
 * Cases where the port deliberately differs from the recorded Rust behaviour, with the reason in
 * `index.json` → `comparator_notes.known_divergence`. The expectation is corrected, never skipped.
 */
const REMOTE_BEARER = 'Bearer sk-remote'

/**
 * Where the port deliberately differs from the recorded Rust behaviour, with the reason in
 * `index.json` → `comparator_notes.known_divergence`. The expectation is corrected, never skipped.
 * The Rust proxy stored a provider's custom headers but never sent them; the port sends them on
 * every call to that provider.
 */
function applyKnownDivergence(expected: Expected): void {
  for (const call of expected.upstream_calls) {
    if (call.headers['authorization'] === REMOTE_BEARER) call.headers['x-custom'] = 'from-provider'
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  )
}

function close(server: Server): Promise<void> {
  server.closeAllConnections()
  return new Promise((resolve) => server.close(() => resolve()))
}

function parseJsonOr(text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue
  } catch {
    return text
  }
}

/** The stub upstream: per path, successive replies with the last repeating; every call recorded. */
async function startStub(rules: Input['upstream']) {
  const calls: Expected['upstream_calls'] = []
  const counters = new Map<string, number>()
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const headers: Record<string, string> = {}
      for (const name of UPSTREAM_HEADERS) {
        const v = req.headers[name]
        if (typeof v === 'string') headers[name] = v
      }
      const path = req.url ?? ''
      calls.push({
        method: req.method ?? '',
        path,
        headers,
        body: parseJsonOr(Buffer.concat(chunks).toString('utf8')),
      })
      const rule = rules.find((r) => r.path === path.split('?')[0])
      let reply: Reply = { status: 404, content_type: 'text/plain', body: 'stub: no rule for this path' }
      if (rule) {
        const n = counters.get(rule.path) ?? 0
        reply = rule.replies[Math.min(n, rule.replies.length - 1)] as Reply
        counters.set(rule.path, n + 1)
      }
      res.writeHead(reply.status, { 'content-type': reply.content_type, 'x-upstream-trace': 'stub' })
      res.end(reply.body)
    })
  })
  return { server, port: await listen(server), calls }
}

async function closedPort(): Promise<number> {
  const server = createServer()
  const port = await listen(server)
  await close(server)
  return port
}

function sendRaw(port: number, request: Input['request']): Promise<Buffer> {
  let head = `${request.method} ${request.path} HTTP/1.1\r\n`
  const host = request.headers.find(([n]) => n.toLowerCase() === 'host')
  if (!host) head += `Host: 127.0.0.1:${port}\r\n`
  else if (host[1] !== '') head += `Host: ${host[1]}\r\n`
  for (const [name, value] of request.headers)
    if (name.toLowerCase() !== 'host') head += `${name}: ${value}\r\n`
  if (request.body !== null) {
    head += 'Content-Type: application/json\r\n'
    head += `Content-Length: ${Buffer.byteLength(request.body)}\r\n`
  }
  head += 'Connection: close\r\n\r\n'
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(head + (request.body ?? '')))
    const chunks: Buffer[] = []
    const done = () => {
      socket.destroy()
      resolve(Buffer.concat(chunks))
    }
    // Read by the response's own framing, not to end-of-stream: Bun's `node:http` does not always
    // close the connection after an answer written asynchronously, even with `Connection: close`.
    socket.on('data', (c: Buffer) => {
      chunks.push(c)
      if (responseComplete(Buffer.concat(chunks))) done()
    })
    socket.on('end', done)
    socket.on('error', reject)
  })
}

function responseComplete(raw: Buffer): boolean {
  const split = raw.indexOf('\r\n\r\n')
  if (split < 0) return false
  const head = raw.subarray(0, split).toString('utf8').toLowerCase()
  const body = raw.subarray(split + 4)
  const length = /\r\ncontent-length:\s*(\d+)/.exec(head)
  if (length) return body.length >= Number(length[1])
  if (/\r\ntransfer-encoding:\s*chunked/.test(head))
    return body.includes('\r\n0\r\n\r\n') || body.subarray(0, 5).toString() === '0\r\n\r\n'
  return false
}

function dechunk(data: Buffer): Buffer {
  const out: Buffer[] = []
  let rest = data
  for (;;) {
    const lineEnd = rest.indexOf('\r\n')
    if (lineEnd < 0) break
    const size = parseInt(rest.subarray(0, lineEnd).toString().split(';')[0]?.trim() ?? '0', 16) || 0
    rest = rest.subarray(lineEnd + 2)
    if (size === 0 || rest.length < size) break
    out.push(rest.subarray(0, size))
    rest = rest.subarray(Math.min(size + 2, rest.length))
  }
  return Buffer.concat(out)
}

function parseResponse(raw: Buffer) {
  const split = raw.indexOf('\r\n\r\n')
  const lines = raw.subarray(0, split).toString('utf8').split('\r\n')
  const status = Number(lines[0]?.split(' ')[1])
  const headers: Record<string, string> = {}
  let chunked = false
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (name === 'transfer-encoding' && value.toLowerCase() === 'chunked') chunked = true
    if (RESPONSE_HEADERS.includes(name)) headers[name] = value
  }
  const rest = raw.subarray(split + 4)
  return { status, headers, body: chunked ? dechunk(rest) : rest }
}

function describeBody(contentType: string | undefined, bytes: Buffer): JsonValue {
  if (bytes.length > LARGE_BODY_BYTES) {
    return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
  }
  const text = bytes.toString('utf8')
  if (contentType?.includes('event-stream')) {
    return {
      sse: text
        .split('\n\n')
        .filter((frame) => frame.trim() !== '')
        .map((frame) => {
          let event: JsonValue = null
          let data: JsonValue = null
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
            else if (line.startsWith('data:')) data = parseJsonOr(line.slice('data:'.length).trim())
          }
          return { event, data }
        }),
    }
  }
  if (text.trim() !== '') {
    try {
      const json = JSON.parse(text) as JsonValue
      if (json && typeof json === 'object' && !Array.isArray(json) && Array.isArray(json['data'])) {
        const id = (x: JsonValue) =>
          x && typeof x === 'object' && !Array.isArray(x) && typeof x['id'] === 'string' ? x['id'] : ''
        json['data'].sort((a, b) => (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0))
      }
      return { json }
    } catch {
      // not JSON: described as text below
    }
  }
  const at = text.indexOf('Invalid JSON body: ')
  return { text: at < 0 ? text : `${text.slice(0, at)}Invalid JSON body: <parse error>` }
}

function normalise(value: JsonValue, ports: Array<[number, string]>): JsonValue {
  if (typeof value === 'string') {
    let s = value
    for (const [port, name] of ports) s = s.split(`:${port}`).join(`:<${name}>`)
    for (const lead of TRANSPORT_ERROR_LEADS) {
      const at = s.indexOf(lead)
      if (at >= 0) s = `${s.slice(0, at + lead.length)}<transport error>`
    }
    for (const [prefix, placeholder] of [
      ['resp_', '<resp_id>'],
      ['msg_', '<msg_id>'],
      ['fc_', '<fc_id>'],
    ] as const) {
      if (s.startsWith(prefix) && /^[0-9a-f]{32}$/i.test(s.slice(prefix.length))) return placeholder
    }
    return s
  }
  if (Array.isArray(value)) return value.map((v) => normalise(v, ports))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalise(v, ports)]))
  }
  return value
}

async function runCase(input: Input): Promise<Expected> {
  const stub = await startStub(input.upstream)
  const sessionPort = input.setup.sessions === 'unreachable' ? await closedPort() : stub.port
  const sessions: LocalTarget[] =
    input.setup.sessions === 'none'
      ? []
      : [
          {
            provider: 'llamacpp-upstream',
            modelId: 'local.model-7b',
            port: sessionPort,
            apiKey: 'session-key',
            isEmbedding: false,
          },
          {
            provider: 'llamacpp-upstream',
            modelId: 'embed-model',
            port: stub.port,
            apiKey: 'session-key',
            isEmbedding: true,
          },
        ]
  const providers = new Map<string, RemoteProvider>()
  if (input.setup.remote_provider) {
    providers.set('cloudprov', {
      provider: 'cloudprov',
      apiKey: 'sk-remote',
      baseUrl: `http://127.0.0.1:${stub.port}/v1`,
      customHeaders: [{ header: 'X-Custom', value: 'from-provider' }],
      models: ['cloud-model'],
    })
  }
  const deps: PublicServerDeps = {
    findLocal: (provider, modelId) =>
      sessions.find((s) => s.provider === provider && modelIdsMatch(s.modelId, modelId)),
    listLocal: () => sessions,
    providers: () => providers,
    // No responder in the dump meant the request would have waited out its timeout and failed.
    increaseCtx: () => Promise.resolve(input.setup.ctx_responder ?? { ok: false, reason: 'timeout' }),
  }
  const server = await PublicServer.start(deps, {
    host: '127.0.0.1',
    port: 0,
    prefix: input.setup.prefix,
    apiKey: input.setup.api_key,
    trustedHosts: input.setup.trusted_hosts,
  })
  try {
    const response = parseResponse(await sendRaw(server.port, input.request))
    const body = describeBody(response.headers['content-type'], response.body)
    return normalise(
      {
        response: { status: response.status, headers: response.headers, body },
        upstream_calls: stub.calls,
      } as unknown as JsonValue,
      [
        [stub.port, 'upstream_port'],
        [sessionPort, 'session_port'],
        [server.port, 'proxy_port'],
      ]
    ) as unknown as Expected
  } finally {
    await server.close()
    await close(stub.server)
  }
}

describe('proxy-http', () => {
  const { cases } = loadFixtureSet<Input, Expected>('proxy-http')

  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const expected = structuredClone(c.expected)
    applyKnownDivergence(expected)
    expect(await runCase(c.input)).toEqual(expected)
  })
})
