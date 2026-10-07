import { afterEach, describe, expect, it } from 'vitest'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'
import { AtomicCoreError, DEFAULT_EMBEDDING_SETTINGS } from '../../../contracts/index.js'
import type { EmbeddingSettings, EmbeddingStatus } from '../../../contracts/index.js'
import type { EmbeddingControl } from '../types.js'

let h: ControlHarness | undefined
afterEach(async () => {
  await h?.server.close()
  h = undefined
})

const STATUS: EmbeddingStatus = {
  state: 'ready',
  enabled: true,
  model_path: '/m/embeddinggemma-2-Q8_0.gguf',
  model_id: 'embeddinggemma-2',
  engine: null,
  pid: 42,
  port: 3999,
  dims: 768,
  modalities: ['text', 'image', 'audio'],
  restarts: 0,
  error: null,
  since: 1,
}

function fakeEmbedding(calls: string[], over: Partial<EmbeddingControl> = {}): EmbeddingControl {
  let settings: EmbeddingSettings = { ...DEFAULT_EMBEDDING_SETTINGS }
  return {
    status: () => ({ ...STATUS, enabled: settings.enabled }),
    config: () => settings,
    configure: async (patch) => {
      calls.push(`configure ${JSON.stringify(patch)}`)
      settings = { ...settings, ...(patch as Partial<EmbeddingSettings>) }
      return STATUS
    },
    load: async () => {
      calls.push('load')
      return STATUS
    },
    unload: async () => {
      calls.push('unload')
      return { ...STATUS, state: 'idle', pid: null, port: null }
    },
    embed: async (body) => {
      calls.push(`embed ${JSON.stringify(body)}`)
      return { status: 200, body: { object: 'list', data: [{ embedding: [0.1], index: 0 }] } }
    },
    ...over,
  }
}

const send = (method: string, path: string, body?: unknown) =>
  h!.get(`/atomic/v1/embedding/${path}`, {
    method,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })

describe('embedding routes', () => {
  it('answers status and configuration', async () => {
    h = await start({ embedding: fakeEmbedding([]) })
    expect(await (await send('GET', 'status')).json()).toMatchObject({ state: 'ready', dims: 768 })
    const config = (await (await send('GET', 'config')).json()) as {
      config: EmbeddingSettings
      status: EmbeddingStatus
    }
    expect(config.config).toEqual(DEFAULT_EMBEDDING_SETTINGS)
    expect(config.status.modalities).toEqual(['text', 'image', 'audio'])
  })

  it('writes a settings patch and answers the new configuration', async () => {
    const calls: string[] = []
    h = await start({ embedding: fakeEmbedding(calls) })
    const res = await send('PUT', 'config', { enabled: true, model_path: '/m/bge.gguf' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      config: { enabled: true, model_path: '/m/bge.gguf' },
      status: { enabled: true },
    })
    expect(calls).toEqual(['configure {"enabled":true,"model_path":"/m/bge.gguf"}'])
    expect((await send('PUT', 'config', [1])).status).toBe(400)
  })

  it('loads and unloads, and a failed load keeps its code', async () => {
    const calls: string[] = []
    h = await start({ embedding: fakeEmbedding(calls) })
    expect(await (await send('POST', 'load')).json()).toMatchObject({ state: 'ready' })
    expect(await (await send('POST', 'unload')).json()).toMatchObject({ state: 'idle' })
    expect(calls).toEqual(['load', 'unload'])
    await h.server.close()
    h = await start({
      embedding: fakeEmbedding([], {
        load: async () => {
          throw new AtomicCoreError(
            'EMBEDDING_ENGINE_UNSUPPORTED',
            'Update llama.cpp to b11454 or newer.',
            'b11443/macos-arm64'
          )
        },
      }),
    })
    const failed = await send('POST', 'load')
    expect(failed.status).toBe(409)
    expect(await failed.json()).toEqual({
      error: {
        code: 'EMBEDDING_ENGINE_UNSUPPORTED',
        message: 'Update llama.cpp to b11454 or newer.',
        details: 'b11443/macos-arm64',
      },
    })
  })

  it('embeds a body and answers what the engine said', async () => {
    const calls: string[] = []
    h = await start({ embedding: fakeEmbedding(calls) })
    const res = await send('POST', 'embed', { input: ['hi'] })
    expect(await res.json()).toEqual({
      status: 200,
      body: { object: 'list', data: [{ embedding: [0.1], index: 0 }] },
    })
    expect(calls).toEqual(['embed {"input":["hi"]}'])
    expect((await send('POST', 'embed', { model: 'x' })).status).toBe(400)
    expect((await send('POST', 'embed', '"text"')).status).toBe(400)
  })

  it('answers 503 without the module', async () => {
    h = await start({})
    const res = await send('GET', 'status')
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: 'EMBEDDING_UNAVAILABLE' } })
  })
})
