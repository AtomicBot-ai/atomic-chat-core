import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvents } from '../contracts/index.js'
import type { ChildProcessRecord } from '../lock/index.js'
import { SettingsStore } from '../settings/index.js'
import { fakeEmbeddingSpawn } from '../../test/helpers/fake-llama-server.js'
import { buildGguf } from '../../test/helpers/gguf-builder.js'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { EmbeddingService } from './service.js'
import { embeddingJournal, noticeEmbeddingEngineInstall, wireEmbedding } from './wiring.js'

let data: TmpDataFolder
const services: EmbeddingService[] = []

beforeEach(async () => {
  data = await makeTmpDataFolder()
})
afterEach(async () => {
  for (const s of services.splice(0)) await s.shutdown()
  await data.cleanup()
})

function fakeJournal() {
  const records: ChildProcessRecord[] = []
  const removed: number[] = []
  return {
    records,
    removed,
    add: async (record: ChildProcessRecord) => void records.push(record),
    remove: async (pid: number) => void removed.push(pid),
  }
}

const until = async (done: () => boolean) => {
  for (let i = 0; i < 500 && !done(); i++) await new Promise((r) => setTimeout(r, 10))
}

/** An EmbeddingGemma 2 header, as the real file has it. */
const gemma2 = () =>
  buildGguf({
    metadata: {
      'general.architecture': 'gemma-embedding2',
      'gemma-embedding2.pooling_type': 1,
      'gemma-embedding2.context_length': 262144,
    },
    tensors: [],
  })

describe('embeddingJournal', () => {
  it('journals the process under the embedding provider, with its start identity', async () => {
    const journal = fakeJournal()
    const adapter = embeddingJournal(journal, 'instance-1', () => 1_700_000_000_000)
    await adapter.add(process.pid, 4242, '/packs/llama-server', 'embeddinggemma-2')
    expect(journal.records).toEqual([
      {
        instance_id: 'instance-1',
        pid: process.pid,
        process_start_id: expect.any(String),
        exe: '/packs/llama-server',
        provider: 'embedding',
        model_id: 'embeddinggemma-2',
        port: 4242,
        started_at: '2023-11-14T22:13:20.000Z',
      },
    ])
    await adapter.remove(process.pid)
    expect(journal.removed).toEqual([process.pid])
  })
})

describe('noticeEmbeddingEngineInstall', () => {
  it('retries on a finished llama.cpp install only, and swallows a failed retry', async () => {
    const calls: Array<string | undefined> = []
    const service = {
      onEnginesChanged: async (provider?: string) => {
        calls.push(provider)
        throw new Error('settings unreadable')
      },
    } as unknown as Pick<EmbeddingService, 'onEnginesChanged'>
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      noticeEmbeddingEngineInstall(service, 'llamacpp', true)
      noticeEmbeddingEngineInstall(service, 'llamacpp-upstream', false)
      expect(calls).toEqual([])
      noticeEmbeddingEngineInstall(service, 'llamacpp-upstream', true)
      expect(calls).toEqual(['llamacpp-upstream'])
      await new Promise((r) => setTimeout(r, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('wireEmbedding', () => {
  it('runs the configured model on the installed upstream build and journals it for its whole life', async () => {
    const settings = await SettingsStore.open(data.layout.core.settings)
    await writeFile(join(data.root, 'gemma.gguf'), gemma2())
    await writeFile(join(data.root, 'mmproj.gguf'), 'GGUF')
    const exe = await data.writeBackend('llamacpp-upstream', 'b11463', 'macos-arm64')
    const journal = fakeJournal()
    const events: string[] = []
    const service = wireEmbedding({
      layout: data.layout,
      settings,
      journal,
      instanceId: 'instance-1',
      emit: (name) => void events.push(name),
      log: () => {},
      platform: process.platform,
      overrides: { spawn: fakeEmbeddingSpawn({ embedding: { audio: true } }) },
    })
    services.push(service)
    expect(service.getStatus().state).toBe('disabled')
    await service.configure({
      enabled: true,
      model_path: 'gemma.gguf',
      mmproj_path: 'mmproj.gguf',
      model_id: 'embeddinggemma-2',
      ctx_size: 4096,
    })
    const ready = await service.load()
    expect(ready).toMatchObject({
      state: 'ready',
      model_path: join(data.root, 'gemma.gguf'),
      model_id: 'embeddinggemma-2',
      engine: { path: exe, version_backend: 'b11463/macos-arm64', provider: 'llamacpp-upstream' },
      modalities: ['text', 'image', 'audio'],
    })
    expect(settings.embedding).toMatchObject({ enabled: true, model_path: 'gemma.gguf' })
    expect(journal.records).toMatchObject([
      { provider: 'embedding', pid: ready.pid, model_id: 'embeddinggemma-2' },
    ])
    await service.unload()
    await until(() => journal.removed.length > 0)
    expect(journal.removed).toContain(ready.pid)
    expect(events).toContain('embedding:state')
  })

  it('is unsupported on a build too old for EmbeddingGemma 2, and starts once a new one is installed', async () => {
    const settings = await SettingsStore.open(data.layout.core.settings)
    await writeFile(join(data.root, 'gemma.gguf'), gemma2())
    await data.writeBackend('llamacpp-upstream', 'b11443', 'macos-arm64')
    const listeners: Array<(event: CoreEvents['backend:download-finished']) => void> = []
    const service = wireEmbedding({
      layout: data.layout,
      settings,
      journal: fakeJournal(),
      instanceId: 'instance-1',
      emit: () => {},
      on: (_name, listener) => {
        listeners.push(listener)
        return () => {}
      },
      log: () => {},
      platform: process.platform,
      overrides: { spawn: fakeEmbeddingSpawn() },
    })
    services.push(service)
    await service.configure({ enabled: true, model_path: 'gemma.gguf' })
    await until(() => service.getStatus().state === 'unsupported')
    expect(service.getStatus()).toMatchObject({
      state: 'unsupported',
      error: { code: 'EMBEDDING_ENGINE_UNSUPPORTED', message: expect.stringContaining('b11454') },
    })
    const exe = await data.writeBackend('llamacpp-upstream', 'b11463', 'macos-arm64')
    listeners[0]!({ provider: 'llamacpp-upstream', backend: 'macos-arm64', version: 'b11463', success: true })
    await until(() => service.getStatus().state === 'ready')
    expect(service.getStatus()).toMatchObject({ state: 'ready', engine: { path: exe } })
  })
})
