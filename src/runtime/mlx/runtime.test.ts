import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fakeSidecarSpawn } from '../../../test/helpers/fake-sidecar-server.js'
import type { FakeSidecarOptions } from '../../../test/helpers/fake-sidecar-server.js'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { ProcessJournal } from '../../lock/index.js'
import { ModelRegistry } from '../../models/index.js'
import { MlxRuntime } from './runtime.js'
import type { MlxRuntimeOptions } from './runtime.js'

let data: TmpDataFolder
let journal: ProcessJournal
let registry: ModelRegistry
let events: Array<{ name: string; payload: Record<string, unknown> }>
let argvFile: string
const runtimes: MlxRuntime[] = []

beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-mlx-')
  journal = await ProcessJournal.open(data.layout)
  registry = new ModelRegistry(data.layout, 'mlx')
  events = []
  argvFile = join(data.root, 'argv.jsonl')
})
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.shutdown().catch(() => {})))
  await data.cleanup()
})

/** An MLX model as the extension downloads it: weights and config.json beside model.yml. */
async function writeMlxModel(
  id: string,
  config: Record<string, unknown> = { max_position_embeddings: 40960 }
) {
  const dir = join(data.root, 'mlx', 'models', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'model.safetensors'), 'weights')
  await writeFile(join(dir, 'config.json'), JSON.stringify(config))
  await registry.write(id, { model_path: `mlx/models/${id}/model.safetensors`, name: id, size_bytes: 7 })
  return dir
}

function runtime(
  settings: Record<string, unknown> = {},
  fake: Partial<FakeSidecarOptions> = {},
  extra: Partial<MlxRuntimeOptions> = {}
) {
  const r = new MlxRuntime({
    layout: data.layout,
    registry,
    instanceId: 'test-instance',
    resourcesDir: '/resources/bin',
    readSettings: async () => settings,
    journal,
    emit: (name, payload) => events.push({ name, payload: payload as Record<string, unknown> }),
    exists: (path) => path === '/resources/bin/mlx-server' || !path.startsWith('/resources'),
    spawn: fakeSidecarSpawn({ kind: 'mlx', argvFile, ...fake }),
    ...extra,
  })
  runtimes.push(r)
  return r
}

async function argvs(): Promise<string[][]> {
  const text = await readFile(argvFile, 'utf8').catch(() => '')
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[])
}

