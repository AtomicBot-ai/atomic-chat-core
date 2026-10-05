import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { cores, createCore, data, useCoreHarness } from '../../test/helpers/core-harness.js'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { CAN_INSTALL_FAKE_BACKEND, installFakeBackend } from '../../test/helpers/fake-backend-pack.js'
import { writeFakeSidecarBinary } from '../../test/helpers/fake-sidecar-server.js'
import { CoreClient } from '../client/index.js'
import { AtomicCore, CORE_VERSION } from './index.js'
import type { BackendOutputSink } from './index.js'
import { inspectLock, readControlToken } from '../lock/index.js'
import type { ErrorReport } from '../telemetry/index.js'
import { ExecutionJournal } from '../runtime/container/index.js'
import { isProcessAlive } from '../runtime/index.js'

/**
 * The tests here build a whole core, several of them with real (fake-engine) child processes. Under the
 * full suite's parallel load some crossed vitest's 5 s default and failed at random (final review
 * T-282), so the whole file gets an explicit, longer per-test timeout.
 */
vi.setConfig({ testTimeout: 20_000 })

useCoreHarness()

describe('managed runtime containers at startup', () => {
  /** A `docker` that has never heard of any container, and logs what it was asked. */
  async function fakeDocker(): Promise<{ path: string; log: string }> {
    const path = join(data.root, 'fake-docker')
    const log = join(data.root, 'fake-docker.log')
    await writeFile(
      path,
      `#!/bin/sh\necho "$*" >> '${log}'\necho "Error: No such container: $5" >&2\nexit 1\n`
    )
    await chmod(path, 0o755)
    return { path, log }
  }
  const orphan = {
    container_id: 'orphan0123',
    engine_id: 'tensorrt-llm',
    image_digest: `sha256:${'d'.repeat(64)}`,
    scope: 'app',
    instance_id: 'previous-core',
    created_at: '2026-09-28T00:00:00.000Z',
  }

  it("reconciles a previous core's journalled containers on Linux before the endpoint is published", async () => {
    await (await ExecutionJournal.open(data.layout)).add(orphan)
    const docker = await fakeDocker()
    const core = await AtomicCore.create({
      dataFolder: data.root,
      controlPort: 0,
      platform: 'linux',
      dockerPath: docker.path,
    })
    cores.push(core)
    expect((await ExecutionJournal.open(data.layout)).list()).toEqual([])
    expect(await readFile(docker.log, 'utf8')).toContain('container inspect orphan0123')
  })

  it('leaves the journal alone off Linux, and on Linux without a docker CLI', async () => {
    await (await ExecutionJournal.open(data.layout)).add(orphan)
    const docker = await fakeDocker()
    const mac = await AtomicCore.create({
      dataFolder: data.root,
      controlPort: 0,
      platform: 'darwin',
      dockerPath: docker.path,
    })
    await mac.shutdown()
    const linux = await AtomicCore.create({
      dataFolder: data.root,
      controlPort: 0,
      platform: 'linux',
      dockerPath: null,
    })
    cores.push(linux)
    expect((await ExecutionJournal.open(data.layout)).list()).toEqual([orphan])
  })
})

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
      protocol: 2,
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
      expect.objectContaining({ details: 'available: llamacpp-upstream, llamacpp, tensorrt-llm' })
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

  it('offers tensorrt-llm on Linux only; elsewhere its routes answer PROVIDER_NOT_FOUND, not a transport error', async () => {
    const call = (core: AtomicCore, path: string, method = 'GET') =>
      fetch(`${core.control.url}/atomic/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${core.controlToken}` },
      }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }))

    const linux = await AtomicCore.create({
      dataFolder: data.root,
      controlPort: 0,
      platform: 'linux',
      dockerPath: null,
    })
    expect(linux.runtime('tensorrt-llm')).toBeDefined()
    // No docker CLI on this "Linux": the load is refused before anything else is asked of the machine.
    expect(await call(linux, '/models/tensorrt-llm/m/load', 'POST')).toMatchObject({
      body: { error: { code: 'MANAGED_ADAPTER_UNAVAILABLE' } },
    })
    expect(await call(linux, '/models/tensorrt-llm/m/capabilities')).toMatchObject({
      status: 200,
      body: { modelId: 'm', tools: false, embeddings: false },
    })
    expect(await call(linux, '/models/tensorrt-llm/m/logs')).toEqual({
      status: 200,
      body: { model_id: 'm', source: null, log_tail: '' },
    })
    expect(await call(linux, '/models/llamacpp-upstream/m/logs')).toMatchObject({
      status: 400,
      body: { error: { code: 'INVALID_ARGUMENT' } },
    })
    await linux.shutdown()

    const mac = await AtomicCore.create({
      dataFolder: data.root,
      controlPort: 0,
      platform: 'darwin',
      resourcesDir: join(data.root, 'no-resources'),
    })
    cores.push(mac)
    expect(() => mac.runtime('tensorrt-llm')).toThrow(/Unknown provider/)
    for (const [path, method] of [
      ['/models/tensorrt-llm/m/load', 'POST'],
      ['/models/tensorrt-llm/m/unload', 'POST'],
      ['/models/tensorrt-llm/m/load/cancel', 'POST'],
      ['/models/tensorrt-llm/m/capabilities', 'GET'],
      ['/models/tensorrt-llm/m/logs', 'GET'],
      ['/models/tensorrt-llm/m', 'DELETE'],
    ] as const) {
      expect(await call(mac, path, method)).toMatchObject({
        status: 404,
        body: { error: { code: 'PROVIDER_NOT_FOUND' } },
      })
    }
  })

  it("exposes the tensorrt-llm model registry through core.registry('tensorrt-llm') on Linux only, a fresh scan on every list() (task 2.16w round 1, finding 2), and deletes through core (task 2.24)", async () => {
    const linux = await AtomicCore.create({
      dataFolder: data.root,
      controlPort: 0,
      platform: 'linux',
      dockerPath: null,
    })

    const modelsDir = linux.layout.provider('tensorrt-llm').modelsDir
    // A directory with files but no model.yml is not shown at all (spec "Недокачанный каталог").
    await mkdir(join(modelsDir, 'downloading'), { recursive: true })
    await writeFile(join(modelsDir, 'downloading', 'model.safetensors'), 'partial')
    expect((await linux.registry('tensorrt-llm').list()).map((m) => m.id)).toEqual([])

    // The app finishes the download and writes model.yml last: the very next list() finds it, no restart.
    await writeFile(
      join(modelsDir, 'downloading', 'model.yml'),
      'repository: acme/model\nrevision: deadbeef\narchitectures:\n  - LlamaForCausalLM\nquantization: bf16\nfiles: []\n'
    )
    expect((await linux.registry('tensorrt-llm').list()).map((m) => m.id)).toEqual(['downloading'])

    // Deleted through core only (task 2.24): an id the registry does not list is an error, a listed
    // one that never loaded goes with its folder, and an unload of an unknown id is not a stop.
    const del = (id: string) =>
      fetch(`${linux.control.url}/atomic/v1/models/tensorrt-llm/${id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${linux.controlToken}` },
      }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }))
    expect(await del('missing')).toMatchObject({ status: 404, body: { error: { code: 'MODEL_NOT_FOUND' } } })
    expect(await linux.unload('tensorrt-llm', 'missing')).toEqual({ success: true, was_loaded: false })
    expect(await del('downloading')).toMatchObject({
      status: 200,
      body: { model_id: 'downloading', was_loaded: false, engine_caches_removed: 0 },
    })
    expect((await linux.registry('tensorrt-llm').list()).map((m) => m.id)).toEqual([])
    await linux.shutdown()

    const mac = await AtomicCore.create({
      dataFolder: data.root,
      controlPort: 0,
      platform: 'darwin',
      resourcesDir: join(data.root, 'no-resources'),
    })
    cores.push(mac)
    expect(() => mac.registry('tensorrt-llm')).toThrow(/Unknown provider/)
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

