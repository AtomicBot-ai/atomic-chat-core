import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dataLayout } from '../config/index.js'
import type { AudioJob, CoreEvents, LoadAudioModelRequest } from '../contracts/index.js'
import type { GpuClaim } from '../runtime/shared/index.js'
import { isProcessAlive } from '../runtime/shared/index.js'
import { installFakeAudioEngine, writeFakeAudioModel } from '../../test/helpers/fake-audiocpp-server.js'
import {
  fakeHandle,
  hangUntilAborted,
  sampleCapabilities,
  scriptedHttp,
} from '../../test/helpers/audio-fixtures.js'
import type { FakeHandle } from '../../test/helpers/audio-fixtures.js'
import { audioError } from './errors.js'
import { writeAudioInstallRecord } from './install.js'
import { AudioService } from './service.js'
import type { AudioServiceDeps } from './service.js'
import type { AudioServerSpec } from './types.js'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const SERVER = process.platform === 'win32' ? 'audiocpp_server.exe' : 'audiocpp_server'

async function installBuild(root: string, tag: string, backend: 'metal' | 'cpu', installedAtMs: number) {
  const dir = join(root, tag, `macos-${backend}`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, SERVER), '')
  await writeAudioInstallRecord(dir, {
    tag,
    backendId: `macos-${backend}`,
    backend,
    engine: 'audio-cpp',
    sha256: null,
    installedAtMs,
    dir,
  })
  return dir
}

const speechLoad = (over: Partial<LoadAudioModelRequest> = {}): LoadAudioModelRequest => ({
  modelId: 'kokoro-82m:q8_0',
  displayName: 'Kokoro 82M',
  mode: 'speech',
  file: 'kokoro/kokoro-82m-q8_0.gguf',
  family: 'kokoro_tts',
  task: 'tts',
  ...over,
})

/** A job past its queue, on a loaded machine too: a fixed pause was too short on Windows runners. */
const generating = (w: { service: AudioService }, id: string) =>
  vi.waitFor(() => expect(w.service.getJob(id)?.progress?.phase).toBe('generating'))

async function world(over: Partial<AudioServiceDeps> = {}, options: { install?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'atomic-core-audio-service-'))
  dirs.push(dir)
  const layout = dataLayout(dir)
  await mkdir(join(layout.audio.modelsDir, 'kokoro'), { recursive: true })
  await writeFile(join(layout.audio.modelsDir, 'kokoro', 'kokoro-82m-q8_0.gguf'), 'GGUF')
  const build =
    options.install === false
      ? undefined
      : await installBuild(layout.audio.backendsDir, 'v0.9.3-a1b2c3d4', 'metal', 1)
  const events: Array<{ name: string; payload: Record<string, unknown> }> = []
  const handles: FakeHandle[] = []
  const specs: AudioServerSpec[] = []
  const http = scriptedHttp()
  const service = new AudioService({
    paths: layout.audio,
    emit: <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) =>
      void events.push({ name, payload: payload as unknown as Record<string, unknown> }),
    log: () => {},
    env: {},
    http,
    sleep: async () => {},
    drawSeed: () => 7,
    timings: { exitWaitMs: 10 },
    spawn: async (spec) => {
      specs.push(spec)
      const handle = fakeHandle(spec)
      handle.capabilities = sampleCapabilities(spec)
      handles.push(handle)
      return handle
    },
    ...over,
  })
  const reasons = () => events.filter((e) => e.name === 'audio:state').map((e) => String(e.payload['reason']))
  return { dir, layout, build, service, events, handles, specs, http, reasons }
}

