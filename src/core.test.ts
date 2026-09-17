import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAN_INSTALL_FAKE_BACKEND, installFakeBackend } from '../test/helpers/fake-backend-pack.js'
import { makeTmpDataFolder } from '../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../test/helpers/tmp-data-folder.js'
import { CoreClient } from './client/index.js'
import { writeFakeSidecarBinary } from '../test/helpers/fake-sidecar-server.js'
import { AtomicCore, CORE_VERSION } from './core.js'
import { inspectLock, ProcessJournal, readControlToken } from './lock/index.js'

let data: TmpDataFolder
const cores: AtomicCore[] = []

beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-facade-')
})
afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.shutdown()))
  await data.cleanup()
})

async function createCore(): Promise<AtomicCore> {
  const core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0 })
  cores.push(core)
  return core
}

async function putHardwareOverride(core: AtomicCore, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${core.control.url}/atomic/v1/hardware/override`, {
    method: 'PUT',
    headers: {
      'authorization': `Bearer ${core.controlToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
}

describe('taking ownership', () => {
  it('expires an app owner after its registration vanishes, without changing CLI lifetime', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    try {
      const app = await AtomicCore.create({ dataFolder: data.root, ownerScope: 'app' })
      cores.push(app)
      const client = new CoreClient({ baseUrl: app.control.url, token: app.controlToken })
      const registration = await client.register()
      expect((await client.handshake('app')).owner_scope).toBe('app')
      await vi.advanceTimersByTimeAsync(5_000)
      await client.unregister(registration.client.id)
      await vi.advanceTimersByTimeAsync(5_000)
      await app.stopped
      expect((await inspectLock(data.layout)).kind).toBe('free')
    } finally {
      vi.useRealTimers()
    }
  })
  it('disposes a CLI owner explicitly without an application lease', async () => {
    const core = await createCore()
    await core.dispose()
    expect((await inspectLock(data.layout)).kind).toBe('free')
  })
  it('locks the folder, mints a token, starts control and publishes where it listens', async () => {
    const core = await createCore()
    expect(core.version).toBe(CORE_VERSION)
    expect(core.control.host).toBe('127.0.0.1')
    expect(core.control.port).toBeGreaterThan(0)

    const lock = await inspectLock(data.layout)
    expect(lock).toMatchObject({ kind: 'owned' })
    if (lock.kind !== 'owned') throw new Error('expected an owned lock')
    expect(lock.record).toMatchObject({
      state: 'ready',
      control_host: '127.0.0.1',
      control_port: core.control.port,
      pid: process.pid,
      instance_id: core.instanceId,
    })

    const token = await readControlToken(data.layout)
    expect(token).toBe(core.controlToken)
    const client = new CoreClient({ baseUrl: core.control.url, token })
    expect(await client.health()).toMatchObject({ ok: true, instance_id: core.instanceId })
    expect(core.readyLine()).toMatchObject({
      event: 'core:ready',
      protocol: 1,
      version: CORE_VERSION,
      control_port: core.control.port,
    })
  })

  it('refuses a second owner for the same folder', async () => {
    await createCore()
    await expect(AtomicCore.create({ dataFolder: data.root, controlPort: 0 })).rejects.toMatchObject({
      code: 'CORE_ALREADY_RUNNING',
    })
  })

  it('creates the settings file and reads models from the shared folder', async () => {
    const core = await createCore()
    await data.writeModel('demo')
    await data.writeModel('embed', { embedding: true })
    expect((await core.registry().listChatModels()).map((m) => m.id)).toEqual(['demo'])
    expect(
      JSON.parse(await readFile(data.layout.core.settings, 'utf8')) as { version: number }
    ).toMatchObject({
      version: 1,
    })
  })

  it('rejects an unknown provider by name', async () => {
    const core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0, platform: 'linux' })
    cores.push(core)
    expect(() => core.runtime('mlx')).toThrow(/Unknown provider/)
    expect(() => core.registry('mlx')).toThrow(/Unknown provider/)
    expect(core.llamacpp('llamacpp')).toBe(core.runtime('llamacpp'))
    expect(() => core.runtime('ollama' as never)).toThrow(
      expect.objectContaining({ details: 'available: llamacpp-upstream, llamacpp' })
    )
  })

  it('offers MLX and Foundation Models on macOS only, and answers FM availability over control', async () => {
    const linux = await AtomicCore.create({ dataFolder: data.root, controlPort: 0, platform: 'linux' })
    expect(() => linux.runtime('foundation-models')).toThrow(/Unknown provider/)
    const call = (core: AtomicCore) =>
      fetch(`${core.control.url}/atomic/v1/runtimes/foundation-models/availability`, {
        headers: { authorization: `Bearer ${core.controlToken}` },
      }).then((r) => r.json())
    expect(await call(linux)).toEqual({ status: 'unavailable' })
    await linux.shutdown()

    const mac = await AtomicCore.create({
      dataFolder: data.root,
      controlPort: 0,
      platform: 'darwin',
      resourcesDir: join(data.root, 'no-resources'),
    })
    cores.push(mac)
    expect(mac.runtime('foundation-models')).toBeDefined()
    expect(mac.runtime('mlx')).toBeDefined()
    expect(mac.registry('mlx').modelsDir).toBe(join(data.root, 'mlx', 'models'))
    expect(() => mac.llamacpp('foundation-models' as never)).toThrow(/Unknown provider/)
    expect(await call(mac)).toEqual({ status: 'binaryNotFound' })
  })

  it('wires settings, context and public-server control routes to the facade', async () => {
    const core = await createCore()
    const call = (path: string, method = 'GET', body?: unknown) =>
      fetch(`${core.control.url}/atomic/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${core.controlToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })

    const settings = await call('/settings/llamacpp-upstream')
    expect(settings.status).toBe(200)
    expect(await settings.json()).toMatchObject({
      provider: 'llamacpp-upstream',
      migration: null,
    })

    const changed = new Promise<{ provider: string; key: string; value: unknown }>((resolve) =>
      core.events.once('settings:changed', resolve)
    )
    const patched = await call('/settings/llamacpp-upstream', 'PATCH', {
      values: { timeout: 601 },
    })
    expect(patched.status).toBe(200)
    expect(await changed).toEqual({
      provider: 'llamacpp-upstream',
      key: 'timeout',
      value: 601,
    })

    const eventSeqBeforeMigrationBookkeeping = core.events.lastSeq
    const imported = await call('/settings/llamacpp-upstream/import', 'POST', { values: {} })
    expect(imported.status).toBe(200)
    const importResult = (await imported.json()) as { revision: number }

    const acknowledged = await call('/settings/llamacpp-upstream/acknowledge', 'POST', {
      revision: importResult.revision,
    })
    expect(acknowledged.status).toBe(200)
    expect(core.events.lastSeq).toBe(eventSeqBeforeMigrationBookkeeping)

    const increased = await call('/models/llamacpp-upstream/not-loaded/ctx/increase', 'POST', {})
    expect(await increased.json()).toEqual({ ok: false, reason: 'not-loaded' })

    const stopped = await call('/server/stop', 'POST', {})
    expect(stopped.status).toBe(200)
    expect(await stopped.json()).toMatchObject({ running: false })
  })

  it('wires revisioned optimal state, snapshots and backend controls to the owner', async () => {
    const core = await createCore()
    const call = (path: string, method = 'GET', body?: unknown) =>
      fetch(`${core.control.url}/atomic/v1${path}`, {
        method,
        headers: { 'authorization': `Bearer ${core.controlToken}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    const record = {
      schemaVersion: 1,
      provider: 'llamacpp-upstream',
      detectedAt: 1,
      detectionKind: 'cpu-optimal',
      currentBackend: 'b1/macos-arm64',
      recommendedCategory: 'CPU',
    }
    const changed = new Promise((resolve) => core.events.once('backend:optimal-changed', resolve))
    const updated = await call('/backends/llamacpp-upstream/optimal', 'PUT', {
      optimal: record,
      expected_revision: 0,
    })
    expect(updated.status).toBe(200)
    expect(await changed).toMatchObject({ provider: 'llamacpp-upstream', revision: 1 })
    expect(await (await call('/backends/llamacpp-upstream/optimal')).json()).toEqual({
      revision: 1,
      optimal: record,
    })
    const snapshot = (await (await call('/snapshot')).json()) as {
      cursor: string
      optimal_backends: Record<string, unknown>
    }
    expect(snapshot.optimal_backends['llamacpp-upstream']).toEqual({ revision: 1, optimal: record })
    expect(snapshot.cursor).toBe(core.events.cursor())
    expect(await (await call('/backends/llamacpp-upstream')).json()).toEqual({ backends: [] })
    expect(await (await call('/backends/llamacpp-upstream/b1/macos-arm64', 'DELETE')).json()).toEqual({
      removed: false,
    })
    expect(await (await call('/downloads/absent/cancel', 'POST')).json()).toEqual({ cancelled: false })
    expect(await (await call('/hardware/devices')).json()).toEqual({ devices: [] })
    expect(await (await call('/models/llamacpp-upstream/absent/capabilities')).json()).toMatchObject({
      modelId: 'absent',
      mmprojExists: false,
    })
    expect(await (await call('/gguf/validate', 'POST', { path: '/missing.gguf' })).json()).toMatchObject({
      isValid: false,
    })
    const embedding = await call('/models/llamacpp-upstream/absent/embed', 'POST', {
      input: ['a'],
      ubatch_size: 64,
    })
    expect(embedding.status).not.toBe(200)
  })

  it('uses the live signed manifest in production backend installation', async () => {
    const seen: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      seen.push(url)
      if (url.endsWith('/backends/manifest.json'))
        return new Response(
          JSON.stringify({
            tag_name: 'b1',
            download_base: 'https://mirror.example/releases',
            assets: [{ name: 'llama-b1-bin-macos-arm64.tar.gz', sha256: 'a'.repeat(64), size: 12 }],
          }),
          { status: 200 }
        )
      return new Response('unavailable', { status: 404 })
    }) as typeof fetch
    const core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0, fetch: fetchImpl })
    cores.push(core)
    const res = await fetch(`${core.control.url}/atomic/v1/backends/llamacpp-upstream/install`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${core.controlToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'b1', backend: 'macos-arm64', task_id: 'task-1' }),
    })
    expect(res.status).not.toBe(200)
    expect(seen).toContain('https://mirror.example/releases/b1/llama-b1-bin-macos-arm64.tar.gz')
    expect(seen.filter((url) => url.endsWith('/backends/manifest.json'))).toHaveLength(1)
  })

  it('logs a failed manifest fetch and tries the unmirrored fallback', async () => {
    const seen: string[] = []
    const warnings: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      seen.push(String(input))
      return new Response('missing', { status: 404 })
    }) as typeof fetch
    const core = await AtomicCore.create({
      dataFolder: data.root,
      controlPort: 0,
      fetch: fetchImpl,
      logger: (level, message) => {
        if (level === 'warn') warnings.push(message)
      },
    })
    cores.push(core)
    const res = await fetch(`${core.control.url}/atomic/v1/backends/llamacpp-upstream/install`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${core.controlToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'b1', backend: 'macos-arm64', task_id: 'task-1' }),
    })
    expect(res.status).not.toBe(200)
    expect(seen).toContain(
      'https://github.com/ggml-org/llama.cpp/releases/download/b1/llama-b1-bin-macos-arm64.tar.gz'
    )
    expect(warnings.some((message) => message.includes('Backend manifest returned 404'))).toBe(true)
  })
})

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

      await putHardwareOverride(core, { gpus: [], cpu_extensions: [], os_type: 'windows' })
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

  it.skipIf(!CAN_INSTALL_FAKE_BACKEND)(
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
    const { isProcessAlive } = await import('./lock/index.js')
    const deadline = Date.now() + 5000
    while (isProcessAlive(session.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    expect(isProcessAlive(session.pid)).toBe(false)
  })
})

