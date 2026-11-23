import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { cores, createCore, data, useCoreHarness } from '../../test/helpers/core-harness.js'
import { CAN_INSTALL_FAKE_BACKEND, installFakeBackend } from '../../test/helpers/fake-backend-pack.js'
import { writeFakeSidecarBinary } from '../../test/helpers/fake-sidecar-server.js'
import { AtomicCoreError } from '../contracts/index.js'
import type { CoreEvents } from '../contracts/index.js'
import { inspectLock } from '../lock/index.js'
import type { ErrorReport } from '../telemetry/index.js'
import { AtomicCore } from './atomic-core.js'

useCoreHarness()

describe('shutdown', () => {
  it('stops the public listener, closes control and releases the lock', async () => {
    const core = await createCore()
    await core.startPublicServer({ port: 0 })
    const controlUrl = core.control.url
    await core.shutdown()
    expect(await inspectLock(data.layout)).toEqual({ kind: 'free' })
    await expect(fetch(`${controlUrl}/atomic/v1/health`)).rejects.toThrow()
    await core.shutdown() // idempotent
  })

  it('rejects new work as soon as shutdown begins', async () => {
    const core = await createCore()
    const stopping = core.shutdown()
    await expect(core.load('llamacpp-upstream', 'late')).rejects.toMatchObject({
      code: 'CORE_NOT_RUNNING',
    })
    await expect(core.unload('llamacpp-upstream', 'late')).rejects.toMatchObject({
      code: 'CORE_NOT_RUNNING',
    })
    await expect(core.startPublicServer({ port: 0 })).rejects.toMatchObject({
      code: 'CORE_NOT_RUNNING',
    })
    await stopping
  })
})

describe('error reporting', () => {
  function recorder() {
    const captured: ErrorReport[] = []
    return {
      captured,
      telemetry: {
        capture: (report: ErrorReport) => captured.push(report),
        state: () => ({
          enabled: true,
          reporting: true,
          has_user: false,
          tags: {},
          source: 'host' as const,
          host: 'test',
        }),
        update: () => {},
      },
    }
  }

  it('reports a load that failed in the engine, with the settings it loaded with, and rethrows', async () => {
    const { captured, telemetry } = recorder()
    const core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0, errorReporter: telemetry })
    cores.push(core)
    const failure = new AtomicCoreError('LLAMA_CPP_PROCESS_ERROR', 'engine failed', 'GGML_ASSERT(x) failed')
    vi.spyOn(core.runtime('llamacpp-upstream'), 'load').mockRejectedValue(failure)
    vi.spyOn(core.runtime('llamacpp-upstream'), 'autoIncreaseCtx').mockRejectedValue(failure)
    vi.spyOn(core.runtime('llamacpp-upstream'), 'recreateSession').mockRejectedValue(failure)
    await expect(
      core.load('llamacpp-upstream', 'org/m-Q4_K_M', { overrides: { ctx_size: 4096 } })
    ).rejects.toBe(failure)
    expect(captured).toEqual([
      expect.objectContaining({
        source: 'model_load',
        fingerprint: ['model-load-failure', 'llamacpp-upstream', 'LLAMA_CPP_PROCESS_ERROR'],
        tags: expect.objectContaining({ context_length: 4096, quant: 'Q4_K_M' }),
        extra: { engine_errors: 'GGML_ASSERT(x) failed' },
      }),
    ])
    await expect(core.increaseCtx('llamacpp-upstream', 'other')).rejects.toBe(failure)
    await expect(core.recreateSession('llamacpp-upstream', 'third')).rejects.toBe(failure)
    expect(captured).toHaveLength(3)
  })

  it('does not report refusals, and loads without a reporter as before', async () => {
    const { captured, telemetry } = recorder()
    const core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0, errorReporter: telemetry })
    cores.push(core)
    await expect(core.load('bogus' as 'mlx', 'm')).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' })
    expect(captured).toEqual([])
    await core.shutdown()

    const plain = await createCore()
    const failure = new AtomicCoreError('OUT_OF_MEMORY', 'oom')
    vi.spyOn(plain.runtime('llamacpp-upstream'), 'load').mockRejectedValue(failure)
    await expect(plain.load('llamacpp-upstream', 'm')).rejects.toBe(failure)
  })
})

