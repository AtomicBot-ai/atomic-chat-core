import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CONTROL_TOKEN as TOKEN,
  startControlHarness as start,
} from '../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../test/helpers/control-harness.js'

let h: ControlHarness

beforeEach(async () => {
  h = await start()
})
afterEach(() => h.server.close())

describe('gates', () => {
  it('rejects a missing, malformed or wrong token', async () => {
    expect((await fetch(`${h.server.url}/atomic/v1/health`)).status).toBe(401)
    expect(
      (await fetch(`${h.server.url}/atomic/v1/health`, { headers: { authorization: 'Basic x' } })).status
    ).toBe(401)
    expect(
      (await fetch(`${h.server.url}/atomic/v1/health`, { headers: { authorization: `Bearer ${TOKEN}x` } }))
        .status
    ).toBe(401)
    const body = (await (await fetch(`${h.server.url}/atomic/v1/health`)).json()) as {
      error: { code: string }
    }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('rejects a non-loopback Host header even with a valid token', async () => {
    // `fetch` refuses to set Host, so this goes through the raw client — the header is exactly what
    // a DNS-rebinding attempt from a browser would carry.
    const res = await rawRequest('/atomic/v1/health', {
      host: 'evil.example.com',
      authorization: `Bearer ${TOKEN}`,
    })
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body) as object).toMatchObject({ error: { code: 'FORBIDDEN_HOST' } })
  })

  it('binds loopback only', () => {
    expect(h.server.host).toBe('127.0.0.1')
    expect(h.server.port).toBeGreaterThan(0)
  })

  it('answers 404 for an unknown route and 405 for the wrong method', async () => {
    expect((await h.get('/atomic/v1/nope')).status).toBe(404)
    expect((await h.get('/atomic/v1/health', { method: 'POST' })).status).toBe(405)
  })
})

function rawRequest(
  path: string,
  headers: Record<string, string>
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: h.server.host, port: h.server.port, path, method: 'GET', headers },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}