describe('loadModel', () => {
  it('runs the newest build with the model file resolved, and replaces a resident model', async () => {
    const w = await world()
    const newer = await installBuild(w.layout.audio.backendsDir, 'v0.9.4-a1b2c3d4', 'cpu', 2)
    const loaded = await w.service.loadModel(
      speechLoad({ defaultVoice: 'af_heart', threads: 4, startupTimeoutSecs: 30, loadOptions: { a: 1 } })
    )
    expect(loaded).toMatchObject({ modelId: 'kokoro-82m:q8_0', backend: 'cpu', tag: 'v0.9.4-a1b2c3d4' })
    expect(w.specs[0]).toEqual({
      binaryDir: newer,
      backend: 'cpu',
      buildBackend: 'cpu',
      backendId: 'macos-cpu',
      tag: 'v0.9.4-a1b2c3d4',
      modelId: 'kokoro-82m:q8_0',
      displayName: 'Kokoro 82M',
      mode: 'speech',
      family: 'kokoro_tts',
      task: 'tts',
      modelPath: join(w.layout.audio.modelsDir, 'kokoro', 'kokoro-82m-q8_0.gguf'),
      loadOptions: { a: 1 },
      defaultVoice: 'af_heart',
      threads: 4,
      startupTimeoutMs: 30_000,
    })
    await w.service.loadModel(speechLoad({ modelId: 'second' }))
    expect(w.handles[0]?.terminated).toBe(1)
    expect(w.specs[1]?.startupTimeoutMs).toBe(600_000)
    expect((await w.service.status()).model.loaded?.modelId).toBe('second')
  })

  it('forces the CPU backend when the environment says so', async () => {
    const w = await world({ env: { ATOMIC_AUDIO_BACKEND: 'cpu' } })
    await w.service.loadModel(speechLoad())
    expect(w.specs[0]).toMatchObject({ backend: 'cpu', buildBackend: 'metal' })
  })

  it.each([
    ['no build installed', { install: false }, speechLoad(), 'ENGINE_MISSING'],
    ['a missing file', {}, speechLoad({ file: 'kokoro/other.gguf' }), 'MODEL_MISSING'],
    ['a file outside the folder', {}, speechLoad({ file: '../escape.gguf' }), 'INVALID_REQUEST'],
    ['a speech model served as gen', {}, speechLoad({ task: 'gen' }), 'INVALID_REQUEST'],
  ])('refuses %s, and says the model failed', async (_name, options, request, code) => {
    const w = await world({}, options)
    await expect(w.service.loadModel(request)).rejects.toMatchObject({ code })
    const status = await w.service.status()
    expect(status.model).toMatchObject({ state: 'failed', error: { code } })
    expect(w.reasons()).toEqual(['load-blocked'])
    expect(w.events.at(-1)?.name).toBe('audio:error')
  })

  it('stops a load in flight when the model is unloaded', async () => {
    let entered!: () => void
    const spawning = new Promise<void>((resolve) => (entered = resolve))
    const w = await world({
      spawn: (_spec, signal) => {
        entered()
        return new Promise((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(audioError('CANCELLED', 'stopped')), { once: true })
        )
      },
    })
    const loading = w.service.loadModel(speechLoad()).catch((error: unknown) => error)
    await spawning
    await w.service.unloadModel()
    expect(await loading).toMatchObject({ code: 'CANCELLED' })
    expect((await w.service.status()).model.state).toBe('unloaded')
  })

  it('refuses to load while the core shuts down', async () => {
    const w = await world()
    await w.service.shutdown()
    await expect(w.service.loadModel(speechLoad())).rejects.toMatchObject({ code: 'ENGINE_CRASHED' })
  })
})

