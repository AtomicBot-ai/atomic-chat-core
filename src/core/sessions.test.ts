import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAN_INSTALL_FAKE_BACKEND, installFakeBackend } from '../../test/helpers/fake-backend-pack.js'
import {
  cores,
  createCore,
  data,
  putHardwareOverride,
  useCoreHarness,
} from '../../test/helpers/core-harness.js'
import { CoreClient } from '../client/index.js'
import { writeFakeSidecarBinary } from '../../test/helpers/fake-sidecar-server.js'
import { AtomicCore } from './index.js'

useCoreHarness()

describe.skipIf(!CAN_INSTALL_FAKE_BACKEND)('serving a model end to end', () => {
  it('passes an injected CPU feature set into the real load plan', async () => {
    const core = await createCore()
    await data.writeModel('cpu-model')
    await installFakeBackend(data.layout, { version: 'b7000', backend: 'win-cpu-x64' })
    await core.settings.update('llamacpp-upstream', {
      version_backend: 'b7000/win-cpu-x64',
    })
    await putHardwareOverride(core, {
      gpus: [],
      cpu_extensions: ['avx2'],
      os_type: 'windows',
    })

    await expect(core.load('llamacpp-upstream', 'cpu-model')).resolves.toMatchObject({
      model_id: 'cpu-model',
    })
  })

  it.skipIf(process.arch !== 'x64')(
    'uses the app hardware override for CPU preflight before spawning',
    async () => {
      const core = await createCore()
      await data.writeModel('cpu-model')
      await installFakeBackend(data.layout, { version: 'b7000', backend: 'win-cpu-x64' })
      await core.settings.update('llamacpp-upstream', {
        version_backend: 'b7000/win-cpu-x64',
      })

      // A CPU that reports its flags and none of them is AVX. An empty list means "unknown" and
      // never blocks (policy.ts, isUnsupportedNoAvxCpu).
      await putHardwareOverride(core, { gpus: [], cpu_extensions: ['sse2'], os_type: 'windows' })
      await expect(core.load('llamacpp-upstream', 'cpu-model')).rejects.toMatchObject({
        code: 'CPU_NO_AVX',
      })

      await putHardwareOverride(core, {
        gpus: [],
        cpu_extensions: ['AVX2'],
        os_type: 'windows',
      })
      await expect(core.load('llamacpp-upstream', 'cpu-model')).resolves.toMatchObject({
        model_id: 'cpu-model',
      })
    }
  )

  it.skipIf(process.arch !== 'x64')(
    'uses injected GPU facts when choosing an installed fallback backend',
    async () => {
      const core = await createCore()
      await data.writeModel('gpu-model')
      await installFakeBackend(data.layout, { version: 'b7000', backend: 'win-cpu-x64' })
      await installFakeBackend(data.layout, { version: 'b7000', backend: 'win-cuda-13.3-x64' })
      await core.settings.update('llamacpp-upstream', { version_backend: 'none' })
      await putHardwareOverride(core, {
        os_type: 'windows',
        cpu_extensions: ['avx2'],
        gpus: [
          {
            vendor: 'NVIDIA',
            driver_version: '581.42',
            total_memory: 24_576,
            nvidia_info: { compute_capability: '8.9' },
            vulkan_info: { device_type: 'DiscreteGpu', device_id: 9860 },
          },
        ],
      })
      const reported = new Promise<{ configuredVersionBackend: string }>((resolve) => {
        core.events.once('backend:runtime-reported', resolve)
      })

      await core.load('llamacpp-upstream', 'gpu-model')

      await expect(reported).resolves.toMatchObject({
        configuredVersionBackend: 'b7000/win-cuda-13.3-x64',
      })
    }
  )

  it('loads through the facade, serves it over /v1 and unloads again', async () => {
    const core = await createCore()
    await data.writeModel('demo')
    await installFakeBackend(data.layout)

    const session = await core.load('llamacpp-upstream', 'demo')
    expect(session).toMatchObject({ model_id: 'demo', is_embedding: false })
    expect(core.sessions()).toMatchObject([{ model_id: 'demo', provider: 'llamacpp-upstream' }])

    const state = await core.startPublicServer({ port: 0 })
    const models = (await (await fetch(`http://127.0.0.1:${state.port}/v1/models`)).json()) as {
      data: Array<{ id: string }>
    }
    expect(models.data.map((m) => m.id)).toEqual(['demo'])
    const answer = await fetch(`http://127.0.0.1:${state.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'demo', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(answer.status).toBe(200)

    expect(await core.unload('llamacpp-upstream', 'demo')).toEqual({ success: true })
    expect(core.sessions()).toEqual([])
  })

  it('drives load and unload through the control API too', async () => {
    const core = await createCore()
    await data.writeModel('Owner/Repo-GGUF')
    await installFakeBackend(data.layout)
    const client = new CoreClient({ baseUrl: core.control.url, token: core.controlToken })

    const session = await client.loadModel('llamacpp-upstream', 'Owner/Repo-GGUF')
    expect(session.model_id).toBe('Owner/Repo-GGUF')
    expect((await client.snapshot()).sessions).toHaveLength(1)
    expect(await client.unloadModel('llamacpp-upstream', 'Owner/Repo-GGUF')).toEqual({ success: true })
    expect((await client.sessions()).sessions).toEqual([])
  })

  it('refuses a model the desktop app already holds, instead of loading a second copy', async () => {
    const core = await createCore()
    await data.writeModel('demo')
    await installFakeBackend(data.layout)
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await writeFile(
      join(data.layout.core.dir, 'legacy-runtime.json'),
      JSON.stringify({
        pid: process.pid,
        updated_at: 1,
        provider: 'llamacpp-upstream',
        sessions: [{ model_id: 'demo', port: 3311, pid: 4242, is_embedding: false }],
      })
    )
    await expect(core.load('llamacpp-upstream', 'demo')).rejects.toMatchObject({
      code: 'CORE_ALREADY_RUNNING',
      details: expect.stringContaining('127.0.0.1:3311') as unknown as string,
    })
    expect(core.sessions(), 'nothing was spawned').toEqual([])
  })

  it('reports a model with no backend installed as BINARY_NOT_FOUND', async () => {
    const core = await createCore()
    await data.writeModel('demo')
    await expect(core.load('llamacpp-upstream', 'demo')).rejects.toMatchObject({ code: 'BINARY_NOT_FOUND' })
  })

  it('loads an explicit GGUF and --bin equivalent in a clean data folder', async () => {
    const pack = await installFakeBackend(data.layout)
    const externalBin = join(data.root, 'custom-llama-server')
    await writeFile(externalBin, await readFile(pack.exePath))
    await chmod(externalBin, 0o755)
    await rm(data.layout.provider('llamacpp-upstream').backendsDir, { recursive: true, force: true })
    const modelPath = join(data.root, 'outside-registry.gguf')
    await writeFile(modelPath, Buffer.alloc(64, 0x47))
    const core = await createCore()

    const session = await core.load('llamacpp-upstream', 'outside-registry', {
      modelPath,
      exePath: externalBin,
      versionBackend: 'cli/llama-server',
      timeoutSecs: 5,
    })
    expect(session).toMatchObject({ model_id: 'outside-registry', model_path: modelPath })
  })

  it('grows the context of a local model whose request overflowed it, and replays the request', async () => {
    const core = await createCore()
    await data.writeModel('demo')
    await installFakeBackend(data.layout, { minCtx: 8192 })
    // With fit on (the default) llama.cpp sizes the window itself and the core declines to grow it.
    await core.settings.update('llamacpp-upstream', { fit: false })
    const before = await core.load('llamacpp-upstream', 'demo')
    const { port } = await core.startPublicServer({ port: 0 })

    const answer = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'demo', messages: [{ role: 'user', content: 'hi' }] }),
    })

    expect(answer.status).toBe(200)
    const [after] = core.sessions()
    expect(after?.pid).not.toBe(before.pid)
    expect(core.llamacpp().getCtxSize('demo')).toBeGreaterThanOrEqual(8192)
  })

  it.skipIf(process.platform === 'win32')(
    'serves an MLX model through the public API and grows its context when mlx-vlm overflows',
    async () => {
      const resources = join(data.root, 'resources')
      await writeFakeSidecarBinary(resources, 'mlx-server', { kind: 'mlx', minCtx: 30000 })
      const modelDir = join(data.root, 'mlx', 'models', 'qwen-mlx')
      await mkdir(modelDir, { recursive: true })
      await writeFile(join(modelDir, 'model.safetensors'), 'w')
      await writeFile(join(modelDir, 'config.json'), JSON.stringify({ max_position_embeddings: 32768 }))
      const core = await AtomicCore.create({
        dataFolder: data.root,
        controlPort: 0,
        platform: 'darwin',
        resourcesDir: resources,
      })
      cores.push(core)
      await core.registry('mlx').write('qwen-mlx', {
        model_path: 'mlx/models/qwen-mlx/model.safetensors',
        name: 'qwen-mlx',
        size_bytes: 1,
      })
      const before = await core.load('mlx', 'qwen-mlx')
      const { port } = await core.startPublicServer({ port: 0 })

      const answer = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'qwen-mlx', messages: [{ role: 'user', content: 'hi' }] }),
      })

      expect(answer.status).toBe(200)
      expect(
        ((await answer.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message
          .content
      ).toBe('fake mlx reply')
      const [after] = core.sessions()
      expect(after).toMatchObject({ provider: 'mlx', model_id: 'qwen-mlx', api_key: '' })
      expect(after?.pid).not.toBe(before.pid)
      const models = (await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()) as {
        data: Array<{ id: string }>
      }
      expect(models.data.map((m) => m.id)).toContain('qwen-mlx')
    }
  )

  // The fork's only Linux arm64 build is CUDA 13, which this host has none of: nothing to select.
  it.skipIf(!CAN_INSTALL_FAKE_BACKEND || (process.platform === 'linux' && process.arch === 'arm64'))(
    'loads a TurboQuant model on a fork build it selects itself, and serves it',
    async () => {
      const core = await createCore()
      await data.writeModel('demo')
      const hostBackend =
        process.platform === 'darwin'
          ? `macos-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
          : 'linux-x64-vulkan'
      await installFakeBackend(data.layout, {
        provider: 'llamacpp',
        version: 'b10018-1.3.0',
        backend: hostBackend,
      })
      // No backend chosen yet: the core picks the installed fork build with the TurboQuant matrix.
      await core.settings.update('llamacpp', { version_backend: '', fit: false })
      const events: string[] = []
      core.events.on('session:started', (payload) => events.push(payload.provider))

      const session = await core.load('llamacpp', 'demo')

      expect(core.sessions()).toMatchObject([{ provider: 'llamacpp', model_id: 'demo', pid: session.pid }])
      expect(events).toEqual(['llamacpp'])
      const { port } = await core.startPublicServer({ port: 0 })
      const answer = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'demo', messages: [{ role: 'user', content: 'hi' }] }),
      })
      expect(answer.status).toBe(200)
      await expect(core.unload('llamacpp', 'demo')).resolves.toEqual({ success: true })
    }
  )

  it('restarts a poisoned engine at the same context and tells the client not to retry', async () => {
    const core = await createCore()
    await data.writeModel('demo')
    const marker = join(data.root, 'compute-error-once')
    await installFakeBackend(data.layout, { computeErrorMarker: marker })
    const before = await core.load('llamacpp-upstream', 'demo')
    const ctxBefore = core.llamacpp().getCtxSize('demo')
    const { port } = await core.startPublicServer({ port: 0 })
    const chat = () =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'demo', messages: [{ role: 'user', content: 'hi' }] }),
      })

    const failed = await chat()

    expect(failed.status).toBe(400)
    expect(((await failed.json()) as { error: { code: string } }).error.code).toBe('insufficient_memory')
    expect(core.sessions()[0]?.pid).not.toBe(before.pid)
    expect(core.llamacpp().getCtxSize('demo')).toBe(ctxBefore)
    expect((await chat()).status).toBe(200)
  })

  it('stops every session when the core shuts down', async () => {
    const core = await createCore()
    await data.writeModel('demo')
    await installFakeBackend(data.layout)
    const session = await core.load('llamacpp-upstream', 'demo')
    await core.shutdown()
    const { isProcessAlive } = await import('../lock/index.js')
    const deadline = Date.now() + 5000
    while (isProcessAlive(session.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    expect(isProcessAlive(session.pid)).toBe(false)
  })
})

