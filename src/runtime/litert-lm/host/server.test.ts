import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeLiteRtLibrary, GEMMA_INFO, text } from '../../../../test/helpers/fake-litert-library.js'
import type { FakeEngine } from '../../../../test/helpers/fake-litert-library.js'
import { createLiteRtServer } from './server.js'

let close: (() => Promise<void>) | null = null
afterEach(async () => {
  await close?.()
  close = null
})

async function start(over: { vision?: boolean; reasoning?: boolean; library?: FakeLiteRtLibrary } = {}) {
  const library = over.library ?? new FakeLiteRtLibrary()
  const engine = library.createEngine({
    model: '/m.litertlm',
    backend: 'cpu',
    visionBackend: null,
    maxNumTokens: 4096,
    cacheDir: '/c',
    speculative: false,
  }) as FakeEngine
  const server = createLiteRtServer({
    engine,
    modelId: 'gemma-e2b',
    caps: { vision: over.vision ?? false, reasoning: over.reasoning ?? false },
    now: () => 1_700_000_000_000,
  })
  const url = await server.listen(0)
  close = () => server.close()
  return { url, library, engine }
}

const post = (url: string, body: unknown) =>
  fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** The `data:` payloads of an SSE body, `[DONE]` kept as a string. */
async function frames(response: Response): Promise<unknown[]> {
  return (await response.text())
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      const data = frame.replace(/^data: /, '')
      return data === '[DONE]' ? data : (JSON.parse(data) as unknown)
    })
}

const ask = (content: string, extra: Record<string, unknown> = {}) => ({
  model: 'gemma-e2b',
  messages: [{ role: 'user', content }],
  ...extra,
})

