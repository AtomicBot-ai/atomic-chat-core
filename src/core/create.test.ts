import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { cores, createCore, data, useCoreHarness } from '../../test/helpers/core-harness.js'
import { CoreClient } from '../client/index.js'
import { AtomicCore, CORE_VERSION } from './index.js'
import { inspectLock, readControlToken } from '../lock/index.js'

useCoreHarness()

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
