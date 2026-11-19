import { createServer } from 'node:http'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { strataHttp } from '../../src/runtime/strata/strata-http.js'

it('proves HTTP instance and model, isolates credentials, and forwards another request after cancellation', async () => {
  let chats = 0
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const upstream = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer private-upstream') {
      res.writeHead(401).end()
      return
    }
    if (req.url === '/v1/telemetry') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          instance: { id: 'instance' },
          model: { id: 'model', loaded: true },
        })
      )
      return
    }
    req.resume()
    req.once('end', () => {
      chats++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (chats === 1) {
        res.once('close', resolveClosed)
        res.write('data: {"choices":[]}\n\n')
      } else {
        res.end('data: {"choices":[]}\n\ndata: [DONE]\n\n')
      }
    })
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('Missing test upstream')
  const http = strataHttp(
    address.port,
    'private-upstream',
    'model',
    { chat: true, vision: true, tools: true, reasoning: true, structured_output: false },
    4096,
    []
  )
  try {
    const signal = new AbortController().signal
    await expect(http.httpHealthFailure({ instanceId: 'wrong' }, signal)).resolves.toBe(
      'Strata telemetry instance ID did not match.'
    )
    await expect(http.httpHealthFailure({ instanceId: 'instance' }, signal)).resolves.toBeUndefined()
    const endpoint = await http.expose()
    try {
      const url = 'http://127.0.0.1:' + endpoint.port
      const headers = { 'authorization': 'Bearer ' + endpoint.apiKey, 'content-type': 'application/json' }
      expect(endpoint.apiKey).not.toBe('private-upstream')
      expect((await fetch(url + '/v1/telemetry', { headers })).status).toBe(404)
      const send = (body: object, signal?: AbortSignal) =>
        fetch(url + '/v1/chat/completions', {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: 'model', messages: [], ...body }),
          ...(signal ? { signal } : {}),
        })
      expect((await send({ response_format: { type: 'json_object' } })).status).toBe(400)
      expect(chats).toBe(0)
      const abort = new AbortController()
      const first = await send({ stream: true }, abort.signal)
      expect(first.status).toBe(200)
      await first.body!.getReader().read()
      abort.abort()
      await closed
      const second = await send({ stream: true })
      expect(await second.text()).toContain('[DONE]')
      expect(chats).toBe(2)
    } finally {
      await endpoint.close()
    }
  } finally {
    upstream.closeAllConnections()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})
