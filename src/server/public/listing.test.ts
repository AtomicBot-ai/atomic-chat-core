import { afterEach, describe, expect, it } from 'vitest'
import { museCatalogEntry } from './listing.js'
import {
  closeAll,
  closedPort,
  localSession,
  remoteProvider,
  startPublic,
  startUpstream,
} from '../../../test/helpers/public-server.js'

afterEach(closeAll)

describe('museCatalogEntry', () => {
  it('advertises a larger context for remote models than for local ones', () => {
    const limit = (owner: string) =>
      (museCatalogEntry('m', owner) as { metadata: { 'muse-code': { limit: { context: number } } } })
        .metadata['muse-code'].limit.context
    expect(limit('remote')).toBe(200_000)
    expect(limit('llama.cpp')).toBe(32_768)
  })
})

describe('/metrics', () => {
  it('takes the model from X-Model when the query has none, but not when the query names an empty one', async () => {
    const { port } = await startUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok 1\n')
    })
    const server = await startPublic({ sessions: [localSession(port)] })
    const base = `http://127.0.0.1:${server.port}/v1/metrics`

    expect((await fetch(base, { headers: { 'x-model': 'demo' } })).status).toBe(200)
    expect((await fetch(`${base}?model=`, { headers: { 'x-model': 'demo' } })).status).toBe(400)
  })

  it('answers 502 when llama-server cannot be reached', async () => {
    const port = await closedPort()
    const server = await startPublic({ sessions: [localSession(port)] })

    const res = await fetch(`http://127.0.0.1:${server.port}/v1/metrics?model=demo`)

    expect(res.status).toBe(502)
    expect(await res.text()).toMatch(/^Failed to fetch metrics from llama-server: /)
  })
})

describe('/muse-code/models', () => {
  it("advertises a declared session's own tool support and context, and llama.cpp defaults otherwise", async () => {
    const server = await startPublic({
      sessions: [
        localSession(1, { modelId: 'gguf' }),
        localSession(2, {
          provider: 'tensorrt-llm',
          modelId: 'trt',
          policy: {
            routes: [],
            tools: false,
            structuredOutput: false,
            mapError: () => null,
            contextLength: 16384,
            maxOutputTokens: 2048,
          },
        }),
      ],
    })
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/muse-code/models`)
    const body = (await res.json()) as {
      data: Array<{
        id: string
        metadata: { 'muse-code': { tool_call: boolean; limit: { context: number; output: number } } }
      }>
    }
    const muse = (id: string) => body.data.find((m) => m.id === id)?.metadata['muse-code']
    expect(muse('trt')).toMatchObject({ tool_call: false, limit: { context: 16384, output: 2048 } })
    expect(muse('gguf')).toMatchObject({ tool_call: true, limit: { context: 32_768, output: 32_768 } })
  })
})

describe('/models', () => {
  it("advertises each local session's real window, and none where it is not known", async () => {
    const asked: string[] = []
    const server = await startPublic({
      sessions: [
        localSession(1, { modelId: 'gguf' }),
        localSession(2, { provider: 'mlx', modelId: 'mlx-model' }),
        localSession(3, {
          provider: 'vllm',
          modelId: 'vllm-model',
          policy: {
            routes: [],
            tools: true,
            structuredOutput: true,
            mapError: () => null,
            contextLength: 8192,
          },
        }),
      ],
      remote: [remoteProvider()],
      contextWindow: (target) => {
        asked.push(target.modelId)
        return Promise.resolve(target.provider === 'llamacpp-upstream' ? 65536 : undefined)
      },
    })

    const models = await fetch(`http://127.0.0.1:${server.port}/v1/models`).then((r) => r.json())
    expect(models).toEqual({
      object: 'list',
      data: [
        {
          id: 'gguf',
          object: 'model',
          created: 1,
          owned_by: 'llama.cpp-upstream',
          context_length: 65536,
          meta: { n_ctx: 65536 },
        },
        { id: 'mlx-model', object: 'model', created: 1, owned_by: 'mlx' },
        {
          id: 'vllm-model',
          object: 'model',
          created: 1,
          owned_by: 'vllm',
          context_length: 8192,
          meta: { n_ctx: 8192 },
        },
        { id: 'cloud-model', object: 'model', created: 1, owned_by: 'remote' },
      ],
    })
    // A declared session states its window; nobody asks the engine for it.
    expect(asked).toEqual(['gguf', 'mlx-model'])

    // Muse Code compacts at the window it is told: the real one, where known.
    const muse = await fetch(`http://127.0.0.1:${server.port}/v1/muse-code/models`).then((r) => r.json())
    const limits = (
      muse as { data: Array<{ id: string; metadata: { 'muse-code': { limit: object } } }> }
    ).data.map((m) => [m.id, m.metadata['muse-code'].limit])
    expect(limits).toEqual([
      ['gguf', { context: 65536, output: 32_768 }],
      ['mlx-model', { context: 32_768, output: 32_768 }],
      ['vllm-model', { context: 8192, output: 32_768 }],
      ['cloud-model', { context: 200_000, output: 32_768 }],
    ])
  })

  it('lists a loaded TensorRT-LLM model under its own owner label', async () => {
    const server = await startPublic({
      sessions: [
        localSession(1, { provider: 'tensorrt-llm', modelId: 'trt-model' }),
        localSession(2, { provider: 'vllm', modelId: 'vllm-model' }),
        localSession(3, { provider: 'sglang', modelId: 'sglang-model' }),
        localSession(4, { provider: 'foundry-local', modelId: 'qwen2.5-1.5b-instruct-openvino-npu' }),
        localSession(5, { provider: 'litert-lm', modelId: 'gemma-4-e2b-gpu' }),
      ],
    })
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/models`)
    expect(await res.json()).toEqual({
      object: 'list',
      data: [
        { id: 'trt-model', object: 'model', created: 1, owned_by: 'tensorrt-llm' },
        { id: 'vllm-model', object: 'model', created: 1, owned_by: 'vllm' },
        { id: 'sglang-model', object: 'model', created: 1, owned_by: 'sglang' },
        { id: 'qwen2.5-1.5b-instruct-openvino-npu', object: 'model', created: 1, owned_by: 'foundry-local' },
        { id: 'gemma-4-e2b-gpu', object: 'model', created: 1, owned_by: 'litert-lm' },
      ],
    })
  })
})