describe.skipIf(!CAN_INSTALL_FAKE_BACKEND)('engine output', () => {
  it('reaches backendOutput from llama.cpp, tagged with the provider and model', async () => {
    await data.writeModel('demo')
    await installFakeBackend(data.layout)
    const received: Array<{ provider: string; model: string; stream: string; line: string }> = []
    const backendOutput: BackendOutputSink = (line) => received.push(line)
    const core = await createCore({ backendOutput })
    await core.load('llamacpp-upstream', 'demo')

    expect(received.every((l) => l.provider === 'llamacpp-upstream' && l.model === 'demo')).toBe(true)
    expect(received).toContainEqual({
      provider: 'llamacpp-upstream',
      model: 'demo',
      stream: 'stderr',
      line: expect.stringMatching(/^build: /),
    })
  })

  it('reaches backendOutput from MLX and Foundation Models, tagged with the provider and model', async () => {
    const resources = join(data.root, 'resources')
    await writeFakeSidecarBinary(resources, 'mlx-server', { kind: 'mlx' })
    await writeFakeSidecarBinary(resources, 'foundation-models-server', { kind: 'fm' })
    const modelDir = join(data.root, 'mlx', 'models', 'qwen-mlx')
    await mkdir(modelDir, { recursive: true })
    await writeFile(join(modelDir, 'model.safetensors'), 'w')
    await writeFile(join(modelDir, 'config.json'), JSON.stringify({ max_position_embeddings: 32768 }))
    const received: Array<{ provider: string; model: string; stream: string; line: string }> = []
    const core = await createCore({
      platform: 'darwin',
      resourcesDir: resources,
      backendOutput: (line) => received.push(line),
    })
    await core.registry('mlx').write('qwen-mlx', {
      model_path: 'mlx/models/qwen-mlx/model.safetensors',
      name: 'qwen-mlx',
      size_bytes: 1,
    })

    await core.load('mlx', 'qwen-mlx')
    await core.load('foundation-models', 'apple/on-device')

    expect(received).toContainEqual({
      provider: 'mlx',
      model: 'qwen-mlx',
      stream: 'stderr',
      line: expect.stringContaining('Uvicorn running on'),
    })
    expect(received).toContainEqual({
      provider: 'foundation-models',
      model: 'apple/on-device',
      stream: 'stdout',
      line: expect.stringContaining('http server listening on'),
    })
  })

  it('without backendOutput, engine lines never reach the logger', async () => {
    await data.writeModel('demo')
    await installFakeBackend(data.layout)
    const logs: string[] = []
    const verbose: string[] = []
    const core = await createCore({ logger: (level, message) => logs.push(`${level}: ${message}`) })
    core.events.on('core:log', ({ msg }) => verbose.push(msg))
    await core.load('llamacpp-upstream', 'demo', { verbose: true })

    // The engine did print them, and `verbose` still relays them as events...
    expect(verbose.some((line) => line.includes('build:'))).toBe(true)
    // ...but the host's logger never sees one.
    expect(logs.some((line) => line.includes('listening on'))).toBe(false)
    expect(logs.some((line) => line.includes('build:'))).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('image generation through the owner', () => {
  it('wires the diffusion service to the control API, the journal, the events and the shutdown order', async () => {
    const { dataLayout } = await import('../config/index.js')
    const { writeFakeSdLaunchers, writeFakeSdModel } = await import('../../test/helpers/fake-sd-server.js')
    const { isProcessAlive } = await import('../runtime/shared/index.js')
    const layout = dataLayout(data.root)
    const logs: string[] = []
    const backendLines: Array<{ provider: string; model: string; stream: string; line: string }> = []
    const core = await AtomicCore.create({
      dataFolder: data.root,
      controlPort: 0,
      logger: (level, message) => logs.push(`${level}: ${message}`),
      backendOutput: (line) => backendLines.push(line),
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
    // ...but it does reach backendOutput, tagged with the engine and the loaded model.
    expect(backendLines.every((l) => l.provider === 'sd-cpp' && l.model === 'z-image:q4_k_m')).toBe(true)
    expect(backendLines).toContainEqual({
      provider: 'sd-cpp',
      model: 'z-image:q4_k_m',
      stream: 'stdout',
      line: expect.stringContaining('listening on 127.0.0.1:'),
    })

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

describe.skipIf(process.platform === 'win32')('video generation through the owner', () => {
  it('serves /v1/videos from the same session: queue, poll, download, list, delete', async () => {
    const { dataLayout } = await import('../config/index.js')
    const { writeFakeSdLaunchers, writeFakeSdModel } = await import('../../test/helpers/fake-sd-server.js')
    const { fileURLToPath } = await import('node:url')
    const layout = dataLayout(data.root)
    const core = await AtomicCore.create({
      dataFolder: data.root,
      controlPort: 0,
      diffusion: { timings: { pollIntervalMs: 30, cancelGraceMs: 300, cancelPollMs: 30 } },
      // The video estimate reads the owner's hardware facts: 32 GiB of RAM, sixteen cores.
      hardware: {
        probe: async () => ({
          info: {
            cpu: {
              name: 'Probe CPU',
              core_count: 16,
              arch: 'x86_64',
              extensions: [],
              extensions_known: true,
            },
            os_type: 'linux',
            os_name: 'Probe OS',
            total_memory: 32 * 1024,
            gpus: [],
          },
          warnings: [],
        }),
      },
    })
    cores.push(core)
    const client = new CoreClient({ baseUrl: core.control.url, token: core.controlToken })
    const events: string[] = []
    for (const name of [
      'diffusion:job',
      'diffusion:progress',
      'diffusion:video-job',
      'diffusion:video-progress',
    ] as const)
      core.events.on(name, () => events.push(name))
    await client.configureDiffusion({ dataFolder: data.root })
    const dir = join(layout.diffusion.backendsDir, 'master-883-137f740', 'fake-cpu')
    await writeFakeSdLaunchers(dir, { stepMs: 5, modes: ['img_gen', 'vid_gen'] })
    await client.finalizeDiffusionBackend({
      dir,
      tag: 'master-883-137f740',
      backendId: 'fake-cpu',
      backend: 'cpu',
      engine: 'sd-cpp',
    })
    const diffusionModel = await writeFakeSdModel(layout, 'ltx-2/ltx.gguf')
    await client.loadDiffusionModel({
      modelId: 'ltx-2:q4_k_m',
      family: 'ltx-2',
      modality: 'video',
      displayName: 'LTX-2.3 Distilled',
      files: { diffusionModel },
      defaults: {
        steps: 2,
        cfgScale: 1,
        width: 64,
        height: 32,
        video: { fps: 24, frames: 9, frameStep: 8, frameOffset: 1, resolutionPresets: [[64, 32]] },
      },
      ranges: { steps: [1, 50], dims: [16, 2048], dimMultiple: 16, frames: [9, 257] },
      offload: 'none',
    })
    expect((await client.diffusionVideoCapabilities()).webmSupported).toBe(true)
    const estimate = await client.estimateVideo({
      prompt: 'a cat',
      width: 64,
      height: 32,
      steps: 2,
      cfgScale: 1,
    })
    expect(estimate.memory).toMatchObject({
      pool: 'system',
      budgetBytes: 32 * 1024 * 1024 * 1024 - 2_288_490_189,
      verdict: 'fits',
    })
    expect(estimate.basis).toBe('heuristic')

    const served = await core.startPublicServer({ port: 0 })
    const base = `http://127.0.0.1:${served.port}/v1`
    const queued = await fetch(`${base}/videos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a cat', seconds: 0.5, size: '64x32', seed: 5 }),
    })
    expect(queued.status).toBe(200)
    const video = (await queued.json()) as { id: string; status: string; seconds: string }
    expect([video.status, video.seconds]).toEqual(['queued', '0.38'])
    const deadline = Date.now() + 10_000
    let polled: { status: string; atomic: { path: string | null; seed: number | null } }
    for (;;) {
      polled = (await (await fetch(`${base}/videos/${video.id}`)).json()) as typeof polled
      if (polled.status === 'completed' || polled.status === 'failed') break
      if (Date.now() > deadline) throw new Error('the clip did not complete')
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    expect(polled.status).toBe('completed')
    expect(polled.atomic.seed).toBe(5)
    expect(polled.atomic.path?.startsWith(join(data.root, 'videos'))).toBe(true)
    const content = await fetch(`${base}/videos/${video.id}/content`)
    expect(content.headers.get('content-type')).toBe('video/webm')
    const fixture = await readFile(
      fileURLToPath(new URL('../../test/fixtures/webm/tiny.webm', import.meta.url))
    )
    expect(Buffer.from(await content.arrayBuffer()).equals(fixture)).toBe(true)
    expect((await client.listVideoGallery({ offset: 0, limit: 10 })).total).toBe(1)
    const listed = (await (await fetch(`${base}/videos`)).json()) as { data: Array<{ id: string }> }
    expect(listed.data.map((v) => v.id)).toEqual([video.id])
    const models = (await (await fetch(`${base}/models`)).json()) as { data: Array<{ id: string }> }
    expect(models.data.map((m) => m.id)).not.toContain('ltx-2:q4_k_m')
    // The image facade refuses the video model, in the OpenAI envelope.
    const image = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a cat' }),
    })
    expect(image.status).toBe(500)
    expect(((await image.json()) as { error: { code: string } }).error.code).toBe('server_error')
    const deleted = await fetch(`${base}/videos/${video.id}`, { method: 'DELETE' })
    expect(await deleted.json()).toEqual({ id: video.id, object: 'video', deleted: true })
    expect((await client.listVideoGallery({ offset: 0, limit: 10 })).total).toBe(0)
    expect((await fetch(`${base}/videos/${video.id}/content`)).status).toBe(404)
    expect(events).toContain('diffusion:video-job')
    expect(events).toContain('diffusion:video-progress')
    expect(events).not.toContain('diffusion:job')
    expect(events).not.toContain('diffusion:progress')
    await core.shutdown()
  })
})

describe('the decision model through the owner', () => {
  const control = (core: AtomicCore, method: string, path: string, body?: unknown) =>
    fetch(`${core.control.url}/atomic/v1/decision/${path}`, {
      method,
      headers: { 'authorization': `Bearer ${core.controlToken}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

  it('runs it outside the sessions, journals it, serves it on /v1 and stops it with the core', async () => {
    const { fakeDecisionSpawn } = await import('../../test/helpers/fake-llama-server.js')
    const { isProcessAlive } = await import('../runtime/shared/index.js')
    await data.writeBackend('llamacpp', 'b10269-1.7.0', 'macos-arm64')
    await writeFile(join(data.root, 'router.gguf'), 'GGUF')
    const core = await createCore({ decision: { probe: async () => true, spawn: fakeDecisionSpawn() } })
    const events: string[] = []
    for (const name of ['decision:state', 'decision:error', 'settings:changed'] as const)
      core.events.on(name, () => events.push(name))
    expect(await (await control(core, 'GET', 'status')).json()).toMatchObject({ state: 'disabled' })

    const configured = await control(core, 'PUT', 'config', { enabled: true, model_path: 'router.gguf' })
    expect(await configured.json()).toMatchObject({ config: { enabled: true, model_path: 'router.gguf' } })
    const ready = (await (await control(core, 'POST', 'load')).json()) as { state: string; pid: number }
    expect(ready.state).toBe('ready')
    expect(events).toContain('settings:changed')
    expect(events).toContain('decision:state')
    expect(core.sessions()).toEqual([])
    const journal = JSON.parse(await readFile(data.layout.core.processes, 'utf8')) as {
      processes: Array<{ provider: string; pid: number }>
    }
    expect(journal.processes).toContainEqual(
      expect.objectContaining({ provider: 'decision', pid: ready.pid })
    )

    const candidates = [{ id: 'local/qwen', card: { name: 'Qwen', kind: 'local' } }]
    const scored = await control(core, 'POST', 'score', { task: 't', criterion: 'c', candidates })
    expect(await scored.json()).toMatchObject({
      unavailable: false,
      result: { scores: [{ id: 'local/qwen' }] },
    })
    const decided = await control(core, 'POST', 'decide', {
      state: 'Billed twice, refund please',
      questions: { refund: { type: 'noul', instructions: 'Asks for money back?' } },
      timeout_ms: 5_000,
    })
    expect(await decided.json()).toMatchObject({ unavailable: false, result: { answers: { refund: {} } } })
    // The optional request fields reach the model on both routes, with or without a timeout.
    const scoredWithOptions = await control(core, 'POST', 'score', {
      task: 't',
      criterion: 'c',
      candidates,
      timeout_ms: 5_000,
      truncation: 'allow',
    })
    expect(await scoredWithOptions.json()).toMatchObject({ unavailable: false })
    const decidedTruncated = await control(core, 'POST', 'decide', {
      state: 'Billed twice, refund please',
      questions: { refund: { type: 'noul', instructions: 'Asks for money back?' } },
      truncation: 'allow',
    })
    expect(await decidedTruncated.json()).toMatchObject({ unavailable: false })

    const served = await core.startPublicServer({ port: 0 })
    const base = `http://127.0.0.1:${served.port}/v1`
    const routed = await fetch(`${base}/router/score`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 't', criterion: 'c', candidates }),
    })
    expect(routed.status).toBe(200)
    const models = (await (await fetch(`${base}/models`)).json()) as { data: unknown[] }
    expect(models.data).toEqual([])

    await core.shutdown()
    expect(isProcessAlive(ready.pid)).toBe(false)
  })

  it('starts an enabled model when the owner comes up', async () => {
    const { fakeDecisionSpawn } = await import('../../test/helpers/fake-llama-server.js')
    await data.writeBackend('llamacpp', 'b10269-1.7.0', 'macos-arm64')
    await writeFile(join(data.root, 'router.gguf'), 'GGUF')
    await mkdir(data.layout.core.dir, { recursive: true })
    await writeFile(
      data.layout.core.settings,
      JSON.stringify({ version: 1, revision: 1, decision: { enabled: true, model_path: 'router.gguf' } })
    )
    const core = await createCore({ decision: { probe: async () => true, spawn: fakeDecisionSpawn() } })
    for (let i = 0; i < 200 && core.decision.getStatus().state !== 'ready'; i++)
      await new Promise((resolve) => setTimeout(resolve, 20))
    expect(core.decision.getStatus()).toMatchObject({ state: 'ready', enabled: true })
  })
})

describe('error reporting', () => {
  it('wires the reporter to the emitter, the engine events and the telemetry route', async () => {
    const captured: ErrorReport[] = []
    const telemetry = {
      capture: (report: ErrorReport) => captured.push(report),
      state: () => ({
        enabled: true,
        reporting: true,
        has_user: true,
        tags: { os: 'macOS' },
        source: 'host' as const,
        host: 'test',
      }),
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
      source: 'host',
      host: 'test',
    })
    expect((await client.health()).ok).toBe(true)
    expect(core.telemetry).toBe(telemetry)
  })

  it("builds its own reporter when the host brings none, as the host it names, or as 'library'", async () => {
    const library = await createCore()
    expect(library.telemetry?.state()).toEqual({
      enabled: true,
      reporting: false,
      has_user: false,
      tags: {},
      source: 'default',
      host: 'library',
    })
    await library.shutdown()
    const named = await AtomicCore.create({
      dataFolder: data.root,
      controlPort: 0,
      telemetry: { host: 'my-host', enabled: false },
    })
    cores.push(named)
    expect(named.telemetry?.state()).toMatchObject({ enabled: false, source: 'host', host: 'my-host' })
  })

  it('reports nothing when the host says telemetry: false, even when a listener throws', async () => {
    const core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0, telemetry: false })
    cores.push(core)
    expect(core.telemetry).toBeUndefined()
    core.events.on('server:stopped', () => {
      throw new TypeError('listener bug')
    })
    expect(() => core.events.emit('server:stopped', {})).not.toThrow()
  })
})

describe('hardware facts', () => {
  it('serves the probe over control and feeds its CPU flags to the load preflight', async () => {
    const probes: number[] = []
    const core = await createCore({
      hardware: {
        probe: async () => {
          probes.push(Date.now())
          return {
            info: {
              cpu: {
                name: 'Probe CPU',
                core_count: 2,
                arch: 'x86_64',
                extensions: ['fpu', 'sse2'],
                extensions_known: true,
              },
              os_type: 'windows',
              os_name: 'Probe OS',
              total_memory: 8192,
              gpus: [],
            },
            warnings: ['probe: canned'],
          }
        },
      },
    })
    const call = (path: string, method = 'GET') =>
      fetch(`${core.control.url}/atomic/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${core.controlToken}` },
      })
    const info = (await (await call('/hardware/info')).json()) as {
      info: { cpu: { name: string; extensions: string[] }; os_type: string }
      source: string
      warnings: string[]
    }
    expect(info).toMatchObject({
      info: { cpu: { name: 'Probe CPU', extensions: ['fpu', 'sse2'] }, os_type: 'windows' },
      source: 'probe',
      warnings: ['probe: canned'],
    })
    // The probe ran once at start-up; a refresh runs it again.
    expect(probes).toHaveLength(1)
    expect(((await (await call('/hardware/refresh', 'POST')).json()) as { source: string }).source).toBe(
      'probe'
    )
    expect(probes).toHaveLength(2)
  })

  it.skipIf(process.platform === 'win32')(
    'lets the advisor verify a GPU tier with the installed pack’s own --list-devices',
    async () => {
      const manifest = {
        tag_name: 'b7000',
        assets: ['win-cpu-x64', 'win-cuda-13.3-x64', 'win-vulkan-x64'].map((id) => ({
          name: `llama-b7000-bin-${id}.zip`,
        })),
      }
      const fakeFetch: typeof fetch = async (input) =>
        String(input instanceof Request ? input.url : input).endsWith('/backends/manifest.json')
          ? new Response(JSON.stringify(manifest), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : new Response('not here', { status: 404 })
      const core = await createCore({
        fetch: fakeFetch,
        hardware: {
          probe: async () => ({
            info: {
              cpu: {
                name: 'Probe CPU',
                core_count: 16,
                arch: 'x86_64',
                extensions: ['avx2'],
                extensions_known: true,
              },
              os_type: 'windows',
              os_name: 'Probe OS',
              total_memory: 65_536,
              gpus: [
                {
                  name: 'NVIDIA GeForce RTX 4090',
                  vendor: 'NVIDIA',
                  total_memory: 24_564,
                  uuid: 'gpu-0',
                  driver_version: '581.42',
                  nvidia_info: { index: 0, compute_capability: '8.9' },
                  vulkan_info: {
                    index: 0,
                    device_type: 'DiscreteGpu',
                    api_version: '1.3.290',
                    device_id: 0x2684,
                  },
                },
              ],
            },
            warnings: [],
          }),
        },
      })
      // The installed CUDA pack answers `--list-devices` the way llama-server does.
      await data.writeBackend(
        'llamacpp-upstream',
        'b7000',
        'win-cuda-13.3-x64',
        '#!/bin/sh\necho "Available devices:"\necho "  CUDA0: NVIDIA GeForce RTX 4090 (24564 MiB, 24000 MiB free)"\n'
      )
      const better = new Promise((resolve) => core.events.once('backend:better-detected', resolve))
      const client = new CoreClient({ baseUrl: core.control.url, token: core.controlToken })

      const verdict = await client.recommendBackend('llamacpp-upstream', {
        mode: 'recheck',
        current_backend: 'b7000/win-cpu-x64',
      })

      expect(verdict.outcome).toBe('recommend')
      expect(verdict.detection).toEqual({ kind: 'gpu', backend: 'win-cuda-13.3-x64' })
      expect(verdict.recommendation?.recommendedBackend).toBe('b7000/win-cuda-13.3-x64')
      expect(verdict.revision).toBe(1)
      await expect(better).resolves.toMatchObject({
        provider: 'llamacpp-upstream',
        backendId: 'win-cuda-13.3-x64',
      })
      expect((await client.backendCatalog('llamacpp-upstream')).recommended_installed).toBe(
        'b7000/win-cuda-13.3-x64'
      )
    }
  )

  it.skipIf(process.arch !== 'x64' || process.platform === 'win32')(
    'blocks a CPU backend load on a probed CPU without AVX, and lets an override lift the block',
    async () => {
      const { installFakeBackend } = await import('../../test/helpers/fake-backend-pack.js')
      const { putHardwareOverride } = await import('../../test/helpers/core-harness.js')
      const core = await createCore({
        hardware: {
          probe: async () => ({
            info: {
              cpu: {
                name: 'Intel Core2 Quad Q9550',
                core_count: 4,
                arch: 'x86_64',
                extensions: ['fpu', 'sse2', 'sse4_1'],
                extensions_known: true,
              },
              os_type: 'windows',
              os_name: 'Probe OS',
              total_memory: 8192,
              gpus: [],
            },
            warnings: [],
          }),
        },
      })
      await data.writeModel('cpu-model')
      await installFakeBackend(data.layout, { version: 'b7000', backend: 'win-cpu-x64' })
      await core.settings.update('llamacpp-upstream', { version_backend: 'b7000/win-cpu-x64' })

      await expect(core.load('llamacpp-upstream', 'cpu-model')).rejects.toMatchObject({ code: 'CPU_NO_AVX' })

      await putHardwareOverride(core, { gpus: [], cpu_extensions: ['avx2'], os_type: 'windows' })
      await expect(core.load('llamacpp-upstream', 'cpu-model')).resolves.toMatchObject({
        model_id: 'cpu-model',
      })
    }
  )
})

describe('GPU residency', () => {
  it.skipIf(process.platform === 'win32')(
    'loading on one llama.cpp provider stops the other’s GPU session through the facade, claim and all, and leaves the voice model',
    async () => {
      const { installFakeBackend } = await import('../../test/helpers/fake-backend-pack.js')
      const core = await createCore()
      for (const id of ['a', 'b', 'ggml-org/Voxtral-Mini-3B-2507-Q4_K_M']) await data.writeModel(id)
      for (const [provider, version] of [
        ['llamacpp-upstream', 'b6325'],
        ['llamacpp', 'b10018-1.3.0'],
      ] as const) {
        const pack = await installFakeBackend(data.layout, { provider, version, backend: 'linux-vulkan-x64' })
        await core.settings.update(provider, { version_backend: pack.versionBackend, fit: false })
      }
      const claims = () => readdir(data.layout.core.modelClaims).catch(() => [] as string[])

      const voice = await core.load('llamacpp-upstream', 'ggml-org/Voxtral-Mini-3B-2507-Q4_K_M', {
        bypassAutoUnload: true,
      })
      const a = await core.load('llamacpp-upstream', 'a')
      const heldBefore = await claims()
      await core.load('llamacpp', 'b')

      expect(core.runtime('llamacpp-upstream').getLoadedModels()).toEqual([
        'ggml-org/Voxtral-Mini-3B-2507-Q4_K_M',
      ])
      expect(core.runtime('llamacpp').getLoadedModels()).toEqual(['b'])
      expect(isProcessAlive(voice.pid as number)).toBe(true)
      expect(isProcessAlive(a.pid as number)).toBe(false)
      // a's cross-process claim went with its confirmed stop; the voice model's is still held, and b's is new.
      expect(heldBefore).toHaveLength(2)
      const heldAfter = await claims()
      expect(heldAfter).toHaveLength(2)
      expect(heldAfter.filter((claim) => heldBefore.includes(claim))).toHaveLength(1)
    }
  )
})

describe('GPU residency: racing loads and other owners', () => {
  const gpuPacks = async (layout: typeof data.layout, core: AtomicCore) => {
    const { installFakeBackend } = await import('../../test/helpers/fake-backend-pack.js')
    for (const [provider, version] of [
      ['llamacpp-upstream', 'b6325'],
      ['llamacpp', 'b10018-1.3.0'],
    ] as const) {
      const pack = await installFakeBackend(layout, { provider, version, backend: 'linux-vulkan-x64' })
      await core.settings.update(provider, { version_backend: pack.versionBackend, fit: false })
    }
  }

  it.skipIf(process.platform === 'win32')(
    'two GPU loads on two engines at once: the later claim stops the earlier load, and one model ends up resident',
    async () => {
      const core = await createCore()
      for (const id of ['a', 'b']) await data.writeModel(id)
      await gpuPacks(data.layout, core)
      const outcomes = await Promise.allSettled([
        core.load('llamacpp-upstream', 'a'),
        core.load('llamacpp', 'b'),
      ])
      const loaded = [
        ...core.runtime('llamacpp-upstream').getLoadedModels(),
        ...core.runtime('llamacpp').getLoadedModels(),
      ]
      expect(loaded).toHaveLength(1)
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
      const [refused] = outcomes.filter((o) => o.status === 'rejected')
      expect((refused as PromiseRejectedResult).reason).toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'never stops what another core scope runs, nor a session another process registered here',
    async () => {
      // The CLI core, in its own data folder, holds a model on the card.
      const cliData = await makeTmpDataFolder('atomic-core-cli-scope-')
      try {
        const cli = await createCore({ dataFolder: cliData.root, ownerScope: 'cli' })
        await cliData.writeModel('cli-model')
        await gpuPacks(cliData.layout, cli)
        const held = await cli.load('llamacpp-upstream', 'cli-model')

        // The app core: the app also registered that session with it as external.
        const app = await createCore({ ownerScope: 'app' })
        await data.writeModel('app-model')
        await gpuPacks(data.layout, app)
        app.externalSessions.publish('cli', 1, [
          { provider: 'llamacpp-upstream', model_id: 'cli-model', port: held.port, api_key: held.api_key },
        ])
        await app.load('llamacpp-upstream', 'app-model')

        expect(isProcessAlive(held.pid as number)).toBe(true)
        expect(cli.runtime('llamacpp-upstream').getLoadedModels()).toEqual(['cli-model'])
        expect(app.externalSessions.list().map((s) => s.model_id)).toEqual(['cli-model'])
        expect(app.runtime('llamacpp-upstream').getLoadedModels()).toEqual(['app-model'])
      } finally {
        await Promise.all(cores.splice(0).map((c) => c.shutdown()))
        await cliData.cleanup()
      }
    }
  )
})

describe('managed runtime environment', () => {
  it('wires the environment routes, the snapshot and the event stream to one core', async () => {
    // A throwaway shared root, so this never touches the real per-user environment on the host
    // running the test — the same isolation the e2e suite gives every daemon it starts.
    const managedRoot = await mkdtemp(join(tmpdir(), 'atomic-core-managed-unit-'))
    try {
      // No descriptor anywhere, whatever the developer's own environment says: the outcome must not
      // depend on the machine (it did — CI on Linux and Windows reached the descriptor, macOS did not).
      const core = await createCore({
        env: {
          ...process.env,
          ATOMIC_CORE_MANAGED_ROOT: managedRoot,
          ATOMIC_RUNTIME_DESCRIPTOR_URL: pathToFileURL(join(managedRoot, 'no-descriptor.json')).href,
        },
      })
      const call = (path: string, init: RequestInit = {}) =>
        fetch(`${core.control.url}/atomic/v1${path}`, {
          ...init,
          headers: { authorization: `Bearer ${core.controlToken}`, ...init.headers },
        })

      const listed = (await (await call('/environments')).json()) as {
        environments: Array<{ environment_id: string; executor: string; availability: string }>
      }
      const snapshot = (await (await call('/snapshot')).json()) as {
        environments: unknown[]
        environment_operations: unknown[]
      }
      // The control snapshot and the dedicated route describe the same in-memory view.
      expect(snapshot.environments).toEqual(listed.environments)
      expect(snapshot.environment_operations).toEqual([])

      const started = await call('/environments/default/operations', {
        method: 'POST',
        body: JSON.stringify({
          request_id: 'req-1',
          target: { kind: 'environment' },
          kind: 'setup',
          descriptor_id: 'trtllm-1.3.0rc27',
        }),
      })
      // No host recipe is qualified on this platform yet: the request is still recorded and
      // dispatched (202), it just runs straight into a blocker.
      expect(started.status).toBe(202)
      const operation = (await started.json()) as { operation_id: string }

      const deadline = Date.now() + 5_000
      let current: { phase: string; error: { code: string } | null } = { phase: 'checking', error: null }
      while (current.phase !== 'failed' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        current = (await (
          await call(`/environments/operations/${operation.operation_id}`)
        ).json()) as typeof current
      }
      expect(current.phase).toBe('failed')
      // Where setup is real (Linux, Windows) the plan needs the descriptor, which nobody has: metadata.
      // Elsewhere (macOS) the host itself is the blocker, before any descriptor is asked for.
      expect(current.error?.code).toBe(
        process.platform === 'linux' || process.platform === 'win32'
          ? 'MANAGED_METADATA_INVALID'
          : 'MANAGED_PREREQUISITE_BLOCKED'
      )

      // A retried request with the same id gets the operation it already started, not a new one —
      // exercising the id generator's idempotency path a second time changes nothing.
      const again = await call('/environments/default/operations', {
        method: 'POST',
        body: JSON.stringify({
          request_id: 'req-1',
          target: { kind: 'environment' },
          kind: 'setup',
          descriptor_id: 'trtllm-1.3.0rc27',
        }),
      })
      expect(((await again.json()) as { operation_id: string }).operation_id).toBe(operation.operation_id)
    } finally {
      await rm(managedRoot, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})