describe('jobs through the service', () => {
  it('generates, answers the job, finds it again and lists the clip in the gallery', async () => {
    const w = await world()
    await w.service.loadModel(speechLoad())
    expect(w.service.capabilities().modelId).toBe('kokoro-82m:q8_0')
    const job = await w.service.generate('speech', { text: 'Hello' })
    expect(job.state).toBe('queued')
    while (w.service.getJob(job.id)?.state !== 'completed')
      await new Promise((resolve) => setTimeout(resolve, 5))
    const outcome = await w.service.runJob('speech', { text: 'Again' })
    expect(outcome.item.recipe.text).toBe('Again')
    expect(w.service.getJob(job.id)?.state).toBe('completed')
    expect(w.service.getJob('nope')).toBeNull()
    const page = await w.service.gallery({ offset: 0, limit: 10 })
    expect(page.total).toBe(2)
    await w.service.deleteGalleryItem(job.id)
    expect((await w.service.gallery({ offset: 0, limit: 10 })).total).toBe(1)
  })

  it('cancels a generating job by stopping the server, and an unload cancels it too', async () => {
    const w = await world()
    await w.service.loadModel(speechLoad())
    w.http.reply.current = hangUntilAborted
    const first = await w.service.generate('speech', { text: 'long' })
    await generating(w, first.id)
    expect(await w.service.cancelJob(first.id)).toEqual({ cancelled: true, serverStopped: true })
    const second = await w.service.generate('speech', { text: 'long again' })
    await vi.waitFor(() => expect(w.handles).toHaveLength(2))
    await generating(w, second.id)
    await w.service.unloadModel()
    expect((w.service.getJob(second.id) as AudioJob).state).toBe('cancelled')
    expect((await w.service.status()).model.state).toBe('unloaded')
    expect(() => w.service.capabilities()).toThrow()
  })
})

describe('speechBackend', () => {
  it('names the loaded model and its mode, runs speech jobs as the studio does, and cancels one', async () => {
    const w = await world()
    const backend = w.service.speechBackend()
    expect(backend.loaded()).toBeUndefined()
    await expect(backend.start({ text: 'Hello' })).rejects.toMatchObject({ code: 'MODEL_NOT_LOADED' })
    await w.service.loadModel(speechLoad())
    expect(backend.loaded()).toEqual({
      modelId: 'kokoro-82m:q8_0',
      displayName: 'Kokoro 82M',
      mode: 'speech',
    })

    const started = await backend.start({ text: 'Hello', seed: 5 })
    expect(w.service.getJob(started.id)?.mode).toBe('speech')
    const result = await started.done
    if (!result.ok) throw new Error(result.error.message)
    expect(result.outcome.job).toMatchObject({ id: started.id, state: 'completed' })
    expect(result.outcome.item.recipe).toMatchObject({ text: 'Hello', seed: 5 })
    expect(result.outcome.wav.toString('latin1', 0, 4)).toBe('RIFF')
    expect((await w.service.gallery({ offset: 0, limit: 10 })).items.map((i) => i.id)).toEqual([started.id])
    expect(
      w.events.filter((e) => e.name === 'audio:job').map((e) => (e.payload['job'] as AudioJob).state)
    ).toContain('completed')

    w.http.reply.current = hangUntilAborted
    const long = await backend.start({ text: 'long' })
    await generating(w, long.id)
    await backend.cancel(long.id)
    expect(await long.done).toMatchObject({ ok: false, error: { code: 'CANCELLED' } })

    await w.service.loadModel(speechLoad({ modelId: 'ace', mode: 'music', task: 'gen', family: 'ace_step' }))
    expect(backend.loaded()?.mode).toBe('music')
    await expect(backend.start({ text: 'Hello' })).rejects.toMatchObject({ code: 'UNSUPPORTED_MODE' })
  })
})

describe('configuration', () => {
  it('moves the gallery folder and back, sets the idle unload, and reports each change', async () => {
    const w = await world()
    const sounds = join(w.dir, 'sounds')
    expect((await w.service.setOutputDir(sounds)).outputDir).toBe(sounds)
    expect(await readdir(sounds)).toEqual([])
    expect((await w.service.setOutputDir('  ')).outputDir).toBe(join(w.dir, 'audios'))
    expect((await w.service.config({ outputDir: sounds, idleUnloadSecs: 0 })).idleUnloadSecs).toBe(0)
    expect((await w.service.status()).outputDir).toBe(sounds)
    expect((await w.service.config({ outputDir: null })).outputDir).toBe(join(w.dir, 'audios'))
    expect(w.reasons()).toEqual(['output-dir', 'output-dir', 'config', 'config'])
  })

  it('re-arms the idle timer only for a model that is there and idle', async () => {
    const w = await world()
    w.service.touchIdle()
    expect(w.service.state.idleExpired()).toBe(false)
    await w.service.loadModel(speechLoad())
    await w.service.config({ idleUnloadSecs: 30 })
    w.service.touchIdle()
    expect(w.service.state.idleExpired()).toBe(false)
  })

  it('unloads an idle model on its timer', async () => {
    let now = 0
    const w = await world({ idleTickMs: 5, now: () => now })
    w.service.start()
    w.service.start()
    await w.service.loadModel(speechLoad())
    now += 600_000
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect((await w.service.status()).model.state).toBe('unloaded')
    expect(w.reasons()).toContain('idle')
    await w.service.shutdown()
  })
})