describe('cloud routing through the core', () => {
  it('routes a registered cloud model with the stored key, and still does after the core restarts', async () => {
    const { startStub, json } = await import('../test/helpers/chatgpt-stub.js')
    const upstream = await startStub((_req, res) => json(res, 200, { ok: true }))
    try {
      const first = await createCore()
      await first.cloud.upsert({
        provider: 'cloudprov',
        api_key: 'sk-stored',
        base_url: `${upstream.url}/v1`,
        custom_headers: [{ header: 'X-Org', value: 'org-1' }],
        models: ['cloud-model'],
      })
      await first.shutdown()
      cores.splice(cores.indexOf(first), 1)

      const core = await createCore()
      const { port } = await core.startPublicServer({ port: 0 })
      const answer = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'cloud-model', messages: [] }),
      })

      expect(answer.status).toBe(200)
      expect(upstream.requests[0]).toMatchObject({ path: '/v1/chat/completions' })
      expect(upstream.requests[0]?.headers).toMatchObject({
        'authorization': 'Bearer sk-stored',
        'x-org': 'org-1',
      })
      const listed = (await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()) as {
        data: Array<{ id: string }>
      }
      expect(listed.data.map((m) => m.id)).toEqual(['cloud-model'])
    } finally {
      await upstream.close()
    }
  })

  it('serves the ChatGPT subscription from the shared token file', async () => {
    const { startStub, responsesStream } = await import('../test/helpers/chatgpt-stub.js')
    const { saveTokens } = await import('./credentials/index.js')
    const subscription = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(responsesStream('subscribed'))
    })
    try {
      await saveTokens(data.layout.chatgptAuthFile, {
        version: 1,
        access_token: 'app-token',
        refresh_token: 'r',
        id_token: null,
        account_id: 'acct_app',
        plan_type: 'plus',
        email: 'app@example.test',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      })
      const core = await AtomicCore.create({
        dataFolder: data.root,
        controlPort: 0,
        env: { ...process.env, ATOMIC_CHATGPT_BASE_URL: subscription.url },
      })
      cores.push(core)
      expect(await core.chatgpt.status()).toMatchObject({ connected: true, email: 'app@example.test' })
      await core.cloud.upsert({ provider: 'chatgpt', models: ['gpt-5'] })
      const { port } = await core.startPublicServer({ port: 0 })

      const answer = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }),
      })

      expect(await answer.json()).toMatchObject({ choices: [{ message: { content: 'subscribed' } }] })
      expect(subscription.requests[0]?.headers).toMatchObject({
        'authorization': 'Bearer app-token',
        'chatgpt-account-id': 'acct_app',
      })
    } finally {
      await subscription.close()
    }
  })
})

