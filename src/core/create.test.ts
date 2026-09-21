import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { cores, createCore, data, useCoreHarness } from '../../test/helpers/core-harness.js'
import { CoreClient } from '../client/index.js'
import { AtomicCore, CORE_VERSION } from './index.js'
import { inspectLock, readControlToken } from '../lock/index.js'
import type { ErrorReport } from '../telemetry/index.js'

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

  it("consumes the tunnel journal the app's 2.0.40 left at the root, sparing what is not a tunnel", async () => {
    // A live process with the recorded start time, as under a reused pid: only the name gives it away.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      await new Promise((resolve) => child.once('spawn', resolve))
      const pid = child.pid as number
      const startedAt = Math.floor(Date.now() / 1000)
      await writeFile(
        data.layout.legacyRemoteAccessTunnel,
        JSON.stringify({ pid, started_at_secs: startedAt })
      )
      const warnings: string[] = []
      const core = await AtomicCore.create({
        dataFolder: data.root,
        controlPort: 0,
        logger: (level, message) => void (level === 'warn' && warnings.push(message)),
      })
      cores.push(core)
      expect(warnings.filter((m) => m.startsWith(`pid ${pid} is no longer our tunnel`))).toHaveLength(1)
      expect(child.exitCode).toBeNull()
      expect(child.signalCode).toBeNull()
      await expect(readFile(data.layout.legacyRemoteAccessTunnel)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      child.kill('SIGKILL')
    }
  }, 20_000)

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

  it('wires free disk space to its own data folder and the LAN addresses to this machine', async () => {
    const core = await createCore()
    const client = new CoreClient({ baseUrl: core.control.url, token: core.controlToken })

    expect(await client.availableDiskSpace()).toBeGreaterThan(0)
    expect(await client.availableDiskSpace(join(data.root, 'diffusion', 'models'))).toBeGreaterThan(0)
    // The data folder is the owner's own: another folder is refused, however real it is.
    await expect(client.availableDiskSpace(join(data.root, '..'))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })

    const addresses = await client.lanAddresses()
    expect(Array.isArray(addresses)).toBe(true)
    for (const address of addresses) expect(address).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/)
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