describe('model files', () => {
  it('lists them, deletes one, and refuses the loaded model’s own file', async () => {
    const w = await world()
    await mkdir(join(w.layout.audio.modelsDir, 'ace'), { recursive: true })
    await writeFile(join(w.layout.audio.modelsDir, 'ace', 'ace.gguf'), 'x')
    expect((await w.service.listModelFiles()).map((f) => f.relativePath)).toEqual([
      'ace/ace.gguf',
      'kokoro/kokoro-82m-q8_0.gguf',
    ])
    await w.service.loadModel(speechLoad())
    await expect(w.service.deleteModelFile('kokoro/kokoro-82m-q8_0.gguf')).rejects.toMatchObject({
      code: 'BACKEND_IN_USE',
    })
    await w.service.deleteModelFile('ace/ace.gguf')
    expect((await w.service.listModelFiles()).map((f) => f.relativePath)).toEqual([
      'kokoro/kokoro-82m-q8_0.gguf',
    ])
    await expect(w.service.deleteModelFile('../x')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})

describe('engineHost', () => {
  it('holds loads off, names the builds in use, and unloads a model whose build was replaced', async () => {
    const w = await world()
    const host = w.service.engineHost()
    expect(await host.inUse()).toEqual([])
    await w.service.loadModel(speechLoad())
    expect(await host.inUse()).toEqual([w.build])
    expect(await host.exclusive(async () => w.service.state.spec?.tag)).toBe('v0.9.3-a1b2c3d4')

    // The same build again: nothing to do.
    await host.activate(w.build as string, false)
    expect(w.service.state.spec).toBeDefined()
    // A forced reinstall over the same folder: the running binary is the old one.
    await host.activate(w.build as string, true)
    expect(w.service.state.spec).toBeUndefined()
    expect(w.reasons().slice(-2)).toEqual(['engine-updated', 'install'])

    // A newer build: a model on the old one goes, its job cancelled first.
    await w.service.loadModel(speechLoad())
    w.http.reply.current = hangUntilAborted
    const job = await w.service.generate('speech', { text: 'long' })
    await generating(w, job.id)
    const newer = await installBuild(w.layout.audio.backendsDir, 'v0.9.4-a1b2c3d4', 'metal', 2)
    await host.exclusive(() => host.activate(newer, false))
    expect(w.service.getJob(job.id)?.state).toBe('cancelled')
    expect(w.service.state.spec).toBeUndefined()

    await expect(host.activate(join(w.dir, 'nothing'), false)).rejects.toMatchObject({ code: 'INTERNAL' })
    await host.changed?.('uninstall')
    expect(w.reasons().at(-1)).toBe('uninstall')
  })
})

describe('a cancel under the load lock', () => {
  it('never waits for a job that waits for the lock to respawn its server', async () => {
    const w = await world()
    await w.service.loadModel(speechLoad())
    await w.service.state.session?.server.terminate()
    const host = w.service.engineHost()
    const newer = await installBuild(w.layout.audio.backendsDir, 'v0.9.4-a1b2c3d4', 'metal', 2)
    let jobId = ''
    await host.exclusive(async () => {
      jobId = (await w.service.generate('speech', { text: 'x' })).id
      while (w.service.getJob(jobId)?.progress?.phase !== 'loading')
        await new Promise((resolve) => setTimeout(resolve, 2))
      await host.activate(newer, false)
    })
    expect(w.service.getJob(jobId)?.state).toBe('cancelled')
    expect(w.service.state.spec).toBeUndefined()
    // The runner, let in after the lock, gives up without spawning anything.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(w.handles).toHaveLength(1)
  })

  it('lets a clip being saved finish', async () => {
    const w = await world()
    await w.service.loadModel(speechLoad())
    const job = await w.service.generate('speech', { text: 'x' })
    while (w.service.getJob(job.id)?.progress?.phase !== 'saving')
      await new Promise((resolve) => setImmediate(resolve))
    expect(await w.service.cancelJob(job.id)).toEqual({ cancelled: false, serverStopped: false })
    expect(w.service.getJob(job.id)?.state).toBe('completed')
  })
})

describe('GPU residency', () => {
  it('reports the server it runs, busy while a job generates, and claims through core’s hook', async () => {
    const claims: Array<GpuClaim & { aborted: boolean }> = []
    const w = await world({
      claimGpu: async (claim, signal, granted) => {
        claims.push({ ...claim, aborted: signal?.aborted ?? false })
        granted?.()
      },
    })
    expect(w.service.gpuOccupancy()).toEqual([])
    await w.service.loadModel(speechLoad())
    expect(claims).toEqual([{ model_id: 'kokoro-82m:q8_0', cards: 'all', auxiliary: false, aborted: false }])
    expect(w.service.gpuOccupancy()).toEqual([
      { model_id: 'kokoro-82m:q8_0', cards: 'all', auxiliary: false, state: 'ready' },
    ])

    w.http.reply.current = hangUntilAborted
    const job = await w.service.generate('speech', { text: 'long' })
    await generating(w, job.id)
    expect(w.service.gpuOccupancy()).toEqual([
      {
        model_id: 'kokoro-82m:q8_0',
        cards: 'all',
        auxiliary: false,
        state: 'ready',
        busy: 'Kokoro 82M is generating speech',
        remedy: 'Wait for the clip to finish, or stop it, then try again.',
      },
    ])
    await w.service.cancelJob(job.id)
    expect(w.service.gpuOccupancy()).toEqual([])
  })

  it('reports a server starting and one stopping, and none on the CPU backend', async () => {
    let release!: () => void
    const w = await world({
      env: { ATOMIC_AUDIO_BACKEND: 'cpu' },
      spawn: async (spec) => {
        await new Promise<void>((resolve) => (release = resolve))
        const handle = fakeHandle(spec)
        handle.terminate = () => new Promise(() => {})
        return handle
      },
    })
    const loading = w.service.loadModel(speechLoad({ modelId: 'music', mode: 'music', task: 'gen' }))
    await vi.waitFor(() =>
      expect(w.service.gpuOccupancy()).toEqual([
        { model_id: 'music', cards: [], auxiliary: false, state: 'loading' },
      ])
    )
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    await loading
    void w.service.loadModel(speechLoad())
    await vi.waitFor(() => expect(w.service.gpuOccupancy().map((o) => o.state)).toEqual(['stopping']))
  })

  it('stops a claim waiting for its turn when an unload is asked for', async () => {
    let entered!: () => void
    const claiming = new Promise<void>((resolve) => (entered = resolve))
    const w = await world({
      claimGpu: (_claim, signal) => {
        entered()
        return new Promise((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(audioError('CANCELLED', 'claim cancelled')), {
            once: true,
          })
        )
      },
    })
    const loading = w.service.loadModel(speechLoad()).catch((error: unknown) => error)
    await claiming
    await w.service.unloadModel()
    expect(await loading).toMatchObject({ code: 'CANCELLED' })
    expect((await w.service.status()).model.state).toBe('unloaded')
  })

  it('gives up a claim at once when it starts after an unload was asked for', async () => {
    let seen: boolean | undefined
    const w = await world({
      claimGpu: async (_claim, signal) => {
        seen = signal?.aborted
        if (signal?.aborted) throw audioError('CANCELLED', 'claim cancelled')
      },
    })
    // The load holds the lock and waits for a server still exiting; the unload is asked meanwhile.
    let exited!: () => void
    w.service.state.stopping = {
      spec: {} as AudioServerSpec,
      done: new Promise<void>((resolve) => (exited = resolve)),
    }
    const loading = w.service.loadModel(speechLoad()).catch((error: unknown) => error)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const unloading = w.service.unloadModel()
    exited()
    w.service.state.stopping = undefined
    expect(await loading).toMatchObject({ code: 'CANCELLED' })
    await unloading
    expect(seen).toBe(true)
  })
})

describe('shutdown', () => {
  it.skipIf(process.platform === 'win32')(
    'confirms a real child exits while its model is loading',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'atomic-core-audio-shutdown-'))
      dirs.push(dir)
      await installFakeAudioEngine(dir, { loadMs: 30_000 })
      await writeFakeAudioModel(dir)
      let spawned!: (pid: number) => void
      const entered = new Promise<number>((resolve) => (spawned = resolve))
      const service = new AudioService({
        paths: dataLayout(dir).audio,
        emit: () => {},
        log: () => {},
        journal: { add: async (pid) => spawned(pid), remove: async () => {} },
      })
      const loading = service.loadModel(speechLoad()).catch((error: unknown) => error)
      const pid = await entered
      expect(isProcessAlive(pid)).toBe(true)
      await service.shutdown()
      const aliveAfterShutdown = isProcessAlive(pid)
      expect(await loading).toMatchObject({ code: 'CANCELLED' })
      expect(aliveAfterShutdown).toBe(false)
    }
  )

  it('waits for a cancelled load to confirm its child is gone', async () => {
    let spawned!: () => void
    const entered = new Promise<void>((resolve) => (spawned = resolve))
    let finishStop!: () => void
    const stopped = new Promise<void>((resolve) => (finishStop = resolve))
    let childAlive = true
    const w = await world({
      spawn: async (_spec, signal) => {
        spawned()
        await new Promise<void>((resolve) =>
          signal?.addEventListener('abort', () => resolve(), { once: true })
        )
        await stopped
        childAlive = false
        throw audioError('CANCELLED', 'The child has stopped.')
      },
    })
    const loading = w.service.loadModel(speechLoad()).catch((error: unknown) => error)
    await entered
    let returnedWithLiveChild: boolean | undefined
    const closing = w.service.shutdown().then(() => (returnedWithLiveChild = childAlive))
    // Let an incorrectly early shutdown settle while the child's exit is held.
    await new Promise<void>((resolve) => setImmediate(resolve))
    finishStop()
    await closing
    expect(await loading).toMatchObject({ code: 'CANCELLED' })
    expect(returnedWithLiveChild).toBe(false)
    expect(w.service.gpuOccupancy()).toEqual([])
  })

  it('waits for an already stopping server and its journal cleanup', async () => {
    let removing!: () => void
    const entered = new Promise<void>((resolve) => (removing = resolve))
    let finishRemove!: () => void
    const removed = new Promise<void>((resolve) => (finishRemove = resolve))
    let journalled = true
    const w = await world({
      journal: {
        add: async () => {},
        remove: async () => {
          removing()
          await removed
          journalled = false
        },
      },
    })
    await w.service.loadModel(speechLoad())
    w.http.reply.current = hangUntilAborted
    const job = await w.service.generate('speech', { text: 'long' })
    await generating(w, job.id)
    const cancelling = w.service.cancelJob(job.id)
    await entered
    let returnedWithJournal: boolean | undefined
    const closing = w.service.shutdown().then(() => (returnedWithJournal = journalled))
    await new Promise<void>((resolve) => setImmediate(resolve))
    finishRemove()
    await Promise.all([closing, cancelling])
    expect(returnedWithJournal).toBe(false)
  })

  it('stops the job and the server, and starts nothing after', async () => {
    const w = await world()
    await w.service.loadModel(speechLoad())
    w.http.reply.current = hangUntilAborted
    const job = await w.service.generate('speech', { text: 'long' })
    await generating(w, job.id)
    await w.service.shutdown()
    expect(w.handles[0]?.terminated).toBe(1)
    await vi.waitFor(() => expect(w.service.getJob(job.id)?.state).toBe('cancelled'))
    await expect(w.service.generate('speech', { text: 'x' })).rejects.toMatchObject({
      code: 'ENGINE_CRASHED',
    })
  })
})
