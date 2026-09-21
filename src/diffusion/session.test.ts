/**
 * `session.rs` of `tauri-plugin-atomic-diffusion` (app commit `ec1fd3ea7`), against a fake server
 * handle: what the status says, what the events carry, what a load and an unload leave behind.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dataLayout } from '../config/index.js'
import type { CoreEvents } from '../contracts/index.js'
import { fakeServer, sampleSpec } from '../../test/helpers/diffusion-fixtures.js'
import type { FakeServer } from '../../test/helpers/diffusion-fixtures.js'
import { diffusionError } from './errors.js'
import { INSTALL_RECORD, OWNER_MARKER } from './install.js'
import {
  activateInstall,
  buildStatus,
  capabilities,
  currentInstall,
  emitError,
  emitState,
  GPU_SETTLE_MS,
  loadFromSpec,
  SHUTDOWN_GRACE_MS,
  shutdownSession,
  stopKeepingSpec,
  takeDownSession,
  unload,
} from './session.js'
import type { SessionDeps } from './session.js'
import { DiffusionState } from './state.js'

let dataFolder: string
beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-session-'))
})
afterEach(async () => {
  await rm(dataFolder, { recursive: true, force: true })
})

interface Harness {
  deps: SessionDeps
  state: DiffusionState
  events: Array<{ name: string; payload: unknown }>
  reasons: () => string[]
  servers: FakeServer[]
  slept: number[]
  gone: number[]
  failNextSpawn: (error: Error) => void
}

function harness(): Harness {
  const layout = dataLayout(dataFolder)
  const clock = { now: 1_000 }
  const state = new DiffusionState(layout.diffusion, () => clock.now)
  state.config = { dataFolder }
  const events: Harness['events'] = []
  const servers: FakeServer[] = []
  const slept: number[] = []
  const gone: number[] = []
  let failure: Error | undefined
  const deps: SessionDeps = {
    state,
    emit: (name, payload) => events.push({ name, payload }),
    log: () => {},
    platform: process.platform,
    now: () => clock.now,
    sleep: async (ms) => {
      slept.push(ms)
    },
    spawn: async (spec) => {
      if (failure) {
        const error = failure
        failure = undefined
        throw error
      }
      const server = fakeServer({
        port: 4000 + servers.length,
        pid: 100 + servers.length,
        cancelGenerating: spec.family === 'flux.2-klein',
      })
      servers.push(server)
      return server.handle
    },
    onServerGone: async (pid) => {
      gone.push(pid)
    },
  }
  return {
    deps,
    state,
    events,
    reasons: () =>
      events.filter((e) => e.name === 'diffusion:state').map((e) => (e.payload as { reason: string }).reason),
    servers,
    slept,
    gone,
    failNextSpawn: (error) => (failure = error),
  }
}

async function installedEngine(dir: string, backendId: string, installedAtMs: number): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, process.platform === 'win32' ? 'sd-server.exe' : 'sd-server'), 'bin')
  await writeFile(join(dir, OWNER_MARKER), 'atomic-chat\n')
  await writeFile(
    join(dir, INSTALL_RECORD),
    JSON.stringify({ tag: 'tag', backendId, backend: 'cpu', engine: 'sd-cpp', sha256: null, installedAtMs })
  )
}

describe('the status', () => {
  it('reports the newest install, or the one the loaded model runs from', async () => {
    const h = harness()
    expect(await currentInstall(h.deps)).toEqual({ state: 'not-installed' })
    const older = join(h.state.paths.backendsDir, 'tag', 'older')
    const newer = join(h.state.paths.backendsDir, 'tag', 'newer')
    await installedEngine(older, 'older', 1)
    await installedEngine(newer, 'newer', 2)
    expect(await currentInstall(h.deps)).toMatchObject({ state: 'installed', backendId: 'newer', dir: newer })
    h.state.spec = sampleSpec({ binaryDir: older })
    expect(await currentInstall(h.deps)).toMatchObject({ state: 'installed', backendId: 'older', dir: older })
    h.state.spec = sampleSpec({ binaryDir: join(h.state.paths.backendsDir, 'tag', 'gone') })
    expect(await currentInstall(h.deps)).toMatchObject({ backendId: 'newer' })
  })

  it('describes an unconfigured, an empty and a loaded service', async () => {
    const h = harness()
    h.state.config = undefined
    expect(await buildStatus(h.deps)).toEqual({
      configured: false,
      install: { state: 'not-installed' },
      model: { state: 'unloaded', loaded: null },
      activeJob: null,
      outputDir: join(dataFolder, 'images'),
      idleUnloadSecs: 600,
    })
    h.state.config = { dataFolder, outputDir: '/pics', idleUnloadSecs: 0 }
    const info = await loadFromSpec(h.deps, sampleSpec(), 'load')
    const status = await buildStatus(h.deps)
    expect(status.model).toEqual({ state: 'loaded', loaded: info })
    expect(status.outputDir).toBe('/pics')
    expect(status.idleUnloadSecs).toBe(0)
    // The loaded model is a copy: a caller cannot reach into the session.
    expect(status.model.loaded).not.toBe(h.state.session?.info)
    h.state.setModelState('failed', { code: 'OUT_OF_MEMORY', message: 'oom' })
    const failed = await buildStatus(h.deps)
    expect(failed.model).toEqual({
      state: 'failed',
      loaded: null,
      error: { code: 'OUT_OF_MEMORY', message: 'oom' },
    })
  })

  it('emits the status with a reason, and errors with an optional job id', async () => {
    const h = harness()
    await emitState(h.deps, 'output-dir')
    expect(h.events).toHaveLength(1)
    expect(h.events[0]?.name).toBe('diffusion:state')
    expect((h.events[0]?.payload as CoreEvents['diffusion:state']).reason).toBe('output-dir')
    emitError(h.deps, undefined, { code: 'INTERNAL', message: 'x' })
    emitError(h.deps, 'job-1', { code: 'CANCELLED', message: 'y', details: 'z' })
    expect(h.events.slice(1)).toEqual([
      { name: 'diffusion:error', payload: { code: 'INTERNAL', message: 'x' } },
      { name: 'diffusion:error', payload: { jobId: 'job-1', code: 'CANCELLED', message: 'y', details: 'z' } },
    ])
  })
})

describe('capabilities', () => {
  it('come from the spec and the running server', async () => {
    const h = harness()
    expect(() => capabilities(h.state)).toThrow('Load an image model first.')
    await loadFromSpec(
      h.deps,
      sampleSpec({
        family: 'flux.2-klein',
        defaults: { steps: 4, cfgScale: 4.0, guidance: 3.5, width: 512, height: 512 },
      }),
      'load'
    )
    expect(capabilities(h.state)).toEqual({
      workflows: ['create', 'transform', 'inpaint', 'extend', 'upscale', 'reference', 'edit'],
      minDim: 256,
      maxDim: 2048,
      dimMultiple: 16,
      supportsNegativePrompt: true,
      supportsGuidance: true,
      cancelGenerating: true,
      maxBatch: 4,
      defaults: { steps: 4, cfgScale: 4.0, guidance: 3.5, width: 512, height: 512 },
      ranges: { steps: [1, 50], dims: [256, 2048], dimMultiple: 16 },
    })
    // With the server gone the spec still answers, minus the engine's promise.
    await takeDownSession(h.deps)
    const bare = capabilities(h.state)
    expect(bare.cancelGenerating).toBe(false)
    expect(bare.supportsNegativePrompt).toBe(true)
    h.state.spec = sampleSpec()
    expect(capabilities(h.state)).toMatchObject({
      supportsNegativePrompt: false,
      supportsGuidance: false,
      workflows: ['create', 'transform', 'inpaint', 'extend', 'upscale'],
    })
    // What the loaded files allow: Qwen Image 2.1 references only with its vision projector.
    h.state.spec = sampleSpec({ family: 'qwen-image-2.1' })
    expect(capabilities(h.state).workflows).toEqual(['create'])
    h.state.spec = sampleSpec({
      family: 'qwen-image-2.1',
      files: { diffusionModel: '/m/q.gguf', llmVision: '/m/mmproj.gguf' },
    })
    expect(capabilities(h.state).workflows).toEqual(['create', 'reference', 'edit'])
  })
})

describe('loading', () => {
  it('spawns, records the session and the spec, arms the idle timer and reports both transitions', async () => {
    const h = harness()
    const spec = sampleSpec({ backend: 'cuda' })
    const info = await loadFromSpec(h.deps, spec, 'load')
    expect(info).toEqual({
      modelId: 'z-image:q4_k_m',
      family: 'z-image',
      modality: 'image',
      displayName: 'Z-Image Turbo',
      engine: 'sd-cpp',
      backend: 'cuda',
      offload: 'none',
      cpuFallback: false,
      port: 4000,
      pid: 100,
      loadedAtMs: 1_000,
    })
    expect(h.slept, 'CUDA waits for the driver').toEqual([GPU_SETTLE_MS])
    expect(h.state.session?.baseUrl).toBe('http://127.0.0.1:4000')
    expect(h.state.spec).toBe(spec)
    expect(h.state.modelState).toBe('loaded')
    expect(h.state.idleExpired()).toBe(false)
    expect(h.reasons()).toEqual(['load', 'loaded'])
    const states = h.events.map((e) => (e.payload as CoreEvents['diffusion:state']).status.model.state)
    expect(states).toEqual(['loading', 'loaded'])
    await loadFromSpec(h.deps, sampleSpec({ backend: 'metal' }), 'load')
    expect(h.slept).toHaveLength(1)
  })

  it('reports a failed spawn as failed, with the error, and throws it', async () => {
    const h = harness()
    h.failNextSpawn(
      diffusionError('OUT_OF_MEMORY', 'The image model ran out of memory while loading.', 'tail')
    )
    await expect(loadFromSpec(h.deps, sampleSpec(), 'load')).rejects.toMatchObject({ code: 'OUT_OF_MEMORY' })
    expect(h.state.modelState).toBe('failed')
    expect(h.state.modelError).toEqual({
      code: 'OUT_OF_MEMORY',
      message: 'The image model ran out of memory while loading.',
      details: 'tail',
    })
    expect(h.state.session).toBeUndefined()
    expect(h.reasons()).toEqual(['load', 'load-failed'])
    expect(h.events.at(-1)).toEqual({
      name: 'diffusion:error',
      payload: {
        code: 'OUT_OF_MEMORY',
        message: 'The image model ran out of memory while loading.',
        details: 'tail',
      },
    })
    // A plain failure is reported as internal.
    h.failNextSpawn(new Error('spawn EPERM'))
    await expect(loadFromSpec(h.deps, sampleSpec(), 'load')).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'spawn EPERM',
    })
  })

  // Port of `incompatible_retained_spec_is_rejected_before_any_spawn_or_file_access`
  // (`session.rs`, app commit ec1fd3ea7): a spec kept across an engine update can name a build that
  // is now too old for it.
  it('refuses a spec whose engine is too old for its family before anything is spawned', async () => {
    const h = harness()
    const spec = sampleSpec({ family: 'qwen-image-2.1', tag: 'master-849-d04e895' })
    await expect(loadFromSpec(h.deps, spec, 'respawn')).rejects.toMatchObject({
      code: 'ENGINE_UPDATE_REQUIRED',
    })
    expect(h.servers).toHaveLength(0)
    expect(h.state.modelState).toBe('failed')
    expect(h.state.modelError?.code).toBe('ENGINE_UPDATE_REQUIRED')
    expect(h.reasons()).toEqual(['respawn', 'load-failed'])
    await expect(loadFromSpec(h.deps, { ...spec, tag: 'master-883-137f740' }, 'load')).resolves.toMatchObject(
      {
        family: 'qwen-image-2.1',
      }
    )
  })
})

describe('tearing down', () => {
  it('takes the session down, forgets its pid, and says whether there was one', async () => {
    const h = harness()
    expect(await takeDownSession(h.deps)).toBe(false)
    await loadFromSpec(h.deps, sampleSpec(), 'load')
    const server = h.servers[0] as FakeServer
    server.handle.setLineListener(() => {})
    expect(await takeDownSession(h.deps)).toBe(true)
    expect(server.terminated).toEqual([5_000])
    expect(h.gone).toEqual([100])
    expect(h.state.session).toBeUndefined()
    // The listener was detached before the kill, the spec and the model state were not touched.
    expect(h.state.spec).toBeDefined()
    expect(h.state.modelState).toBe('loaded')
  })

  it('unloads: server gone, spec forgotten, idle cleared, two state events', async () => {
    const h = harness()
    await loadFromSpec(h.deps, sampleSpec(), 'load')
    h.events.length = 0
    await unload(h.deps, 'unload')
    expect(h.state.session).toBeUndefined()
    expect(h.state.spec).toBeUndefined()
    expect(h.state.modelState).toBe('unloaded')
    expect(h.state.idleExpired()).toBe(false)
    expect(
      h.events.map((e) => [
        (e.payload as CoreEvents['diffusion:state']).status.model.state,
        (e.payload as { reason: string }).reason,
      ])
    ).toEqual([
      ['unloading', 'unload'],
      ['unloaded', 'unload'],
    ])
    // Unloading what is not loaded reports once.
    h.events.length = 0
    await unload(h.deps, 'idle')
    expect(h.reasons()).toEqual(['idle'])
  })

  describe('after an engine install', () => {
    const record = (tag: string, dir: string) => ({
      tag,
      backendId: 'test-cpu',
      backend: 'cpu' as const,
      engine: 'sd-cpp' as const,
      sha256: null,
      installedAtMs: 1,
      dir,
    })

    // `activating_an_update_forgets_idle_or_failed_specs` (`session.rs`, app commit ec1fd3ea7).
    it('forgets an idle or failed spec that ran from another build', async () => {
      for (const modelState of ['unloaded', 'failed'] as const) {
        const h = harness()
        h.state.spec = sampleSpec({ tag: 'master-849-d04e895', binaryDir: '/engines/849' })
        h.state.setModelState(modelState)
        await activateInstall(h.deps, record('master-883-137f740', '/engines/883'))
        expect(h.state.spec, modelState).toBeUndefined()
        expect(h.state.modelState).toBe('unloaded')
        expect(h.reasons().at(-1)).toBe('engine-updated')
      }
    })

    // `activating_an_update_terminates_the_resident_old_server` (`session.rs`).
    it('unloads a resident server of another build', async () => {
      const h = harness()
      await loadFromSpec(h.deps, sampleSpec({ tag: 'master-849-d04e895', binaryDir: '/engines/849' }), 'load')
      const server = h.servers[0] as FakeServer
      await activateInstall(h.deps, record('master-883-137f740', '/engines/883'))
      expect(server.terminated).toHaveLength(1)
      expect(h.state.session).toBeUndefined()
      expect(h.state.spec).toBeUndefined()
      expect(h.state.modelState).toBe('unloaded')
    })

    it('leaves a spec on the same tag and tree alone, and one of another engine', async () => {
      const h = harness()
      const dir = join(dataFolder, 'engine')
      await mkdir(dir, { recursive: true })
      await loadFromSpec(h.deps, sampleSpec({ tag: 'master-883-137f740', binaryDir: dir }), 'load')
      h.events.length = 0
      await activateInstall(h.deps, record('master-883-137f740', dir))
      await activateInstall(h.deps, { ...record('master-900-abc', '/elsewhere'), engine: 'diffusers' })
      expect(h.state.session).toBeDefined()
      expect(h.events).toEqual([])
      // The same tag in another tree is another build.
      await activateInstall(h.deps, record('master-883-137f740', join(dataFolder, 'other')))
      expect(h.state.spec).toBeUndefined()
    })
  })

  it('stops keeping the spec, as failed or as unloaded', async () => {
    const h = harness()
    const spec = sampleSpec()
    await loadFromSpec(h.deps, spec, 'load')
    await stopKeepingSpec(h.deps, 'crashed', { code: 'ENGINE_CRASHED', message: 'died' })
    expect(h.state.session).toBeUndefined()
    expect(h.state.spec).toBe(spec)
    expect(h.state.modelState).toBe('failed')
    expect(h.state.modelError?.code).toBe('ENGINE_CRASHED')
    expect(h.reasons().at(-1)).toBe('crashed')
    await loadFromSpec(h.deps, spec, 'respawn')
    await stopKeepingSpec(h.deps, 'cancelled')
    expect(h.state.modelState).toBe('unloaded')
    expect(h.state.modelError).toBeUndefined()
    expect(h.state.spec).toBe(spec)
  })

  it('shuts down with a short grace and no events', async () => {
    const h = harness()
    await loadFromSpec(h.deps, sampleSpec(), 'load')
    h.events.length = 0
    await shutdownSession(h.deps)
    expect((h.servers[0] as FakeServer).terminated).toEqual([SHUTDOWN_GRACE_MS])
    expect(h.events).toEqual([])
    await shutdownSession(h.deps)
  })
})