describe('MlxRuntime', () => {
  it('starts mlx-server on the model folder with the context capped at the default and no key', async () => {
    const dir = await writeMlxModel('qwen')
    const r = runtime()
    const session = await r.load('qwen')

    expect(session).toMatchObject({ model_id: 'qwen', model_path: dir, api_key: '', is_embedding: false })
    expect(await argvs()).toEqual([
      ['--model', dir, '--host', '127.0.0.1', '--port', String(session.port), '--max-kv-size', '16384'],
    ])
    expect(r.getCtxSize('qwen')).toBe(16384)
    const res = await fetch(`http://127.0.0.1:${session.port}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: dir, messages: [] }),
    })
    expect(res.status).toBe(200)
    expect(journal.list().map((record) => record.provider)).toEqual(['mlx'])
  })

  it('passes quantization, the drafter and a pinned context from settings and overrides', async () => {
    const dir = await writeMlxModel('gemma', { text_config: { max_position_embeddings: '8192' } })
    const r = runtime({
      kv_quant_scheme: 'turboquant',
      kv_bits: '3.5',
      mtp_enabled: true,
      mtp_block_size: '4',
    })
    const session = await r.load('gemma', { overrides: { ctx_size: 32768, draft_model_path: '/drafts/mtp' } })
    expect((await argvs())[0]).toEqual([
      '--model',
      dir,
      '--host',
      '127.0.0.1',
      '--port',
      String(session.port),
      '--max-kv-size',
      '8192',
      '--draft-model',
      '/drafts/mtp',
      '--draft-kind',
      'mtp',
      '--draft-block-size',
      '4',
      '--kv-bits',
      '3.5',
      '--kv-quant-scheme',
      'turboquant',
    ])
  })

  it('restores a switched-on drafter already on disk, and loads without one otherwise', async () => {
    await writeMlxModel('mlx-community/gemma-4-e4b-it-bf16')
    const draftDir = join(data.root, 'mlx', 'draft-models', 'found', 'drafter')
    const resolved: string[] = []
    const r = runtime(
      { mtp_enabled: true },
      {},
      {
        resolveDraft: async (kind, modelId) => {
          resolved.push(`${kind} ${modelId}`)
          return resolved.length === 1 ? draftDir : undefined
        },
      }
    )
    await r.load('mlx-community/gemma-4-e4b-it-bf16')
    expect((await argvs())[0]).toContain(draftDir)
    await r.unload('mlx-community/gemma-4-e4b-it-bf16')
    await r.load('mlx-community/gemma-4-e4b-it-bf16')
    expect((await argvs())[1]).not.toContain('--draft-model')
    expect(resolved).toEqual([
      'mtp mlx-community/gemma-4-e4b-it-bf16',
      'mtp mlx-community/gemma-4-e4b-it-bf16',
    ])
    expect(
      events.some(
        (e) => e.name === 'core:log' && String(e.payload['msg']).includes('loading without drafter')
      )
    ).toBe(true)
  })

  it('finds a drafter on disk through the registries by default', async () => {
    const r = runtime()
    const local = (
      r as unknown as { localDraft: (kind: string, id: string) => Promise<string | undefined> }
    ).localDraft.bind(r)
    expect(await local('mtp', 'not-a-known-model')).toBeUndefined()
    expect(await local('eagle3', 'not-a-known-model')).toBeUndefined()
    expect(await local('dflash', 'not-a-known-model')).toBeUndefined()
  })

  it('unloads other models first unless told not to, and keeps them for an embedding load', async () => {
    await writeMlxModel('a')
    await writeMlxModel('b')
    await writeMlxModel('c')
    const r = runtime()
    await r.load('a')
    await r.load('b')
    expect(r.getLoadedModels()).toEqual(['b'])
    await r.load('c', { bypassAutoUnload: true })
    expect(r.getLoadedModels().sort()).toEqual(['b', 'c'])
    const keep = runtime({ auto_unload: false })
    await writeMlxModel('d')
    await keep.load('d')
    await keep.load('a', { isEmbedding: true })
    expect(keep.getLoadedModels().sort()).toEqual(['a', 'd'])
  })

  it('grows the context up the ladder, keeping the drafter, and stops at the trained maximum', async () => {
    await writeMlxModel('small', { max_position_embeddings: 32768 })
    const r = runtime({}, { minCtx: 30000 })
    await r.load('small', { overrides: { ctx_size: 4096, draft_model_path: '/d', dflash_enabled: true } })
    const grown = await r.autoIncreaseCtx('small', 'error')
    expect(grown).toMatchObject({ ok: true, new_ctx_len: 8192 })
    expect((await argvs())[1]).toEqual(
      expect.arrayContaining(['--max-kv-size', '8192', '--draft-model', '/d'])
    )
    expect(events.find((e) => e.name === 'session:ctx-increased')?.payload).toEqual({
      provider: 'mlx',
      modelId: 'small',
      oldCtx: 4096,
      newCtx: 8192,
      reason: 'error',
    })
    expect(await r.autoIncreaseCtx('small')).toMatchObject({ ok: true, new_ctx_len: 32768 })
    expect(await r.autoIncreaseCtx('small')).toEqual({
      ok: false,
      reason: 'at_max',
      current_ctx_len: 32768,
      max_ctx_len: 32768,
    })
    expect(await r.autoIncreaseCtx('missing')).toEqual({ ok: false, reason: 'not-loaded' })
    const recreated = await r.recreateSession('small')
    expect(recreated.ok && r.getCtxSize('small')).toBe(32768)
    expect(await r.recreateSession('missing')).toEqual({ ok: false, reason: 'not-loaded' })
  })

  it('reports an unknown trained context as at_max only once the ladder is exhausted', async () => {
    await writeMlxModel('nocfg', {})
    const r = runtime()
    await r.load('nocfg')
    expect(r.getCtxSize('nocfg')).toBe(4096)
    expect(await r.autoIncreaseCtx('nocfg')).toMatchObject({ ok: true, new_ctx_len: 8192 })
  })

  it('explains a missing binary, a missing model file and an unknown model', async () => {
    await writeMlxModel('m')
    await expect(runtime({}, {}, { resourcesDir: undefined }).load('m')).rejects.toMatchObject({
      code: 'BINARY_NOT_FOUND',
    })
    const binary = join('/resources/bin', 'mlx-server')
    await expect(runtime({}, {}, { exists: () => false }).load('m')).rejects.toMatchObject({
      code: 'BINARY_NOT_FOUND',
      message: `MLX server binary not found at: ${binary}`,
    })
    await expect(runtime({}, {}, { exists: (path) => path === binary }).load('m')).rejects.toMatchObject({
      code: 'MODEL_FILE_NOT_FOUND',
      message: expect.stringContaining('Model file not found at: '),
    })
    await expect(runtime().load('nope')).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
  })

  it('classifies a crash during load and a server that never comes up', async () => {
    await writeMlxModel('m')
    await expect(runtime({}, { mode: 'oom' }).load('m')).rejects.toMatchObject({ code: 'OUT_OF_MEMORY' })
    await expect(runtime({}, { mode: 'exit-clean' }).load('m')).rejects.toMatchObject({
      code: 'MLX_PROCESS_ERROR',
    })
    await expect(runtime({ timeout: '0.3' }, { mode: 'hang' }).load('m')).rejects.toMatchObject({
      code: 'MODEL_LOAD_TIMED_OUT',
      message: 'The MLX model took too long to load and timed out.',
      details: expect.stringContaining('Timeout: 0.3s'),
    })
  })

  it('kills a server that is still coming up when the user cancels, and keeps the models that were loaded', async () => {
    await writeMlxModel('resident')
    await writeMlxModel('huge')
    const r = runtime({ auto_unload: false })
    await r.load('resident')
    const hanging = new MlxRuntime({
      layout: data.layout,
      registry,
      instanceId: 'test-instance',
      resourcesDir: '/resources/bin',
      readSettings: async () => ({ auto_unload: false }),
      journal,
      emit: (name, payload) => events.push({ name, payload: payload as Record<string, unknown> }),
      exists: (path) => path === '/resources/bin/mlx-server' || !path.startsWith('/resources'),
      spawn: fakeSidecarSpawn({ kind: 'mlx', mode: 'hang', argvFile }),
    })
    runtimes.push(hanging)
    const before = (await argvs()).length
    const cancel = new AbortController()
    const load = hanging.load('huge', { signal: cancel.signal })
    // The fake records its argv on startup: a new line means the child is running.
    while ((await argvs()).length === before) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(hanging.isLoading('huge')).toBe(true)

    cancel.abort()
    await expect(load).rejects.toMatchObject({
      code: 'MODEL_LOAD_CANCELLED',
      message: 'The model load was cancelled.',
    })
    expect(hanging.list()).toEqual([])
    expect(hanging.isLoading('huge')).toBe(false)
    expect(journal.list().map((entry) => entry.model_id)).toEqual(['resident'])
    expect(events.filter((e) => e.name === 'session:started').map((e) => e.payload['model_id'])).toEqual([
      'resident',
    ])
  })

  it('does not unload anything for a load that was cancelled before it started', async () => {
    await writeMlxModel('resident')
    await writeMlxModel('never')
    const r = runtime()
    await r.load('resident')
    await expect(r.load('never', { signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: 'MODEL_LOAD_CANCELLED',
    })
    // Auto-unload is on by default; a cancelled load must not have evicted the resident model.
    expect(r.getLoadedModels()).toEqual(['resident'])
  })

  it('heals a mis-named first shard before loading', async () => {
    const dir = await writeMlxModel('sharded')
    await writeFile(
      join(dir, 'model.safetensors.index.json'),
      JSON.stringify({
        weight_map: { a: 'model-00001-of-00002.safetensors', b: 'model-00002-of-00002.safetensors' },
      })
    )
    await writeFile(join(dir, 'model-00002-of-00002.safetensors'), 'w2')
    await runtime().load('sharded')
    expect((await registry.read('sharded')).model_path).toBe(
      'mlx/models/sharded/model-00001-of-00002.safetensors'
    )
  })

  // Windows has no signals: a killed process there exits with code 1 and no signal to name.
  it.skipIf(process.platform === 'win32')(
    'drops a session whose server died, with the external-kill diagnosis',
    async () => {
      await writeMlxModel('m')
      const r = runtime()
      const session = await r.load('m')
      process.kill(session.pid, 'SIGKILL')
      await expect.poll(() => r.list().length).toBe(0)
      await expect
        .poll(() => events.find((e) => e.name === 'session:died')?.payload['message'])
        .toBe('MLX server terminated by signal SIGKILL — an external process killed it.')
    }
  )

  it('writes a log file and relays lines when verbose', async () => {
    await writeMlxModel('m')
    const logPath = join(data.root, 'logs', 'mlx.log')
    await runtime().load('m', { logPath, verbose: true })
    expect(await readFile(logPath, 'utf8')).toContain('Uvicorn running on')
    expect(events.some((e) => e.name === 'core:log' && String(e.payload['msg']).startsWith('[mlx/m]'))).toBe(
      true
    )
  })
})
