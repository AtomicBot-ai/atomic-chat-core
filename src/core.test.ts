import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CAN_INSTALL_FAKE_BACKEND, installFakeBackend } from '../test/helpers/fake-backend-pack.js'
import { makeTmpDataFolder } from '../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../test/helpers/tmp-data-folder.js'
import { CoreClient } from './client/index.js'
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

describe('taking ownership', () => {
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
    const core = await createCore()
    expect(() => core.runtime('mlx')).toThrow(/Unknown provider/)
    expect(() => core.registry('mlx')).toThrow(/Unknown provider/)
  })
})

describe.skipIf(!CAN_INSTALL_FAKE_BACKEND)('serving a model end to end', () => {
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
