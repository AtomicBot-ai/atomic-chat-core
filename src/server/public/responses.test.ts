import { afterEach, describe, expect, it } from 'vitest'
import {
  closeAll,
  closedPort,
  localSession,
  postJson,
  remoteProvider,
  startPublic,
  startUpstream,
} from '../../../test/helpers/public-server.js'

afterEach(closeAll)

describe('/responses', () => {
  it('passes MLX through to its own /v1/responses', async () => {
    const paths: string[] = []
    const { port } = await startUpstream((req, _body, res) => {
      paths.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"id":"resp_mlx"}')
    })
    const server = await startPublic({ sessions: [localSession(port, { provider: 'mlx', apiKey: '' })] })

    const res = await postJson(server, '/responses', { model: 'demo', input: 'hi' })

    expect(await res.json()).toEqual({ id: 'resp_mlx' })
    expect(paths).toEqual(['/v1/responses'])
  })

  it('answers 500 for a provider with no base URL, and 502 when the engine cannot be reached', async () => {
    const port = await closedPort()
    const server = await startPublic({
      remote: [remoteProvider({ baseUrl: null })],
      sessions: [localSession(port)],
    })

    const remote = await postJson(server, '/responses', { model: 'cloud-model' })
    const local = await postJson(server, '/responses', { model: 'demo', input: 'hi' })

    expect([remote.status, await remote.text()]).toEqual([500, 'Provider has no base_url'])
    expect(local.status).toBe(502)
    expect(await local.text()).toMatch(/^Proxy request to model failed: /)
  })

  it("answers a model nothing serves with OpenAI's model_not_found envelope", async () => {
    const server = await startPublic({ sessions: [localSession(await closedPort())] })

    const res = await postJson(server, '/responses', { model: 'ghost', input: 'hi' })

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toEqual({
      error: {
        message: "No running session found for model 'ghost'",
        type: 'invalid_request_error',
        param: 'model',
        code: 'model_not_found',
      },
    })
  })

  it('refuses a message role the Responses API does not define before llama.cpp or MLX sees it', async () => {
    const seen: string[] = []
    const { port } = await startUpstream((req, _body, res) => {
      seen.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"choices":[{"message":{"role":"assistant","content":"ok"}}]}')
    })
    const server = await startPublic({
      sessions: [
        localSession(port),
        localSession(port, { provider: 'mlx', modelId: 'mlx-model', apiKey: '' }),
      ],
    })

    for (const model of ['demo', 'mlx-model']) {
      const res = await postJson(server, '/responses', {
        model,
        input: [
          { role: 'user', content: 'hi' },
          { type: 'message', role: 'not-a-real-role', content: 'x' },
        ],
      })
      expect(res.status, model).toBe(400)
      expect(res.headers.get('content-type'), model).toBe('application/json')
      expect(await res.json(), model).toEqual({
        error: {
          message:
            "Invalid value for 'input[1].role': 'not-a-real-role'. Supported values are: 'user', 'assistant', 'system' and 'developer'.",
          type: 'invalid_request_error',
          param: 'input[1].role',
          code: 'invalid_value',
        },
      })
    }
    expect(seen).toEqual([])

    for (const model of ['demo', 'mlx-model']) {
      const ok = await postJson(server, '/responses', {
        model,
        input: [
          { role: 'developer', content: 'Be brief.' },
          { role: 'user', content: 'hi' },
          { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
          { type: 'function_call_output', call_id: 'c1', output: '42' },
        ],
      })
      expect(ok.status, model).toBe(200)
    }
    expect(seen).toEqual(['/v1/chat/completions', '/v1/responses'])
  })

  it("offers Codex's MCP namespace tools to llama.cpp as functions and names their calls back", async () => {
    // How Codex sends an MCP server's tools, and calls one of them earlier in the conversation.
    const namespace = {
      type: 'namespace',
      name: 'mcp__docs',
      description: 'Tools for working with Docs.',
      tools: [
        { type: 'function', name: 'search', description: '', strict: false, parameters: { type: 'object' } },
        { type: 'custom', name: 'freeform', description: 'x', format: { type: 'grammar' } },
      ],
    }
    const sent: Array<Record<string, unknown>> = []
    let streamed = false
    const { port } = await startUpstream((_req, body, res) => {
      sent.push(JSON.parse(body))
      const call = {
        id: 'call_2',
        type: 'function',
        function: { name: 'mcp__docs__search', arguments: '{}' },
      }
      if (!streamed) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [call] } }] })
        )
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...call }] } }] })}\n\ndata: [DONE]\n\n`
      )
    })
    const server = await startPublic({ sessions: [localSession(port)] })
    const request = {
      model: 'demo',
      tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }, namespace],
      input: [
        { type: 'message', role: 'user', content: 'find it' },
        { type: 'function_call', call_id: 'call_1', name: 'search', namespace: 'mcp__docs', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'nothing' },
      ],
    }

    const whole = (await postJson(server, '/responses', request).then((r) => r.json())) as { output: unknown }
    expect(sent[0]?.['tools']).toEqual([
      { type: 'function', function: { name: 'shell', parameters: { type: 'object' } } },
      {
        type: 'function',
        function: {
          name: 'mcp__docs__search',
          description: 'Tools for working with Docs.',
          parameters: { type: 'object' },
        },
      },
    ])
    expect((sent[0]?.['messages'] as Array<Record<string, unknown>>)[1]).toMatchObject({
      tool_calls: [{ id: 'call_1', function: { name: 'mcp__docs__search' } }],
    })
    expect(whole.output).toEqual([
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_2',
        name: 'search',
        namespace: 'mcp__docs',
      }),
    ])

    streamed = true
    const events = await postJson(server, '/responses', { ...request, stream: true }).then((r) => r.text())
    const done = events
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)) as { type: string; item?: unknown })
      .filter((event) => event.type === 'response.output_item.done')
    expect(done.map((event) => event.item)).toEqual([
      expect.objectContaining({ call_id: 'call_2', name: 'search', namespace: 'mcp__docs' }),
    ])
  })

  it('passes an engine error through with its status', async () => {
    const { port } = await startUpstream((_req, _body, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' })
      res.end('loading model')
    })
    const server = await startPublic({ sessions: [localSession(port)] })

    const res = await postJson(server, '/responses', { model: 'demo', input: 'hi' })

    expect([res.status, await res.text()]).toEqual([503, 'loading model'])
  })
})
