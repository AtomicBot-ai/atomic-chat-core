import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dataLayout } from '../config/index.js'
import { AtomicCoreError } from '../contracts/index.js'
import type { AudioStatus, CoreEvents } from '../contracts/index.js'
import { fakeHandle, sampleAudioSpec, sampleCapabilities } from '../../test/helpers/audio-fixtures.js'
import type { FakeHandle } from '../../test/helpers/audio-fixtures.js'
import { audioError } from './errors.js'
import { writeAudioInstallRecord } from './install.js'
import {
  activateAudioInstall,
  audioCapabilities,
  audioGpuCards,
  buildAudioStatus,
  currentAudioInstall,
  emitAudioError,
  emitAudioState,
  failLoad,
  loadFromSpec,
  modelNotLoadedError,
  shutdownAudioSession,
  stopKeepingSpec,
  takeDownSession,
  unloadSession,
} from './session.js'
import type { AudioSessionDeps } from './session.js'
import { AudioState } from './state.js'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function world() {
  const dir = await mkdtemp(join(tmpdir(), 'atomic-core-audio-session-'))
  dirs.push(dir)
  const layout = dataLayout(dir)
  const state = new AudioState(layout.audio)
  const events: Array<{ name: string; payload: Record<string, unknown> }> = []
  const handles: FakeHandle[] = []
  const sleeps: number[] = []
  const gone: number[] = []
  const deps: AudioSessionDeps = {
    state,
    emit: <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) =>
      void events.push({ name, payload: payload as unknown as Record<string, unknown> }),
    log: () => {},
    platform: process.platform,
    now: () => 42,
    sleep: async (ms) => void sleeps.push(ms),
    spawn: async (spec) => {
      const handle = fakeHandle(spec)
      handle.capabilities = sampleCapabilities(spec, { voices: ['af_heart'] })
      handles.push(handle)
      return handle
    },
    onServerGone: async (pid) => void gone.push(pid),
  }
  const reasons = () => events.filter((e) => e.name === 'audio:state').map((e) => String(e.payload['reason']))
  const states = () =>
    events
      .filter((e) => e.name === 'audio:state')
      .map((e) => (e.payload['status'] as AudioStatus).model.state)
  return { dir, layout, state, deps, events, handles, sleeps, gone, reasons, states }
}

/** An owned build with its server binary, as the engine-builds install leaves it. */
async function installBuild(root: string, tag: string, backendId: string, installedAtMs: number) {
  const dir = join(root, tag, backendId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, process.platform === 'win32' ? 'audiocpp_server.exe' : 'audiocpp_server'), '')
  const record = {
    tag,
    backendId,
    backend: 'metal' as const,
    engine: 'audio-cpp' as const,
    sha256: null,
    installedAtMs,
    dir,
  }
  await writeAudioInstallRecord(dir, record)
  return record
}

