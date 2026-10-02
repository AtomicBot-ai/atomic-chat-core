import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createDecisionHttp, DecisionAbortedError, DecisionTimeoutError } from './http.js'

let server: Server | undefined

afterEach(async () => {
  server?.closeAllConnections()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
})

interface Seen {
  method: string
  headers: IncomingMessage['headers']
  body: Buffer
}

async function serve(handler: (seen: Seen, res: ServerResponse) => void): Promise<string> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () =>
      handler({ method: req.method ?? '', headers: req.headers, body: Buffer.concat(chunks) }, res)
    )
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

describe('createDecisionHttp', () => {
  it('sends the bytes as given, with the bearer key and a JSON content type', async () => {
    let seen: Seen | undefined
    const base = await serve((s, res) => {
      seen = s
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    // `1.0` and a big integer survive only if nobody parses the body on the way.
    const body = Buffer.from('{"state":1.0,"n":12345678901234567890,"questions":{"2":{},"1":{}}}')
    const answer = await createDecisionHttp().request(`${base}/v1/systemone`, {
      method: 'POST',
      apiKey: 'secret',
      body,
      timeoutMs: 2_000,
    })
    expect(answer).toEqual({ status: 200, text: '{"ok":true}' })
    expect(seen?.method).toBe('POST')
    expect(seen?.headers['authorization']).toBe('Bearer secret')
    expect(seen?.headers['content-type']).toBe('application/json')
    expect(createHash('sha256').update(seen!.body).digest('hex')).toBe(
      createHash('sha256').update(body).digest('hex')
    )
  })

  it('sends a GET without a body or a key when none is given', async () => {
    let seen: Seen | undefined
    const base = await serve((s, res) => {
      seen = s
      res.writeHead(503)
      res.end('loading')
    })
    expect(await createDecisionHttp().request(`${base}/health`, { method: 'GET', timeoutMs: 2_000 })).toEqual(
      {
        status: 503,
        text: 'loading',
      }
    )
    expect(seen?.headers['authorization']).toBeUndefined()
    expect(seen?.body.length).toBe(0)
  })

  it('gives up at the deadline with a timeout error', async () => {
    const base = await serve(() => {
      /* never answers */
    })
    const started = Date.now()
    await expect(
      createDecisionHttp().request(`${base}/v1/router/score`, { method: 'POST', body: '{}', timeoutMs: 100 })
    ).rejects.toBeInstanceOf(DecisionTimeoutError)
    expect(Date.now() - started).toBeLessThan(1_500)
  })

  it("stops when the caller's signal fires, before or during the request", async () => {
    const base = await serve(() => {})
    const controller = new AbortController()
    const pending = createDecisionHttp().request(`${base}/x`, {
      method: 'GET',
      timeoutMs: 5_000,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 50)
    await expect(pending).rejects.toBeInstanceOf(DecisionAbortedError)
    const aborted = AbortSignal.abort()
    await expect(
      createDecisionHttp().request(`${base}/x`, { method: 'GET', timeoutMs: 5_000, signal: aborted })
    ).rejects.toBeInstanceOf(DecisionAbortedError)
  })

  it('reports a refused connection as a plain error', async () => {
    const base = await serve(() => {})
    const url = `${base}/health`
    server!.closeAllConnections()
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
    const error = await createDecisionHttp()
      .request(url, { method: 'GET', timeoutMs: 2_000 })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(DecisionTimeoutError)
    expect(error).not.toBeInstanceOf(DecisionAbortedError)
  })
})