describe('litert-host server', () => {
  it('lists its one model under the id core gave it', async () => {
    const { url } = await start()
    const body = (await (await fetch(`${url}/v1/models`)).json()) as { data: Array<{ id: string }> }
    expect(body).toMatchObject({
      object: 'list',
      data: [{ id: 'gemma-e2b', object: 'model', owned_by: 'litert-lm' }],
    })
  })

  it('streams content and reasoning deltas, a finish chunk, usage and [DONE]', async () => {
    const { url, library } = await start()
    library.script = () => [{ role: 'assistant', channels: { thought: 'Think' } }, text('Hi'), text('!')]
    const response = await post(url, ask('Hello', { stream: true, stream_options: { include_usage: true } }))
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/)
    const got = await frames(response)
    const deltas = got
      .slice(0, -1)
      .map((frame) => (frame as { choices: Array<{ delta: unknown }> }).choices[0]?.delta)
    expect(deltas.slice(0, 4)).toEqual([
      { role: 'assistant', content: '' },
      { reasoning_content: 'Think' },
      { content: 'Hi' },
      { content: '!' },
    ])
    expect(got.at(-3)).toMatchObject({
      object: 'chat.completion.chunk',
      model: 'gemma-e2b',
      choices: [{ finish_reason: 'stop' }],
    })
    expect(got.at(-2)).toMatchObject({ choices: [], usage: { completion_tokens: 3 } })
    expect(got.at(-1)).toBe('[DONE]')
  })

  it('streams a tool call as a tool_calls delta and finishes with tool_calls', async () => {
    const { url, library } = await start()
    library.script = () => [
      {
        role: 'assistant',
        tool_calls: [{ type: 'function', function: { name: 'get_weather', arguments: { city: 'Paris' } } }],
      },
    ]
    const got = await frames(
      await post(
        url,
        ask('Weather?', { stream: true, tools: [{ type: 'function', function: { name: 'get_weather' } }] })
      )
    )
    const toolDelta = got.find(
      (frame) =>
        typeof frame === 'object' &&
        (frame as { choices: Array<{ delta?: { tool_calls?: unknown } }> }).choices[0]?.delta?.tool_calls
    ) as { choices: Array<{ delta: { tool_calls: Array<{ function: unknown }> } }> }
    expect(toolDelta.choices[0]?.delta.tool_calls[0]?.function).toEqual({
      name: 'get_weather',
      arguments: '{"city":"Paris"}',
    })
    expect(got.at(-2)).toMatchObject({ choices: [{ finish_reason: 'tool_calls' }] })
    expect(got.at(-1)).toBe('[DONE]')
  })

  it('answers without a stream: the whole message, finish reason and usage', async () => {
    const { url, library } = await start()
    library.script = () => [text('{"a":'), text('1}')]
    const response = await post(
      url,
      ask('JSON', {
        response_format: { type: 'json_schema', json_schema: { schema: { type: 'object' } } },
        max_tokens: 50,
      })
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      object: 'chat.completion',
      model: 'gemma-e2b',
      choices: [{ index: 0, message: { role: 'assistant', content: '{"a":1}' }, finish_reason: 'stop' }],
      usage: { completion_tokens: 2 },
    })
    const sent = library.engines[0]?.conversations[0]?.sent[0]
    expect(sent?.options).toEqual({
      maxOutputTokens: 50,
      constraint: { kind: 'json_schema', value: '{"type":"object"}' },
      thinking: false,
    })
    expect(library.engines[0]?.conversations[0]?.config.constrained).toBe(true)
  })

  it('refuses an image for a model without vision and n: 2 with OpenAI 400s, before the library', async () => {
    const { url, library } = await start({ vision: false })
    const image = await post(url, {
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] },
      ],
    })
    expect(image.status).toBe(400)
    expect(await image.json()).toMatchObject({
      error: { type: 'invalid_request_error', message: expect.stringMatching(/image/) },
    })
    const two = await post(url, ask('x', { n: 2 }))
    expect(two.status).toBe(400)
    const bad = await fetch(`${url}/v1/chat/completions`, { method: 'POST', body: '{' })
    expect(bad.status).toBe(400)
    const embeddings = await fetch(`${url}/v1/embeddings`, { method: 'POST', body: '{}' })
    expect(embeddings.status).toBe(404)
    expect(library.conversationsCreated).toBe(0)
  })

  it('cuts at a stop string and stops the library; the next request starts a fresh conversation', async () => {
    const { url, library } = await start()
    library.script = () => [text('one two'), text(' STOP three'), text(' four')]
    const body = (await (await post(url, ask('count', { stop: 'STOP' }))).json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>
    }
    expect(body.choices[0]).toMatchObject({ message: { content: 'one two ' }, finish_reason: 'stop' })
    const first = library.engines[0]?.conversations[0]
    expect(first?.closed).toBe(true)
    library.script = () => [text('ok')]
    await post(url, ask('again'))
    expect(library.conversationsCreated).toBe(2)
  })

  it('cancels the generation when the client hangs up, and serves the next request at once', async () => {
    const { url, library } = await start()
    library.chunkDelayMs = 20
    library.script = () => Array.from({ length: 200 }, (_, i) => text(`t${i} `))
    const port = Number(new URL(url).port)
    await new Promise<void>((resolve) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          let seen = 0
          res.on('data', () => {
            if (++seen === 3) {
              req.destroy()
              resolve()
            }
          })
        }
      )
      req.end(JSON.stringify(ask('long', { stream: true })))
    })
    library.chunkDelayMs = 1
    library.script = () => [text('next')]
    const started = Date.now()
    const body = (await (await post(url, ask('next'))).json()) as {
      choices: Array<{ message: { content: string } }>
    }
    expect(body.choices[0]?.message.content).toBe('next')
    expect(Date.now() - started).toBeLessThan(2_000)
    const first = library.engines[0]?.conversations[0]
    expect(first?.poisoned).toBe(true)
    expect(first?.closed).toBe(true)
  })

  it('runs three simultaneous requests one after another, all complete, none refused', async () => {
    const { url, library } = await start()
    library.chunkDelayMs = 5
    library.script = (message) => {
      const said = JSON.stringify(message)
      return [text(said.includes('A') ? 'a' : said.includes('B') ? 'b' : 'c'), text('.')]
    }
    const answers = await Promise.all(
      ['A', 'B', 'C'].map((name) => post(url, ask(name)).then((r) => r.json()))
    )
    expect(
      answers.map(
        (a) => (a as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content
      )
    ).toEqual(['a.', 'b.', 'c.'])
    expect(library.maxActive).toBe(1)
  })

  it('continues a conversation with only the new message when the request repeats its history', async () => {
    const { url, library } = await start()
    library.script = () => [text('Hello!')]
    await post(url, ask('Hi'))
    library.script = () => [text('Fine.')]
    await post(url, {
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'How are you?' },
      ],
    })
    expect(library.conversationsCreated).toBe(1)
    expect(library.engines[0]?.conversations[0]?.sent.map((s) => s.message)).toEqual([
      [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      [{ role: 'user', content: [{ type: 'text', text: 'How are you?' }] }],
    ])
  })

  it('turns a library error into a 500 and drops the conversation', async () => {
    const { url, library } = await start()
    library.script = () => [text('par'), { error: 'INTERNAL: GPU device lost' }]
    const response = await post(url, ask('x'))
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringMatching(/GPU device lost/) },
    })
    expect(library.engines[0]?.conversations[0]?.closed).toBe(true)
  })

  it('turns thinking on by the model default and off when the request says so', async () => {
    const { url, library } = await start({ reasoning: true })
    await post(url, ask('x'))
    await post(url, ask('y', { reasoning_effort: 'none' }))
    const sent = library.engines[0]?.conversations.flatMap((c) => c.sent.map((s) => s.options.thinking))
    expect(sent).toEqual([true, false])
    expect(GEMMA_INFO.thinking).toBe(false)
  })
})

describe('litert-host server shutdown', () => {
  it('closes a conversation only after the library ended its cancelled generation', async () => {
    const { url, library, engine } = await start()
    library.chunkDelayMs = 20
    library.script = () => Array.from({ length: 200 }, (_, i) => text(`t${i} `))
    const pending = fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ask('long', { stream: true })),
    }).catch(() => null)
    for (let i = 0; i < 100 && library.active === 0; i++) await new Promise((r) => setTimeout(r, 5))
    expect(library.active).toBe(1)
    await close?.()
    close = null
    const conversation = engine.conversations[0]
    expect(conversation?.closed).toBe(true)
    expect(conversation?.closedWhileRunning).toBe(false)
    expect(library.active).toBe(0)
    await pending
  })
})