describe('loadFromSpec', () => {
  it('claims the GPU, holds it while starting, spawns, and reports the model loaded', async () => {
    const w = await world()
    const spec = sampleAudioSpec({ backend: 'cuda' })
    const claims: unknown[] = []
    w.deps.claimGpu = async (claimed, _signal, granted) => {
      claims.push(claimed.modelId)
      granted?.()
      expect(w.state.starting).toBe(claimed)
    }
    const loaded = await loadFromSpec(w.deps, spec, 'load')
    expect(loaded).toEqual({
      modelId: 'kokoro-82m:q8_0',
      displayName: 'Kokoro 82M',
      mode: 'speech',
      family: 'kokoro_tts',
      task: 'tts',
      backend: 'cuda',
      tag: 'v0.9.3-a1b2c3d4',
      backendId: 'macos-arm64',
      port: 3900,
      pid: w.handles[0]?.pid,
      loadedAtMs: 42,
    })
    expect(claims).toEqual(['kokoro-82m:q8_0'])
    expect(w.sleeps).toEqual([500])
    expect(w.state.starting).toBeUndefined()
    expect(w.state.session?.baseUrl).toBe('http://127.0.0.1:3900')
    expect(w.state.capabilities?.voices).toEqual(['af_heart'])
    expect(w.reasons()).toEqual(['load', 'loaded'])
    expect(w.states()).toEqual(['loading', 'loaded'])
    expect(w.state.idleExpired()).toBe(false)
  })

  it('reports a failed spawn as a failed model, in the state and in an error event', async () => {
    const w = await world()
    w.deps.spawn = async () => Promise.reject(audioError('MODEL_LOAD_FAILED', 'exited', 'bad tensor'))
    await expect(loadFromSpec(w.deps, sampleAudioSpec(), 'load')).rejects.toMatchObject({
      code: 'MODEL_LOAD_FAILED',
    })
    expect(w.state.modelState).toBe('failed')
    expect(w.reasons()).toEqual(['load', 'load-failed'])
    expect(w.events.at(-1)).toEqual({
      name: 'audio:error',
      payload: { code: 'MODEL_LOAD_FAILED', message: 'exited', details: 'bad tensor' },
    })
  })

  it('carries a refusal of another surface (GPU_BUSY) as INTERNAL with its code in the details', async () => {
    const w = await world()
    w.deps.claimGpu = async () =>
      Promise.reject(new AtomicCoreError('GPU_BUSY', 'mlx/x still holds the GPU.', 'holder=mlx/x'))
    await expect(loadFromSpec(w.deps, sampleAudioSpec(), 'load')).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'mlx/x still holds the GPU.',
      details: 'GPU_BUSY: holder=mlx/x',
    })
  })

  it('leaves a load an unload stopped unloaded, with no error event', async () => {
    const w = await world()
    const controller = new AbortController()
    w.deps.spawn = async () => {
      controller.abort()
      throw audioError('CANCELLED', 'stopped')
    }
    await expect(loadFromSpec(w.deps, sampleAudioSpec(), 'respawn', controller.signal)).rejects.toMatchObject(
      {
        code: 'CANCELLED',
      }
    )
    expect(w.state.modelState).toBe('unloaded')
    expect(w.reasons()).toEqual(['respawn', 'load-cancelled'])
    expect(w.events.some((e) => e.name === 'audio:error')).toBe(false)
  })

  it('waits for a server still exiting before it starts another', async () => {
    const w = await world()
    const order: string[] = []
    let finish!: () => void
    w.state.stopping = {
      spec: sampleAudioSpec(),
      done: new Promise<void>((resolve) => (finish = resolve)).then(() => void order.push('stopped')),
    }
    const spawn = w.deps.spawn
    w.deps.spawn = async (spec, signal) => {
      order.push('spawn')
      return spawn(spec, signal)
    }
    const loading = loadFromSpec(w.deps, sampleAudioSpec(), 'load')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(order).toEqual([])
    finish()
    await loading
    expect(order).toEqual(['stopped', 'spawn'])
  })
})

describe('takeDownSession, unloadSession, stopKeepingSpec', () => {
  it('stops the server, forgets it, and keeps or drops the spec as asked', async () => {
    const w = await world()
    await loadFromSpec(w.deps, sampleAudioSpec(), 'load')
    const first = w.handles[0] as FakeHandle
    await stopKeepingSpec(w.deps, 'cancelled')
    expect(first.terminated).toBe(1)
    expect(w.gone).toEqual([first.pid])
    expect(w.state.session).toBeUndefined()
    expect(w.state.spec).toBeDefined()
    expect(w.state.modelState).toBe('unloaded')
    expect(await takeDownSession(w.deps)).toBe(false)

    await loadFromSpec(w.deps, sampleAudioSpec(), 'respawn')
    await stopKeepingSpec(w.deps, 'crashed', { code: 'ENGINE_CRASHED', message: 'x' })
    expect([w.state.modelState, w.state.modelError?.code]).toEqual(['failed', 'ENGINE_CRASHED'])

    await loadFromSpec(w.deps, sampleAudioSpec(), 'respawn')
    w.events.length = 0
    await unloadSession(w.deps, 'unload')
    expect(w.states()).toEqual(['unloading', 'unloaded'])
    expect([w.state.spec, w.state.capabilities]).toEqual([undefined, undefined])
  })

  it('keeps a server whose exit nobody could confirm as the session', async () => {
    const w = await world()
    await loadFromSpec(w.deps, sampleAudioSpec(), 'load')
    const handle = w.handles[0] as FakeHandle
    handle.terminate = async () => Promise.reject(new Error('still running'))
    await expect(takeDownSession(w.deps)).rejects.toThrow('still running')
    expect(w.state.session?.server).toBe(handle)
    expect(w.state.stopping).toBeUndefined()
  })

  it('stops the server quickly on shutdown, without events', async () => {
    const w = await world()
    await loadFromSpec(w.deps, sampleAudioSpec(), 'load')
    w.events.length = 0
    await shutdownAudioSession(w.deps)
    expect(w.handles[0]?.terminated).toBe(1)
    expect(w.events).toEqual([])
  })
})

