import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeGeniexLibrary } from '../../../../test/helpers/fake-geniex-library.js'
import { FakeGeniexWorker } from '../../../../test/helpers/fake-geniex-worker.js'
import { WorkerEngine } from './engine.js'
import { createGeniexServer } from './server.js'

let close: (() => Promise<void>) | null = null
let tmp: string
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'atomic-geniex-server-'))
})
afterEach(async () => {
  await close?.()
  close = null
  await rm(tmp, { recursive: true, force: true })
})

async function start(
  over: { vision?: boolean; reasoning?: boolean; grammar?: boolean; library?: FakeGeniexLibrary } = {}
) {
  const library = over.library ?? new FakeGeniexLibrary()
  const engine = new WorkerEngine(new FakeGeniexWorker(library))
  await engine.create('/b/lib', {
    plugin: 'llama_cpp',
    device: 'cpu',
    model: '/m/qwen3.gguf',
    mmproj: over.vision ? '/m/mmproj.gguf' : null,
    nCtx: 4096,
    threads: 0,
    powerMode: 'burst',
  })
  const server = createGeniexServer({
    engine,
    modelId: 'qwen3-4b',
    caps: { vision: over.vision ?? false, reasoning: over.reasoning ?? false },
    defaultMaxTokens: 256,
    ...(over.grammar === undefined ? {} : { grammar: over.grammar }),
    tmpDir: join(tmp, 'images'),
    now: () => 1_700_000_000_000,
  })
  const url = await server.listen(0)
  close = async () => {
    await server.close()
    await engine.destroy()
  }
  const model = () => library.models[0]!
  return { url, library, model }
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
const deltasOf = (got: unknown[]) =>
  got.slice(0, -1).map((frame) => (frame as { choices: Array<{ delta: unknown }> }).choices[0]?.delta)

const ask = (content: string, extra: Record<string, unknown> = {}) => ({
  model: 'qwen3-4b',
  messages: [{ role: 'user', content }],
  ...extra,
})

describe('geniex-host server (tasks 5.4–5.5)', () => {
  it('lists its one model under the id core gave it', async () => {
    const { url } = await start()
    expect(await (await fetch(`${url}/v1/models`)).json()).toMatchObject({
      object: 'list',
      data: [{ id: 'qwen3-4b', object: 'model', owned_by: 'geniex' }],
    })
  })

  it('applies the chat template in the Worker and streams content and reasoning deltas, a finish chunk, usage and [DONE]', async () => {
    const { url, library, model } = await start({ reasoning: true })
    library.script = () => ['<think>', 'Hmm', '</think>', 'Hi', '!']
    const response = await post(url, ask('Hello', { stream: true, stream_options: { include_usage: true } }))
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/)
    const got = await frames(response)
    expect(deltasOf(got).slice(0, 4)).toEqual([
      { role: 'assistant', content: '' },
      { reasoning_content: 'Hmm' },
      { content: 'Hi' },
      { content: '!' },
    ])
    expect(got.at(-3)).toMatchObject({
      object: 'chat.completion.chunk',
      model: 'qwen3-4b',
      choices: [{ finish_reason: 'stop' }],
    })
    expect(got.at(-2)).toMatchObject({ choices: [], usage: { completion_tokens: 5 } })
    expect(got.at(-1)).toBe('[DONE]')
    expect(model().templates[0]).toEqual({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      tools: null,
      enableThinking: true,
    })
    expect(model().generations[0]?.prompt).toMatch(/^TEMPLATE /)
    expect(model().generations[0]?.config).toMatchObject({ maxTokens: 256, stop: [], imagePaths: [] })
  })

  it('streams a Qwen3 tool call as a tool_calls delta and finishes with tool_calls; the template saw the tools', async () => {
    const { url, library, model } = await start()
    library.script = () => [
      '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n</tool_call>',
    ]
    const tools = [{ type: 'function', function: { name: 'get_weather' } }]
    const got = await frames(await post(url, ask('Weather?', { stream: true, tools })))
    const toolDelta = deltasOf(got).find(
      (delta) => delta && typeof delta === 'object' && 'tool_calls' in delta
    ) as {
      tool_calls: Array<{ function: unknown }>
    }
    expect(toolDelta.tool_calls[0]?.function).toEqual({ name: 'get_weather', arguments: '{"city":"Paris"}' })
    expect(got.at(-2)).toMatchObject({ choices: [{ finish_reason: 'tool_calls' }] })
    expect(model().templates[0]?.tools).toBe(JSON.stringify(tools))
  })

  it('answers without a stream, with the JSON schema turned into a grammar for the sampler', async () => {
    const { url, library, model } = await start()
    library.script = () => ['{"a":', '1}']
    const response = await post(
      url,
      ask('JSON', {
        response_format: {
          type: 'json_schema',
          json_schema: {
            schema: { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'] },
          },
        },
        max_tokens: 50,
        temperature: 0.1,
        seed: 3,
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      object: 'chat.completion',
      model: 'qwen3-4b',
      choices: [{ index: 0, message: { role: 'assistant', content: '{"a":1}' }, finish_reason: 'stop' }],
      usage: { completion_tokens: 2 },
    })
    const config = model().generations[0]?.config
    expect(config).toMatchObject({ maxTokens: 50, sampler: { temperature: 0.1, seed: 3 } })
    expect(config?.sampler.grammar).toMatch(/^root ::= "\{" space root-a-kv .*"\}" space$/m)
    expect(config?.sampler.grammar).toContain('root-a-kv ::= "\\"a\\"" space ":" space integer')
  })

  it('writes images to tmp for a vision model, hands their paths to the template and the generation, and deletes them after', async () => {
    const { url, library, model } = await start({ vision: true })
    library.script = () => ['A cat.']
    const body = await (
      await post(url, {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
              { type: 'text', text: 'What?' },
            ],
          },
        ],
      })
    ).json()
    expect(body).toMatchObject({ choices: [{ message: { content: 'A cat.' } }] })
    const path = model().generations[0]?.config.imagePaths[0] as string
    expect(path).toMatch(/images[\\/]chatcmpl-.*-0\.png$/)
    expect(model().templates[0]?.messages[0]?.content[0]).toEqual({ type: 'image', path })
    expect(await readdir(join(tmp, 'images'))).toEqual([])
  })

  it('refuses an image for a model without vision and n: 2 with OpenAI 400s before the Worker, and a route it does not serve with 404', async () => {
    const { url, model } = await start({ vision: false })
    const image = await post(url, {
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] },
      ],
    })
    expect(image.status).toBe(400)
    expect(await image.json()).toMatchObject({
      error: { type: 'invalid_request_error', message: expect.stringMatching(/image/) },
    })
    expect((await post(url, ask('x', { n: 2 }))).status).toBe(400)
    expect((await fetch(`${url}/v1/chat/completions`, { method: 'POST', body: '{' })).status).toBe(400)
    const embeddings = await fetch(`${url}/v1/embeddings`, { method: 'POST', body: '{}' })
    expect(embeddings.status).toBe(404)
    expect(await embeddings.json()).toMatchObject({
      error: { message: 'POST /v1/embeddings is not served by GenieX.' },
    })
    expect(model().templates).toEqual([])
  })

  it('cuts at a stop string and stops the library through the cancel flag', async () => {
    const { url, library, model } = await start()
    library.script = () => ['one two', ' STOP three', ' four']
    const body = (await (await post(url, ask('count', { stop: 'STOP' }))).json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>
    }
    expect(body.choices[0]).toMatchObject({ message: { content: 'one two ' }, finish_reason: 'stop' })
    expect(model().delivered).toEqual([2])
    expect(model().generations[0]?.config.stop).toEqual(['STOP'])
  })

  it('cancels the generation when the client hangs up, and serves the next request at once', async () => {
    const { url, library, model } = await start()
    library.tokenDelayMs = 5
    library.script = () => Array.from({ length: 2000 }, (_, i) => `t${i} `)
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
    library.tokenDelayMs = 0
    library.script = () => ['next']
    const started = Date.now()
    const body = (await (await post(url, ask('next'))).json()) as {
      choices: Array<{ message: { content: string } }>
    }
    expect(body.choices[0]?.message.content).toBe('next')
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(model().delivered[0]).toBeLessThan(2000)
  })

  it('runs three simultaneous requests one after another, all complete, none refused; /v1/models answers meanwhile', async () => {
    const { url, library } = await start()
    library.script = (prompt) => [prompt.includes('"A"') ? 'a' : prompt.includes('"B"') ? 'b' : 'c', '.']
    const answers = Promise.all(['A', 'B', 'C'].map((name) => post(url, ask(name)).then((r) => r.json())))
    const models = await fetch(`${url}/v1/models`)
    expect(models.status).toBe(200)
    expect(
      (await answers).map(
        (a) => (a as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content
      )
    ).toEqual(['a.', 'b.', 'c.'])
    expect(library.maxActive).toBe(1)
  })

  it('turns a library error into a 500 with the library message, and a prompt past the context into a 400', async () => {
    const { url, library } = await start()
    library.script = () => ({ error: 'Failed to decode', code: -200104 })
    const response = await post(url, ask('x'))
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringMatching(/Failed to decode/), type: 'server_error' },
    })
    library.script = () => ({ error: 'Input prompt too long', code: -200103 })
    const long = await post(url, ask('x'.repeat(100)))
    expect(long.status).toBe(400)
    expect(await long.json()).toMatchObject({
      error: {
        message: expect.stringMatching(/Input prompt too long/),
        code: 'context_length_exceeded',
        param: 'messages',
      },
    })
  })

  it('refuses response_format with a 400 when the plugin has no grammar sampler (qairt)', async () => {
    const { url, model } = await start({ grammar: false })
    const response = await post(url, ask('JSON', { response_format: { type: 'json_object' } }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { param: 'response_format', message: expect.stringMatching(/qairt/) },
    })
    expect(model().generations).toHaveLength(0)
  })

  it('turns thinking on by the model default and off when the request says so', async () => {
    const { url, model } = await start({ reasoning: true })
    await post(url, ask('x'))
    await post(url, ask('y', { reasoning_effort: 'none' }))
    expect(model().templates.map((t) => t.enableThinking)).toEqual([true, false])
  })
})
