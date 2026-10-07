/**
 * The embedding module end to end on the public server: the real module (settings → upstream pack →
 * process) spawns the fake engine in embedding mode, and `/v1/embeddings` naming the module's model
 * reaches it byte for byte — the fake answers with the SHA-256 of the body it received, which must be
 * the SHA-256 of the body the client sent. A request for another model never reaches it, and a request
 * the core refuses (a media link, a modality the model does not read) never leaves the core.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EmbeddingService } from '../../src/embedding/index.js'
import { wireEmbedding } from '../../src/embedding/index.js'
import { PublicServer } from '../../src/server/public/index.js'
import { SettingsStore } from '../../src/settings/index.js'
import { fakeEmbeddingSpawn } from '../helpers/fake-llama-server.js'
import { buildGguf } from '../helpers/gguf-builder.js'
import { makeTmpDataFolder } from '../helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../helpers/tmp-data-folder.js'

describe('contract: /v1/embeddings to the embedding module', () => {
  let data: TmpDataFolder
  let service: EmbeddingService
  let server: PublicServer
  let argvFile: string

  beforeAll(async () => {
    data = await makeTmpDataFolder('atomic-core-embedding-contract-')
    argvFile = join(data.root, 'argv.jsonl')
    await data.writeBackend('llamacpp-upstream', 'b11443', 'macos-arm64')
    await data.writeBackend('llamacpp-upstream', 'b11463', 'macos-arm64')
    const folder = join(data.root, 'embedding', 'models', 'embeddinggemma-2')
    await mkdir(folder, { recursive: true })
    await writeFile(
      join(folder, 'embeddinggemma-2-Q8_0.gguf'),
      buildGguf({
        metadata: {
          'general.architecture': 'gemma-embedding2',
          'gemma-embedding2.pooling_type': 1,
          'gemma-embedding2.context_length': 262144,
        },
        tensors: [],
      })
    )
    await writeFile(
      join(folder, 'mmproj-Q8_0.gguf'),
      buildGguf({ metadata: { 'general.architecture': 'clip' }, tensors: [] })
    )
    const settings = await SettingsStore.open(data.layout.core.settings)
    service = wireEmbedding({
      layout: data.layout,
      settings,
      journal: { add: async () => {}, remove: async () => {} },
      instanceId: 'contract',
      emit: () => {},
      log: () => {},
      overrides: { spawn: fakeEmbeddingSpawn({ embedding: { audio: true }, argvFile }) },
    })
    await service.configure({
      enabled: true,
      model_path: 'embedding/models/embeddinggemma-2/embeddinggemma-2-Q8_0.gguf',
      mmproj_path: 'embedding/models/embeddinggemma-2/mmproj-Q8_0.gguf',
      model_id: 'embeddinggemma-2',
      ctx_size: 4096,
      image_max_tokens: 280,
    })
    await service.load()
    server = await PublicServer.start(
      {
        findLocal: () => undefined,
        listLocal: () => [],
        providers: () => new Map(),
        increaseCtx: async () => ({ ok: false }),
        embedding: service.publicBackend(),
      },
      { host: '127.0.0.1', port: 0, apiKey: 'public-key' }
    )
  })

  afterAll(async () => {
    await server?.close()
    await service?.shutdown()
    await data?.cleanup()
  })

  const post = (body: string) =>
    fetch(`http://127.0.0.1:${server.port}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer public-key' },
      body,
    })

  it('starts the newest build at the EmbeddingGemma 2 floor with one ubatch per input', async () => {
    expect(service.getStatus()).toMatchObject({
      state: 'ready',
      model_id: 'embeddinggemma-2',
      engine: { provider: 'llamacpp-upstream', version_backend: 'b11463/macos-arm64' },
      modalities: ['text', 'image', 'audio'],
    })
    const [record] = (await readFile(argvFile, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(record.argv).toEqual(
      expect.arrayContaining([
        '--embedding',
        '-a',
        'embeddinggemma-2',
        '-c',
        '4096',
        '-b',
        '4096',
        '-ub',
        '4096',
        '--image-max-tokens',
        '280',
      ])
    )
    expect(record.argv).toContain('--mmproj')
    // The GGUF names its pooling: the engine reads it, the core does not force one.
    expect(record.argv).not.toContain('--pooling')
  })

  it('passes text and inline media through byte for byte', async () => {
    const body =
      '{"model":"embeddinggemma-2","input":["task: search result | query: 1.0",{"content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgo="}}]},{"content":[{"type":"input_audio","input_audio":{"data":"UklGRg=="}}]}],"encoding_format":"float"}'
    const res = await post(body)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-fake-body-sha256')).toBe(createHash('sha256').update(body).digest('hex'))
    const answer = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> }
    expect(answer.data.map((d) => d.embedding[0])).toEqual([32, 1, 1])
  })

  it('refuses a link and a dimensions the model does not produce, without reaching the engine', async () => {
    const link = await post(
      '{"model":"embeddinggemma-2","input":[{"content":[{"type":"image_url","image_url":{"url":"https://example.com/cat.png"}}]}]}'
    )
    expect(link.status).toBe(400)
    expect(link.headers.get('x-fake-body-sha256')).toBeNull()
    expect((await post('{"model":"embeddinggemma-2","input":"x","dimensions":256}')).status).toBe(400)
  })

  it('lists the model and leaves another name to the sessions', async () => {
    const models = (await (
      await fetch(`http://127.0.0.1:${server.port}/v1/models`, {
        headers: { authorization: 'Bearer public-key' },
      })
    ).json()) as { data: Array<{ id: string; owned_by: string }> }
    expect(models.data).toEqual([
      expect.objectContaining({ id: 'embeddinggemma-2', owned_by: 'atomic-embedding' }),
    ])
    const other = await post('{"model":"sentence-transformer-mini","input":"x"}')
    expect(other.status).toBe(503)
    expect(other.headers.get('x-fake-body-sha256')).toBeNull()
  })
})
