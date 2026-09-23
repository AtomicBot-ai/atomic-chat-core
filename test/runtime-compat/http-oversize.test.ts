import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { readJsonBody, sendError } from '../../src/server/http.js'

// Runs under vitest (Node) and must also pass under the Bun binary (bun test). Pins that a body over
// the cap is answered with the refusal on both runtimes: Bun 1.3.10 delivers an answer written while
// the request body is still arriving as an empty 200, so the reader drains first (ADR
// 2026-09-22-detect-a-client-that-hangs-up-before-the-answer-under-bun). PLAN.md §5.1 "Runtime-compat".

describe('http', () => {
  it('delivers the refusal of an oversized body', async () => {
    const limit = 1024 * 1024
    const server = createServer((req, res) => {
      void readJsonBody(req, limit).then(
        (body) => res.end(JSON.stringify(body)),
        (error: unknown) => sendError(res, error)
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0

    const refused = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      body: JSON.stringify({ blob: 'x'.repeat(5 * limit) }),
    })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({
      error: { code: 'INVALID_ARGUMENT', message: 'Request body is too large.' },
    })
    const fits = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: JSON.stringify({ a: 1 }) })
    expect(await fits.json()).toEqual({ a: 1 })
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, 10_000)
})