describe('sessions the app still owns', () => {
  it('routes to a registered external session and asks its owner to grow the context', async () => {
    const { startStub, json } = await import('../../test/helpers/chatgpt-stub.js')
    let calls = 0
    const engine = await startStub((_req, res) => {
      calls++
      if (calls === 1)
        return json(res, 500, { error: { message: 'the request exceeds the available context size' } })
      json(res, 200, { choices: [{ message: { content: 'from the app engine' } }] })
    })
    try {
      const core = await createCore()
      const control = (path: string, init: RequestInit) =>
        fetch(`${core.control.url}/atomic/v1${path}`, {
          ...init,
          headers: { 'authorization': `Bearer ${core.controlToken}`, 'content-type': 'application/json' },
        })
      core.events.on('external-sessions:ctx-requested', (asked) => {
        // The owner reloads, publishes where the model now is, then answers.
        void control(`/external-sessions/app/ctx/${asked.request_id}`, {
          method: 'POST',
          body: JSON.stringify({ ok: true, new_ctx_len: 32768 }),
        })
      })
      const published = await control('/external-sessions/app', {
        method: 'PUT',
        body: JSON.stringify({
          generation: 1,
          sessions: [
            { provider: 'mlx', model_id: 'Qwen3.5-MLX', port: engine.port, api_key: '', is_embedding: false },
          ],
        }),
      })
      expect(await published.json()).toEqual({ generation: 1, sessions: 1 })
      const recreate = await control('/models/llamacpp-upstream/not-loaded/recreate', { method: 'POST' })
      expect(await recreate.json()).toEqual({ ok: false, reason: 'not-loaded' })
      expect(core.inspecting).toBe(false)
      await control('/server/inspector', { method: 'PUT', body: '{"enabled":true}' })
      expect(core.inspecting).toBe(true)
      const listed = (await (await control('/external-sessions', { method: 'GET' })).json()) as {
        sessions: object[]
      }
      expect(listed.sessions).toEqual([
        {
          owner: 'app',
          provider: 'mlx',
          model_id: 'Qwen3.5-MLX',
          port: engine.port,
          is_embedding: false,
          pid: null,
        },
      ])
      const { port } = await core.startPublicServer({ port: 0 })

      const models = (await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()) as {
        data: Array<{ id: string; owned_by: string }>
      }
      expect(models.data).toEqual([expect.objectContaining({ id: 'Qwen3.5-MLX', owned_by: 'mlx' })])
      const answer = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Qwen3_5-MLX', messages: [] }),
      })

      expect(await answer.json()).toEqual({ choices: [{ message: { content: 'from the app engine' } }] })
      expect(calls).toBe(2)
      expect(
        (await control('/external-sessions/app/heartbeat', { method: 'POST', body: '{"generation":1}' }))
          .status
      ).toBe(200)
      await control('/external-sessions/app', { method: 'DELETE' })
      const gone = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Qwen3.5-MLX', messages: [] }),
      })
      expect(gone.status).toBe(503)
    } finally {
      await engine.close()
    }
  })
})
