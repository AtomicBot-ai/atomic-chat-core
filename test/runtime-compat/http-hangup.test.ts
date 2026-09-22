import { createServer, request } from 'node:http'
import { describe, expect, it } from 'vitest'
import { clientGone } from '../../src/server/public/exchange.js'
import type { Exchange } from '../../src/server/public/exchange.js'

// Runs under vitest (Node) and must also pass under the Bun binary (bun test). Pins what the public
// server relies on to stop work nobody is waiting for: a client that hangs up before the answer has
// started is noticed. Node emits `close` on the response; Bun 1.3.10 emits nothing at all and the
// request is polled instead (ADR 2026-09-22-detect-a-client-that-hangs-up-before-the-answer-under-bun).
// PLAN.md §5.1 "Runtime-compat".

describe('http', () => {
  it('notices a client that hangs up while its answer is still being computed', async () => {
    let noticed: Promise<'gone' | 'still-there'> | undefined
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        const signal = clientGone({ req, res } as Exchange, 50)
        noticed = new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve('gone'))
          setTimeout(() => resolve('still-there'), 3_000)
        })
        void noticed.then(() => {
          // The answer is written either way; a gone client makes this a no-op on both runtimes.
          try {
            res.writeHead(200)
            res.end('late')
          } catch {
            // Bun refuses to write to a connection it knows is gone.
          }
        })
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0

    const client = request({ host: '127.0.0.1', port, path: '/v1/x', method: 'POST' })
    client.on('error', () => {})
    client.end('{}')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(noticed, 'the handler saw the request').toBeDefined()
    client.destroy()
    expect(await noticed).toBe('gone')
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, 10_000)
})
