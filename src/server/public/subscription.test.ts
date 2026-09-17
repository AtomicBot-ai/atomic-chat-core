import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  closeAll,
  localSession,
  postJson,
  remoteProvider,
  startPublic,
  startUpstream,
} from '../../../test/helpers/public-server.js'
import { json, responsesStream, startStub } from '../../../test/helpers/chatgpt-stub.js'
import type { Stub } from '../../../test/helpers/chatgpt-stub.js'

let chatgpt: Stub

beforeEach(async () => {
  chatgpt = await startStub((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(responsesStream('from subscription'))
  })
})
afterEach(async () => {
  await closeAll()
  await chatgpt.close()
})

const backend = () => ({ baseUrl: chatgpt.url, accessToken: async () => ({ token: 't', accountId: null }) })

describe('the ChatGPT subscription branch', () => {
  it('answers models registered under chatgpt from the subscription, with CORS, streamed or whole', async () => {
    const server = await startPublic({
      remote: [remoteProvider({ provider: 'chatgpt', baseUrl: null, apiKey: null, models: ['gpt-5'] })],
      chatgpt: backend(),
    })

    const whole = await postJson(
      server,
      '/chat/completions',
      { model: 'gpt-5', messages: [] },
      {
        headers: { 'content-type': 'application/json', 'origin': 'http://localhost:1' },
      }
    )
    expect(whole.headers.get('access-control-allow-origin')).toBe('http://localhost:1')
    expect(await whole.json()).toMatchObject({ choices: [{ message: { content: 'from subscription' } }] })

    const streamed = await postJson(server, '/chat/completions', {
      model: 'chatgpt/gpt-5',
      stream: true,
      messages: [],
    })
    expect(streamed.headers.get('content-type')).toBe('text/event-stream')
    expect(streamed.headers.get('cache-control')).toBe('no-cache')
    expect(await streamed.text()).toMatch(/data: \[DONE\]\n\n$/)
    expect(chatgpt.requests).toHaveLength(2)
  })

  it('leaves every other request, including a malformed one, to the generic path', async () => {
    const { port } = await startUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"local":true}')
    })
    const server = await startPublic({ sessions: [localSession(port)], chatgpt: backend() })

    expect(
      await (await postJson(server, '/chat/completions', { model: 'demo', messages: [] })).json()
    ).toEqual({
      local: true,
    })
    const invalid = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: 'POST',
      body: '{nope',
    })
    expect(invalid.status).toBe(400)
    expect((await postJson(server, '/chat/completions', { messages: [] })).status).toBe(400)
    expect(chatgpt.requests).toHaveLength(0)
  })

  it('passes a subscription error through with its status', async () => {
    chatgpt.handle((_req, res) => json(res, 429, { error: 'limit' }))
    const server = await startPublic({
      remote: [remoteProvider({ provider: 'chatgpt', models: ['gpt-5'] })],
      chatgpt: backend(),
    })

    const res = await postJson(server, '/chat/completions', { model: 'gpt-5', messages: [] })

    expect([res.status, await res.text()]).toEqual([429, '{"error":"limit"}'])
  })
})
