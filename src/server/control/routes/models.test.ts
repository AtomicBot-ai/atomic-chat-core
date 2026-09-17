import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'

let h: ControlHarness

beforeEach(async () => {
  h = await start()
})
afterEach(() => h.server.close())

describe('models and public server', () => {
  it('loads and unloads a model whose id contains slashes', async () => {
    const res = await h.get('/atomic/v1/models/llamacpp-upstream/Owner/Repo-GGUF/load', {
      method: 'POST',
      body: JSON.stringify({ is_embedding: false }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as object).toMatchObject({ session: { model_id: 'demo' } })
    expect(h.calls[0]).toBe('load llamacpp-upstream Owner/Repo-GGUF {"is_embedding":false}')

    const unload = await h.get('/atomic/v1/models/llamacpp-upstream/Owner/Repo-GGUF/unload', {
      method: 'POST',
    })
    expect(await unload.json()).toEqual({ success: true })
    expect(h.calls[1]).toBe('unload llamacpp-upstream Owner/Repo-GGUF')
  })

  it('passes a load failure through with its code and status', async () => {
    const failing = await start({
      loadModel: async () => {
        throw Object.assign(new Error('nope'), { code: 'MODEL_NOT_FOUND' })
      },
    })
    const res = await failing.get('/atomic/v1/models/llamacpp-upstream/x/load', { method: 'POST' })
    expect(res.status).toBe(404)
    expect((await res.json()) as object).toMatchObject({ error: { code: 'MODEL_NOT_FOUND' } })
    await failing.server.close()
  })
})

describe('context increase route', () => {
  it('reloads a model one step up and returns the new session', async () => {
    const res = await h.get('/atomic/v1/models/llamacpp-upstream/vendor/model-7b/ctx/increase', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'proxy-overflow' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, new_ctx_len: 32768 })
    expect(h.calls).toContain('increaseCtx llamacpp-upstream vendor/model-7b proxy-overflow')
  })

  it('answers 200 with a reason when it declines, not an error', async () => {
    // The proxy branches on this: "the ladder is at its top" means stop retrying and return the
    // model's own overflow error, which is not the same as a reload that failed.
    h.ctxIncrease = { ok: false, reason: 'at_max', current_ctx_len: 8192, max_ctx_len: 8192 }

    const res = await h.get('/atomic/v1/models/llamacpp-upstream/m/ctx/increase', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: false,
      reason: 'at_max',
      current_ctx_len: 8192,
      max_ctx_len: 8192,
    })
  })
})

describe('model capability routes', () => {
  it('delegates embeddings with input and ubatch size intact', async () => {
    let seen: unknown
    h.models.embed = async (provider, modelId, input, ubatchSize) => {
      seen = { provider, modelId, input, ubatchSize }
      return {
        model: modelId,
        object: 'list',
        usage: { prompt_tokens: 1, total_tokens: 1 },
        data: [{ embedding: [1], index: 0 }],
      }
    }
    const res = await h.get('/atomic/v1/models/llamacpp-upstream/sentence-transformer-mini/embed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: ['hello'], ubatch_size: 64 }),
    })
    expect(res.status).toBe(200)
    expect(seen).toEqual({
      provider: 'llamacpp-upstream',
      modelId: 'sentence-transformer-mini',
      input: ['hello'],
      ubatchSize: 64,
    })
    expect(await res.json()).toMatchObject({ object: 'list', data: [{ index: 0 }] })
  })
  it('answers what a model is without loading it', async () => {
    const res = await h.get('/atomic/v1/models/llamacpp-upstream/vendor/model-7b/capabilities')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ modelId: 'vendor/model-7b', isEmbedding: false })
  })

  it('answers "not a model" with 200, because that is the answer to the question asked', async () => {
    // The user pointed at a file. Rendering "not a model" is the caller's job; a 4xx would make it
    // look like the request was malformed.
    const res = await h.get('/atomic/v1/gguf/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/x/notes.txt' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ isValid: false })
  })

  it('refuses a validate that names no file', async () => {
    const res = await h.get('/atomic/v1/gguf/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
  })

  it('lists devices, defaulting to the provider the core owns first', async () => {
    const asked: string[] = []
    h.models.devices = async (provider: string) => {
      asked.push(provider)
      return []
    }

    await h.get('/atomic/v1/hardware/devices')
    await h.get('/atomic/v1/hardware/devices?provider=llamacpp')

    expect(asked).toEqual(['llamacpp-upstream', 'llamacpp'])
  })
})

describe('foundation models availability', () => {
  it('answers the runtime token, forwarding force', async () => {
    const asked: boolean[] = []
    h.server.close()
    h = await start({
      foundationModelsAvailability: async (force) => {
        asked.push(force)
        return 'appleIntelligenceNotEnabled'
      },
    })
    expect(await (await h.get('/atomic/v1/runtimes/foundation-models/availability')).json()).toEqual({
      status: 'appleIntelligenceNotEnabled',
    })
    await h.get('/atomic/v1/runtimes/foundation-models/availability?force=1')
    expect(asked).toEqual([false, true])
  })

  it('says unavailable where the runtime does not exist', async () => {
    expect(await (await h.get('/atomic/v1/runtimes/foundation-models/availability')).json()).toEqual({
      status: 'unavailable',
    })
  })
})
