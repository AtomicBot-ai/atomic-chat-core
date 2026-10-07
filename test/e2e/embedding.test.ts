/**
 * The embedding model through the compiled binary (ADR 2026-10-07-embedding-models-are-their-own-core-module):
 * the app's flow — write the `embedding` settings, load, then a client asks `/v1/embeddings` by the
 * model's name on the public server — with the fake engine installed as an upstream llama.cpp pack.
 * A pack below EmbeddingGemma 2's floor is refused with the build to update to; a newer one runs it.
 *
 * No imports from `src/`. POSIX only: the fake backend is a shell script.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'
import { buildGguf } from '../helpers/gguf-builder.js'

const { BIN } = core

let dataFolder: string
const daemons: ChildProcess[] = []

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-embedding-'))
})
afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  core.reapJournalledChildren(dataFolder)
  await rm(dataFolder, { recursive: true, force: true })
})

const control = (ready: ReadyLine, path: string, init: RequestInit = {}) =>
  core.control(dataFolder, ready, path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })

async function writeGemma2(): Promise<void> {
  const folder = join(dataFolder, 'embedding', 'models', 'embeddinggemma-2')
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'embeddinggemma-2-Q8_0.gguf'),
    buildGguf({
      metadata: { 'general.architecture': 'gemma-embedding2', 'gemma-embedding2.pooling_type': 1 },
      tensors: [],
    })
  )
  await writeFile(
    join(folder, 'mmproj-Q8_0.gguf'),
    buildGguf({ metadata: { 'general.architecture': 'clip' }, tensors: [] })
  )
}

const SETTINGS = {
  enabled: true,
  model_path: 'embedding/models/embeddinggemma-2/embeddinggemma-2-Q8_0.gguf',
  mmproj_path: 'embedding/models/embeddinggemma-2/mmproj-Q8_0.gguf',
  model_id: 'embeddinggemma-2',
  ctx_size: 4096,
}

describe.skipIf(!existsSync(BIN) || process.platform === 'win32')('the embedding model', () => {
  it('serves /v1/embeddings by name on a new enough upstream build', async () => {
    await writeGemma2()
    await core.writeFakeBackend(dataFolder, { FAKE_EMBEDDING_AUDIO: '1' }, { version: 'b11463' })
    const { ready } = await core.startDaemon(dataFolder, daemons)

    const configured = await control(ready, '/embedding/config', {
      method: 'PUT',
      body: JSON.stringify(SETTINGS),
    })
    expect(configured.status, await configured.clone().text()).toBe(200)
    const loaded = await control(ready, '/embedding/load', { method: 'POST' })
    expect(loaded.status, await loaded.clone().text()).toBe(200)
    const status = (await loaded.json()) as {
      state: string
      pid: number
      modalities: string[]
      engine: { version_backend: string }
    }
    expect(status).toMatchObject({
      state: 'ready',
      modalities: ['text', 'image', 'audio'],
      engine: { version_backend: `b11463/${core.HOST_BACKEND}` },
    })
    const journal = JSON.parse(readFileSync(join(dataFolder, 'atomic-core', 'processes.json'), 'utf8')) as {
      processes: Array<{ provider: string; pid: number }>
    }
    expect(journal.processes).toContainEqual(
      expect.objectContaining({ provider: 'embedding', pid: status.pid })
    )

    const started = await control(ready, '/server/start', {
      method: 'POST',
      body: JSON.stringify({ port: 0 }),
    })
    expect(started.status, await started.clone().text()).toBe(200)
    const { port } = (await started.json()) as { port: number }
    const base = `http://127.0.0.1:${port}/v1`
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'embeddinggemma-2',
        input: [
          'hello',
          { content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] },
        ],
      }),
    })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(
      ((await res.json()) as { data: Array<{ embedding: number[] }> }).data.map((d) => d.embedding[0])
    ).toEqual([5, 1])
    const link = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'embeddinggemma-2',
        input: [{ content: [{ type: 'image_url', image_url: { url: 'http://x/a.png' } }] }],
      }),
    })
    expect(link.status).toBe(400)
    const models = (await (await fetch(`${base}/models`)).json()) as {
      data: Array<{ id: string; owned_by: string }>
    }
    expect(models.data).toEqual([
      expect.objectContaining({ id: 'embeddinggemma-2', owned_by: 'atomic-embedding' }),
    ])

    const unloaded = await control(ready, '/embedding/unload', { method: 'POST' })
    expect(((await unloaded.json()) as { state: string }).state).toBe('idle')
  })

  it('names the llama.cpp build to update to on an older one', async () => {
    await writeGemma2()
    await core.writeFakeBackend(dataFolder, {}, { version: 'b11443' })
    const { ready } = await core.startDaemon(dataFolder, daemons)
    await control(ready, '/embedding/config', { method: 'PUT', body: JSON.stringify(SETTINGS) })
    const loaded = await control(ready, '/embedding/load', { method: 'POST' })
    expect(loaded.status).toBe(409)
    const body = (await loaded.json()) as { error: { code: string; message: string } }
    expect(body.error).toMatchObject({
      code: 'EMBEDDING_ENGINE_UNSUPPORTED',
      message: expect.stringContaining('b11454'),
    })
    const status = (await (await control(ready, '/embedding/status')).json()) as { state: string }
    expect(status.state).toBe('unsupported')
  })
})