describe('sessions the app still owns', () => {
  it('routes to a registered external session and asks its owner to grow the context', async () => {
    const { startStub, json } = await import('../test/helpers/chatgpt-stub.js')
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

describe('the public listener is independent', () => {
  it('starts, reports, stops and leaves control alive throughout', async () => {
    const core = await createCore()
    expect(core.publicState()).toMatchObject({ running: false, pid: null })

    const started = await core.startPublicServer({ port: 0 })
    expect(started).toMatchObject({ running: true, host: '127.0.0.1', prefix: '/v1', pid: process.pid })
    const probe = await fetch(`http://127.0.0.1:${started.port}/`)
    expect(probe.status).toBe(200)

    const stopped = await core.stopPublicServer()
    expect(stopped).toMatchObject({ running: false, pid: null, port: started.port })
    await expect(fetch(`http://127.0.0.1:${started.port}/`)).rejects.toThrow()

    const client = new CoreClient({ baseUrl: core.control.url, token: core.controlToken })
    expect(await client.health(), 'control must survive the public listener').toMatchObject({ ok: true })
  })

  it('falls back to a free port when asked, and treats a repeat of that request as the same server', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const taken = (blocker.address() as AddressInfo).port
    try {
      const core = await createCore()
      const first = await core.startPublicServer({ port: taken, fallbackPort: true })
      expect(first.port).not.toBe(taken)
      expect(await core.startPublicServer({ port: taken, fallbackPort: true })).toEqual(first)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('writes the app state file only when handed the server, and marks it stopped afterwards', async () => {
    const core = await createCore()
    const alone = await core.startPublicServer({ port: 0 })
    await expect(readFile(data.layout.serverStateFile, 'utf8')).rejects.toThrow()
    await core.stopPublicServer()

    const handed = await core.startPublicServer({ port: 0, apiKey: 'k', writeStateFile: true })
    expect(JSON.parse(await readFile(data.layout.serverStateFile, 'utf8'))).toEqual({
      running: true,
      host: '127.0.0.1',
      port: handed.port,
      prefix: '/v1',
      requires_api_key: true,
      pid: process.pid,
    })
    await expect(core.startPublicServer({ port: handed.port, apiKey: 'k' })).rejects.toMatchObject({
      code: 'CORE_ALREADY_RUNNING',
    })
    await core.stopPublicServer()
    expect(JSON.parse(await readFile(data.layout.serverStateFile, 'utf8'))).toMatchObject({
      running: false,
      port: handed.port,
      pid: 0,
    })
    expect(alone.port).toBeGreaterThan(0)
  })

  it('makes identical starts idempotent and rejects incompatible starts without dropping traffic', async () => {
    const core = await createCore()
    const first = await core.startPublicServer({ port: 0, prefix: '/v1' })
    const [sameA, sameB] = await Promise.all([
      core.startPublicServer({ port: 0, prefix: '/v1' }),
      core.startPublicServer({ port: first.port, prefix: '/v1/' }),
    ])
    expect(sameA.port).toBe(first.port)
    expect(sameB.port).toBe(first.port)

    await expect(core.startPublicServer({ port: first.port, apiKey: 'different' })).rejects.toMatchObject({
      code: 'CORE_ALREADY_RUNNING',
    })
    expect((await fetch(`http://127.0.0.1:${first.port}/`)).status).toBe(200)
    expect(core.publicState()).toMatchObject({ running: true, port: first.port, requires_api_key: false })
  })

  it("publishes its address in the core's own file, never the app's", async () => {
    const core = await createCore()
    const appState = {
      running: true,
      host: '127.0.0.1',
      port: 1337,
      prefix: '/v1',
      requires_api_key: false,
      pid: 999,
    }
    await writeFile(data.layout.serverStateFile, JSON.stringify(appState))

    const started = await core.startPublicServer({ port: 0 })
    const published = JSON.parse(await readFile(data.layout.core.publicServerState, 'utf8')) as {
      running: boolean
      port: number
      pid: number
    }
    expect(published).toMatchObject({ running: true, port: started.port, pid: process.pid })
    expect(
      JSON.parse(await readFile(data.layout.serverStateFile, 'utf8')),
      "the app's state file belongs to the legacy server until phase 4"
    ).toEqual(appState)

    await core.stopPublicServer()
    const afterStop = JSON.parse(await readFile(data.layout.core.publicServerState, 'utf8')) as {
      running: boolean
      pid: number | null
    }
    expect(afterStop).toMatchObject({ running: false, pid: null })
  })

  it('reports a bind failure as an event instead of silently running nowhere', async () => {
    const core = await createCore()
    const first = await core.startPublicServer({ port: 0 })
    await core.stopPublicServer()
    const squatter = await createOnPort(first.port)
    const failures: unknown[] = []
    core.events.on('server:bind-failed', (payload) => failures.push(payload))
    await expect(core.startPublicServer({ port: first.port })).rejects.toMatchObject({ code: 'IO_ERROR' })
    expect(failures).toMatchObject([{ port: first.port }])
    expect(core.publicState().running).toBe(false)
    await squatter.close()
  })
})

describe('recovering from a previous owner', () => {
  it('terminates a backend the dead owner left running and forgets the entry', async () => {
    const { spawn } = await import('node:child_process')
    const { processStartId } = await import('./lock/index.js')
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true })
    await new Promise((r) => setTimeout(r, 150))
    const journal = await ProcessJournal.open(data.layout)
    await journal.add({
      instance_id: 'a-dead-owner',
      pid: orphan.pid as number,
      process_start_id: (await processStartId(orphan.pid as number)) ?? null,
      exe: '/backends/llama-server',
      provider: 'llamacpp-upstream',
      model_id: 'left-behind',
      port: 3999,
      started_at: new Date().toISOString(),
    })

    const { isProcessAlive } = await import('./lock/index.js')
    const pid = orphan.pid as number
    await createCore()
    // The child may already be gone before we can subscribe to 'exit', so poll instead.
    const deadline = Date.now() + 5000
    while (isProcessAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    expect(isProcessAlive(pid)).toBe(false)
    expect((await ProcessJournal.open(data.layout)).list()).toEqual([])
  })
})

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

async function createOnPort(port: number): Promise<{ close: () => Promise<void> }> {
  const { createServer } = await import('node:http')
  const server = createServer((_req, res) => res.end('busy'))
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  return {
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.()
        server.close(() => r())
      }),
  }
}