describe.skipIf(process.platform === 'win32')('image generation through the owner', () => {
  it('wires the diffusion service to the control API, the journal, the events and the shutdown order', async () => {
    const { dataLayout } = await import('../config/index.js')
    const { writeFakeSdLaunchers, writeFakeSdModel } = await import('../../test/helpers/fake-sd-server.js')
    const { isProcessAlive } = await import('../runtime/shared/index.js')
    const layout = dataLayout(data.root)
    const logs: string[] = []
    const core = await AtomicCore.create({
      dataFolder: data.root,
      controlPort: 0,
      logger: (level, message) => logs.push(`${level}: ${message}`),
      diffusion: { timings: { pollIntervalMs: 30, cancelGraceMs: 300, cancelPollMs: 30 } },
    })
    cores.push(core)
    const client = new CoreClient({ baseUrl: core.control.url, token: core.controlToken })
    const events: string[] = []
    for (const name of ['diffusion:state', 'diffusion:job', 'diffusion:progress', 'diffusion:error'] as const)
      core.events.on(name, () => events.push(name))

    // The data folder must be the owner's own.
    await expect(client.configureDiffusion({ dataFolder: join(data.root, '..') })).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    })
    expect((await client.configureDiffusion({ dataFolder: data.root })).configured).toBe(true)

    const dir = join(layout.diffusion.backendsDir, 'master-849-d04e895', 'fake-cpu')
    await writeFakeSdLaunchers(dir, { stepMs: 5 })
    const record = await client.finalizeDiffusionBackend({
      dir,
      tag: 'master-849-d04e895',
      backendId: 'fake-cpu',
      backend: 'cpu',
      engine: 'sd-cpp',
    })
    expect(record.dir).toBe(dir)
    expect(logs.some((line) => line.startsWith('info: engine probe passed'))).toBe(true)

    const diffusionModel = await writeFakeSdModel(layout)
    const loaded = await client.loadDiffusionModel({
      modelId: 'z-image:q4_k_m',
      family: 'z-image',
      modality: 'image',
      displayName: 'Z-Image Turbo',
      files: { diffusionModel },
      defaults: { steps: 2, cfgScale: 1, width: 512, height: 512 },
      ranges: { steps: [1, 50], dims: [16, 2048], dimMultiple: 16 },
      offload: 'none',
    })
    expect(isProcessAlive(loaded.pid)).toBe(true)
    // Journalled under its own provider, and not a chat session.
    const journal = JSON.parse(await readFile(layout.core.processes, 'utf8')) as {
      processes: Array<{ pid: number; provider: string; model_id: string }>
    }
    expect(journal.processes).toEqual([
      expect.objectContaining({ pid: loaded.pid, provider: 'diffusion', model_id: 'z-image:q4_k_m' }),
    ])
    expect(core.sessions()).toEqual([])
    // The server's own output is not the core's log.
    expect(logs.some((line) => line.includes('[sd-server'))).toBe(false)

    const { jobId } = await client.generateImage({
      prompt: 'a cat',
      width: 32,
      height: 32,
      steps: 2,
      cfgScale: 1,
      batchSize: 1,
    })
    const deadline = Date.now() + 10_000
    while ((await client.diffusionJob(jobId))?.state !== 'completed') {
      if (Date.now() > deadline) throw new Error('the job did not complete')
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    const page = await client.listGallery({ offset: 0, limit: 10 })
    expect(page.total).toBe(1)

    // The OpenAI facade on the public listener runs the same jobs, and the image model is not a chat model.
    const served = await core.startPublicServer({ port: 0 })
    const base = `http://127.0.0.1:${served.port}/v1`
    const generated = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a cat', size: '256x256', n: 1, seed: 5 }),
    })
    expect(generated.status).toBe(200)
    const answer = (await generated.json()) as {
      data: Array<{ b64_json: string }>
      atomic: { seed: number; paths: string[] }
    }
    expect(Buffer.from(answer.data[0]?.b64_json ?? '', 'base64').subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    )
    expect(answer.atomic.seed).toBe(5)
    expect((await client.listGallery({ offset: 0, limit: 10 })).total).toBe(2)
    const models = (await (await fetch(`${base}/models`)).json()) as { data: Array<{ id: string }> }
    expect(models.data.map((m) => m.id)).not.toContain('z-image:q4_k_m')
    // A client that leaves cancels its job.
    const controller = new AbortController()
    const abandoned = fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a cat', size: '256x256', n: 4 }),
      signal: controller.signal,
    })
    while ((await client.diffusionStatus()).activeJob === null)
      await new Promise((resolve) => setTimeout(resolve, 10))
    const activeId = (await client.diffusionStatus()).activeJob?.id as string
    controller.abort()
    await expect(abandoned).rejects.toThrow()
    const cancelDeadline = Date.now() + 10_000
    while ((await client.diffusionJob(activeId))?.state !== 'cancelled') {
      if (Date.now() > cancelDeadline) throw new Error('the abandoned job was not cancelled')
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    expect(page.items[0]?.path.startsWith(join(data.root, 'images'))).toBe(true)
    expect(events).toContain('diffusion:state')
    expect(events).toContain('diffusion:job')
    expect(events).toContain('diffusion:progress')
    expect(events).not.toContain('diffusion:error')

    // A failed engine probe is logged as a warning through the owner's logger.
    const bad = join(layout.diffusion.backendsDir, 'master-849-d04e895', 'bad')
    await writeFakeSdLaunchers(bad)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(bad, 'sd-cli'), "#!/bin/sh\necho 'llama-server usage'\n")
    await expect(
      client.finalizeDiffusionBackend({
        dir: bad,
        tag: 'master-849-d04e895',
        backendId: 'bad',
        backend: 'cpu',
        engine: 'sd-cpp',
      })
    ).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED' })
    expect(logs.some((line) => line.startsWith('warn: engine probe failed'))).toBe(true)

    await core.shutdown()
    expect(isProcessAlive(loaded.pid)).toBe(false)
  })
})

describe('error reporting', () => {
  it('wires the reporter to the emitter, the engine events and the telemetry route', async () => {
    const captured: ErrorReport[] = []
    const telemetry = {
      capture: (report: ErrorReport) => captured.push(report),
      state: () => ({ enabled: true, reporting: true, has_user: true, tags: { os: 'macOS' } }),
      update: () => {},
    }
    const core = await AtomicCore.create({
      dataFolder: data.root,
      controlPort: 0,
      errorReporter: telemetry,
      platform: 'linux',
    })
    cores.push(core)
    core.events.on('server:stopped', () => {
      throw new TypeError('listener bug')
    })
    core.events.emit('server:stopped', {})
    core.events.emit('session:died', {
      provider: 'llamacpp-upstream',
      pid: 1,
      model_id: 'm',
      exit_code: null,
      signal: 'SIGSEGV',
      message: 'crashed',
    })
    expect(captured.map((r) => [r.source, r.tags?.['event'] ?? r.fingerprint?.[2]])).toEqual([
      ['event_listener', 'server:stopped'],
      ['backend_crash', 'sigsegv'],
    ])
    const client = new CoreClient({ baseUrl: core.control.url, token: core.controlToken })
    const state = await fetch(`${core.control.url}/atomic/v1/telemetry`, {
      headers: { authorization: `Bearer ${core.controlToken}` },
    })
    expect(await state.json()).toEqual({
      enabled: true,
      reporting: true,
      has_user: true,
      tags: { os: 'macOS' },
    })
    expect((await client.health()).ok).toBe(true)
  })

  it('reports nothing without a reporter, even when a listener throws', async () => {
    const core = await createCore()
    core.events.on('server:stopped', () => {
      throw new TypeError('listener bug')
    })
    expect(() => core.events.emit('server:stopped', {})).not.toThrow()
  })
})
