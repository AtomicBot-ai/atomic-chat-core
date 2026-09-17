/**
 * A scriptable upstream and a public server wired to in-memory sessions and providers, for the
 * unit tests beside `src/server/public/*`. Everything started is closed by `closeAll()`.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PublicServer } from '../../src/server/public/index.js'
import type { LocalTarget, PublicServerDeps, PublicServerOptions } from '../../src/server/public/index.js'
import type { RemoteProvider } from '../../src/router/index.js'

export type UpstreamHandler = (req: IncomingMessage, body: string, res: ServerResponse) => void

const closers: Array<() => Promise<void>> = []

export async function closeAll(): Promise<void> {
  for (const close of closers.splice(0).reverse()) await close()
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  return new Promise<void>((resolve) => server.close(() => resolve()))
}

export async function startUpstream(handler: UpstreamHandler): Promise<{ port: number; server: Server }> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('end', () => handler(req, body, res))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => closeServer(server))
  return { port: (server.address() as AddressInfo).port, server }
}

/** A port that was just free and has nothing listening on it. */
export async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await closeServer(server)
  return port
}

export function localSession(port: number, over: Partial<LocalTarget> = {}): LocalTarget {
  return { provider: 'llamacpp-upstream', modelId: 'demo', port, apiKey: 'k', isEmbedding: false, ...over }
}

export function remoteProvider(over: Partial<RemoteProvider> = {}): RemoteProvider {
  return {
    provider: 'cloud',
    apiKey: 'sk',
    baseUrl: 'http://127.0.0.1:9/v1',
    customHeaders: [],
    models: ['cloud-model'],
    ...over,
  }
}

export async function startPublic(
  deps: Partial<PublicServerDeps> & { sessions?: LocalTarget[]; remote?: RemoteProvider[] },
  options: PublicServerOptions = {}
): Promise<PublicServer> {
  const { sessions = [], remote = [], ...overrides } = deps
  const providers = new Map(remote.map((p) => [p.provider, p]))
  const server = await PublicServer.start(
    {
      findLocal: (provider, id) => sessions.find((s) => s.provider === provider && s.modelId === id),
      listLocal: () => sessions,
      providers: () => providers,
      increaseCtx: () => Promise.resolve({ ok: false, reason: 'at_max' }),
      ...overrides,
    },
    { host: '127.0.0.1', port: 0, ...options }
  )
  closers.push(() => server.close())
  return server
}

export function postJson(
  server: PublicServer,
  path: string,
  body: unknown,
  init: RequestInit = {}
): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  })
}
