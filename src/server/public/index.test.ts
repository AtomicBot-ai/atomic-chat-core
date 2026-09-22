import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { ErrorReport } from '../../telemetry/index.js'
import { stoppedState } from './index.js'
import { closeAll, startPublic } from '../../../test/helpers/public-server.js'

afterEach(closeAll)

describe('routing', () => {
  it('routes an absolute-form request target by its path', async () => {
    const server = await startPublic({})
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: server.port,
        path: `http://127.0.0.1:${server.port}/v1/models`,
        headers: { host: `127.0.0.1:${server.port}` },
      })
      req.on('response', (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(200)
  })
})

describe('lifecycle', () => {
  it('reports where it listens, and a stopped state that remembers it', async () => {
    const server = await startPublic({}, { prefix: 'api/', apiKey: 'secret' })

    expect(server.url).toBe(`http://127.0.0.1:${server.port}/api`)
    expect(server.state()).toMatchObject({
      running: true,
      prefix: '/api',
      requires_api_key: true,
      pid: process.pid,
    })
    expect(stoppedState(server.state())).toMatchObject({ running: false, port: server.port, pid: null })
    expect(stoppedState()).toMatchObject({ port: 1337, prefix: '/v1' })
  })

  it('refuses a port that is already taken, unless asked to fall back to a free one', async () => {
    const first = await startPublic({})
    await expect(startPublic({}, { port: first.port })).rejects.toMatchObject({ code: 'IO_ERROR' })

    const fallback = await startPublic({}, { port: first.port, fallbackPort: true })
    expect(fallback.port).not.toBe(first.port)
    expect((await fetch(`http://127.0.0.1:${fallback.port}/v1/models`)).status).toBe(200)
    await expect(startPublic({}, { host: '203.0.113.1', port: 0, fallbackPort: true })).rejects.toBeDefined()
    await expect(
      startPublic({}, { host: '203.0.113.1', port: first.port, fallbackPort: true })
    ).rejects.toMatchObject({
      code: 'IO_ERROR',
      message: `Cannot listen on 203.0.113.1:${first.port}, nor on any free port there.`,
    })
  })
})

describe('error reports', () => {
  it('reports a request that failed on our side and still answers 500', async () => {
    const captured: ErrorReport[] = []
    const server = await startPublic({
      listLocal: () => {
        throw new TypeError('listing bug')
      },
      errors: { capture: (report) => captured.push(report) },
    })
    expect((await fetch(`http://127.0.0.1:${server.port}/v1/models`)).status).toBe(500)
    expect(captured).toEqual([expect.objectContaining({ source: 'public_server', level: 'error' })])
  })
})