describe('activateAudioInstall', () => {
  it('unloads a model that runs from another build, and keeps one that runs from the new one', async () => {
    const w = await world()
    const old = await installBuild(w.layout.audio.backendsDir, 'v0.9.2-a0000001', 'macos-arm64', 1)
    const fresh = await installBuild(w.layout.audio.backendsDir, 'v0.9.3-a1b2c3d4', 'macos-arm64', 2)
    await activateAudioInstall(w.deps, fresh)
    await loadFromSpec(w.deps, sampleAudioSpec({ binaryDir: fresh.dir, tag: fresh.tag }), 'load')
    await activateAudioInstall(w.deps, fresh)
    expect(w.state.spec).toBeDefined()
    await activateAudioInstall(w.deps, old)
    expect(w.state.spec).toBeUndefined()
    expect(w.reasons().at(-1)).toBe('engine-updated')
  })
})

describe('the status', () => {
  it('reports the newest build, or the one the model runs from, and the model', async () => {
    const w = await world()
    expect(await currentAudioInstall(w.deps)).toEqual({ state: 'not-installed' })
    const old = await installBuild(w.layout.audio.backendsDir, 'v0.9.2-a0000001', 'macos-arm64', 1)
    const fresh = await installBuild(w.layout.audio.backendsDir, 'v0.9.3-a1b2c3d4', 'macos-arm64', 2)
    expect(await currentAudioInstall(w.deps)).toEqual({
      state: 'installed',
      backend: 'metal',
      tag: fresh.tag,
      backendId: 'macos-arm64',
      dir: fresh.dir,
    })
    await loadFromSpec(w.deps, sampleAudioSpec({ binaryDir: old.dir, tag: old.tag }), 'load')
    const status = await buildAudioStatus(w.deps)
    expect(status).toMatchObject({
      install: { tag: old.tag },
      model: { state: 'loaded', loaded: { modelId: 'kokoro-82m:q8_0' } },
      activeJob: null,
      outputDir: join(w.dir, 'audios'),
      idleUnloadSecs: 600,
    })
    w.state.setModelState('failed', { code: 'ENGINE_CRASHED', message: 'x' })
    expect((await buildAudioStatus(w.deps)).model).toEqual({
      state: 'failed',
      loaded: null,
      error: { code: 'ENGINE_CRASHED', message: 'x' },
    })
    await emitAudioState(w.deps, 'probe')
    expect(w.reasons().at(-1)).toBe('probe')
  })
})

describe('small parts', () => {
  it('holds every card on a device backend and none on the CPU', () => {
    expect(audioGpuCards({ backend: 'metal' })).toBe('all')
    expect(audioGpuCards({ backend: 'cpu' })).toEqual([])
  })

  it('answers capabilities only for a loaded (or kept) model', async () => {
    const w = await world()
    expect(() => audioCapabilities(w.state)).toThrow(modelNotLoadedError().message)
    await loadFromSpec(w.deps, sampleAudioSpec(), 'load')
    const caps = audioCapabilities(w.state)
    caps.voices.push('mutated')
    expect(audioCapabilities(w.state).voices).toEqual(['af_heart'])
  })

  it('emits an error with or without a job id', async () => {
    const w = await world()
    emitAudioError(w.deps, undefined, { code: 'INTERNAL', message: 'a' })
    emitAudioError(w.deps, 'j', { code: 'INTERNAL', message: 'b', details: 'd' })
    expect(w.events.map((e) => e.payload)).toEqual([
      { code: 'INTERNAL', message: 'a' },
      { code: 'INTERNAL', message: 'b', details: 'd', jobId: 'j' },
    ])
  })

  it('fails a load with the error it was given', async () => {
    const w = await world()
    await expect(failLoad(w.deps, new Error('boom'), 'load-blocked')).rejects.toMatchObject({
      code: 'INTERNAL',
    })
    expect(w.reasons()).toEqual(['load-blocked'])
  })
})