describe('chat context: measure and compaction', () => {
  const messages = [
    { role: 'system', content: 'You help.' },
    { role: 'user', content: 'Plan a trip to Kyoto' },
    { role: 'assistant', content: 'Day one: temples. Day two: markets.' },
    { role: 'user', content: 'And day three?' },
  ]

  it('answers MODEL_NOT_LOADED without a session, and PROVIDER_NOT_FOUND for an engine it does not run', async () => {
    const core = await createCore()
    await expect(core.measureContext('llamacpp-upstream', 'nope', { messages })).rejects.toMatchObject({
      code: 'MODEL_NOT_LOADED',
    })
    await expect(core.compactHistory('mlx', 'nope', { messages })).rejects.toMatchObject({
      code: expect.stringMatching(/^(MODEL_NOT_LOADED|PROVIDER_NOT_FOUND)$/),
    })
    await expect(core.measureContext('bogus' as 'mlx', 'm', { messages })).rejects.toMatchObject({
      code: 'PROVIDER_NOT_FOUND',
    })
  })

  it.skipIf(!CAN_INSTALL_FAKE_BACKEND)(
    "counts a llama.cpp chat exactly against the session's window, and compacts it with the same model",
    async () => {
      await data.writeModel('demo')
      await installFakeBackend(data.layout)
      const core = await createCore()
      const compacted: Array<CoreEvents['session:history-compacted']> = []
      core.events.on('session:history-compacted', (event) => compacted.push(event))
      await core.load('llamacpp-upstream', 'demo')

      // The fake renders the messages as their JSON and counts its whitespace-separated pieces.
      const measured = await core.measureContext('llamacpp-upstream', 'demo', { messages })
      expect(measured).toEqual({
        promptTokens: JSON.stringify(messages).split(/\s+/).length,
        exact: true,
        windowTokens: 4096,
        resize: 'reload',
        supportsPromptProgress: true,
      })

      const result = await core.compactHistory('llamacpp-upstream', 'demo', { messages })
      expect(result).toMatchObject({
        summary: 'hello from the fake backend',
        keepFrom: 3,
        summarizedCount: 2,
        cached: false,
      })
      expect(await core.compactHistory('llamacpp-upstream', 'demo', { messages })).toMatchObject({
        cached: true,
      })
      expect(compacted).toEqual([
        expect.objectContaining({
          provider: 'llamacpp-upstream',
          modelId: 'demo',
          source: 'control',
          cached: false,
        }),
        expect.objectContaining({ source: 'control', cached: true }),
      ])

      await expect(
        core.compactHistory('llamacpp-upstream', 'demo', { messages: [{ role: 'user', content: 'only' }] })
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
  )

  it('refuses an embedding session, and measures an MLX chat against the window its runtime started it with', async () => {
    const core = await createCore({ platform: 'darwin' })
    const session = (model_id: string, is_embedding: boolean) => ({
      pid: 1,
      port: 9,
      model_id,
      model_path: '',
      is_embedding,
      api_key: '',
    })
    vi.spyOn(core.runtime('llamacpp-upstream'), 'list').mockReturnValue([session('emb', true)])
    await expect(core.measureContext('llamacpp-upstream', 'emb', { messages })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    const mlx = core.runtime('mlx')
    vi.spyOn(mlx, 'list').mockReturnValue([session('qwen-mlx', false)])
    vi.spyOn(
      mlx as unknown as { getCtxSize: (id: string) => number | undefined },
      'getCtxSize'
    ).mockReturnValue(32768)
    expect(await core.measureContext('mlx', 'qwen-mlx', { messages })).toMatchObject({
      exact: false,
      windowTokens: 32768,
      resize: 'reload',
      supportsPromptProgress: false,
    })
  })

  it.skipIf(!CAN_INSTALL_FAKE_BACKEND)(
    'compacts a public chat that does not fit its session, with the compactor the control API shares',
    async () => {
      await data.writeModel('demo')
      await installFakeBackend(data.layout)
      const core = await createCore()
      const compacted: Array<CoreEvents['session:history-compacted']> = []
      core.events.on('session:history-compacted', (event) => compacted.push(event))
      await core.load('llamacpp-upstream', 'demo')
      const { port } = await core.startPublicServer({ port: 0 })
      const long = [{ role: 'system', content: 'You help.' }]
      for (let i = 0; i < 25; i++) {
        const text = Array.from({ length: 60 }, (_, w) => `t${i}w${w}`).join(' ')
        long.push({ role: 'user', content: text }, { role: 'assistant', content: text })
      }
      long.push({ role: 'user', content: 'What is next?' })
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'demo', messages: long }),
      })
      expect(res.status).toBe(200)
      expect(Number(res.headers.get('x-atomic-compacted'))).toBeGreaterThan(0)
      expect(compacted).toEqual([expect.objectContaining({ source: 'api', cached: false })])
      // The app asking for the same history gets the summary the public server made.
      expect(
        await core.compactHistory('llamacpp-upstream', 'demo', { messages: long, reserveTokens: 1024 })
      ).toMatchObject({
        cached: true,
      })
    }
  )

  it.skipIf(!CAN_INSTALL_FAKE_BACKEND)(
    'estimates an Apple Foundation Models chat, whose server declares no window, and will not compact it',
    async () => {
      const resources = join(data.root, 'resources')
      await writeFakeSidecarBinary(resources, 'foundation-models-server', { kind: 'fm' })
      const core = await createCore({ platform: 'darwin', resourcesDir: resources })
      await expect(
        core.measureContext('foundation-models', 'apple/on-device', { messages })
      ).rejects.toMatchObject({
        code: 'MODEL_NOT_LOADED',
      })
      await core.load('foundation-models', 'apple/on-device')
      const measured = await core.measureContext('foundation-models', 'apple/on-device', { messages })
      expect(measured).toMatchObject({ exact: false, resize: 'fixed', supportsPromptProgress: false })
      expect(measured).not.toHaveProperty('windowTokens')
      expect(measured.promptTokens).toBeGreaterThan(0)
      await expect(
        core.compactHistory('foundation-models', 'apple/on-device', { messages })
      ).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      })
    }
  )
})
