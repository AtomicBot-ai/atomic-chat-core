import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSdHttpClient } from './http.js'

let server: Server
let base = ''
const seen: Array<{ method: string; url: string; type: string | undefined; body: string }> = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => (body += chunk))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', type: req.headers['content-type'], body })
      if (req.url === '/slow') {
        setTimeout(() => res.end('late'), 500)
        return
      }
      if (req.url === '/drip') {
        res.writeHead(200)
        res.write('half')
        setTimeout(() => res.end('!'), 500)
        return
      }
      res.writeHead(req.url === '/missing' ? 404 : 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ method: req.method, echo: body }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('createSdHttpClient', () => {
  it('sends a GET and a JSON POST and returns the status with the whole body', async () => {
    const client = createSdHttpClient()
    expect(await client.get(`${base}/v1/models`, 2_000)).toEqual({
      status: 200,
      text: JSON.stringify({ method: 'GET', echo: '' }),
    })
    expect(await client.post(`${base}/sdcpp/v1/img_gen`, { prompt: 'кот' }, 2_000)).toEqual({
      status: 200,
      text: JSON.stringify({ method: 'POST', echo: '{"prompt":"кот"}' }),
    })
    expect((await client.get(`${base}/missing`, 2_000)).status).toBe(404)
    const post = seen.find((r) => r.url === '/sdcpp/v1/img_gen')
    expect(post?.type).toBe('application/json')
    expect(post?.body).toBe('{"prompt":"кот"}')
  })

  it('posts an empty body without a content type, as a cancel does', async () => {
    await createSdHttpClient().post(`${base}/sdcpp/v1/jobs/1/cancel`, undefined, 2_000)
    const cancel = seen.find((r) => r.url === '/sdcpp/v1/jobs/1/cancel')
    expect(cancel).toEqual({ method: 'POST', url: '/sdcpp/v1/jobs/1/cancel', type: undefined, body: '' })
  })

  it('gives up after the deadline, whether the head or the body is late', async () => {
    const client = createSdHttpClient()
    await expect(client.get(`${base}/slow`, 100)).rejects.toThrow(/did not answer within 100 ms/)
    await expect(client.get(`${base}/drip`, 100)).rejects.toThrow(/did not answer within 100 ms/)
    // Nothing stays pending: the next request on a fresh connection works at once.
    expect((await client.get(`${base}/v1/models`, 2_000)).status).toBe(200)
  })

  it('reports a refused connection as an error, not as a status', async () => {
    await expect(createSdHttpClient().get('http://127.0.0.1:1/v1/models', 2_000)).rejects.toThrow()
  })
})
