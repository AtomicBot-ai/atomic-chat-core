import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { AtomicCoreError, DEFAULT_EMBEDDING_SETTINGS } from '../contracts/index.js'
import type { CoreEvents, EmbeddingEngineInfo, EmbeddingSettings } from '../contracts/index.js'
import { fakeEmbeddingSpawn } from '../../test/helpers/fake-llama-server.js'
import type { FakeLlamaOptions } from '../../test/helpers/fake-llama-server.js'
import { createDecisionHttp, MAX_RESTARTS } from '../decision/index.js'
import type { DecisionHttp } from '../decision/index.js'
import { isProcessAlive } from '../runtime/shared/index.js'
import { parseEmbeddingSettingsPatch } from '../settings/index.js'
import type { EmbeddingModelFacts } from './model-facts.js'
import { spawnEmbeddingServer } from './process.js'
import type { EmbeddingProcessHandle, EmbeddingServerSpec } from './process.js'
import {
  EmbeddingService,
  embeddingLaunchKey,
  embeddingModelIdOf,
  embeddingRefusal,
  UNSUPPORTED_RETRY_MS,
} from './service.js'
import type { EmbeddingServiceDeps } from './service.js'

const PACK_DIR = mkdtempSync(join(tmpdir(), 'atomic-embedding-pack-'))
afterAll(() => rmSync(PACK_DIR, { recursive: true, force: true }))

const ENGINE: EmbeddingEngineInfo = {
  path: join(PACK_DIR, 'llama-server'),
  version_backend: 'b11463/macos-arm64',
  provider: 'llamacpp-upstream',
}

const GEMMA2: EmbeddingModelFacts = {
  arch: 'gemma-embedding2',
  embedding: true,
  decision: false,
  pooling: 'mean',
  contextTrain: 262144,
}

interface Harness {
  service: EmbeddingService
  settings: EmbeddingSettings
  events: Array<{ name: string; payload: unknown }>
  states: () => string[]
  spawns: EmbeddingServerSpec[]
  timers: Array<{ fn: () => void; ms: number; cancelled: boolean }>
  fire: () => void
}

const services: EmbeddingService[] = []
afterEach(async () => {
  for (const s of services.splice(0)) await s.shutdown()
})

function harness(
  over: Partial<EmbeddingServiceDeps> = {},
  settings: Partial<EmbeddingSettings> = {}
): Harness {
  const current: EmbeddingSettings = {
    ...DEFAULT_EMBEDDING_SETTINGS,
    enabled: true,
    model_path: '/models/embeddinggemma-2-Q8_0.gguf',
    ...settings,
  }
  const events: Harness['events'] = []
  const spawns: EmbeddingServerSpec[] = []
  const timers: Harness['timers'] = []
  const service = new EmbeddingService({
    dataFolder: '/data',
    readSettings: () => ({ ...current }),
    writeSettings: async (patch) => void Object.assign(current, parseEmbeddingSettingsPatch(patch)),
    resolveEngine: async () => ENGINE,
    spawn: async (spec) => {
      spawns.push(spec)
      throw new Error('no spawn in this test')
    },
    http: createDecisionHttp(),
    emit: <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) =>
      void events.push({ name, payload }),
    log: () => {},
    fileExists: async () => true,
    readModelFacts: async () => GEMMA2,
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false }
      timers.push(timer)
      return () => void (timer.cancelled = true)
    },
    ...over,
  })
  services.push(service)
  return {
    service,
    settings: current,
    events,
    states: () =>
      events.filter((e) => e.name === 'embedding:state').map((e) => (e.payload as { state: string }).state),
    spawns,
    timers,
    fire: () => {
      for (const t of timers.splice(0)) if (!t.cancelled) t.fn()
    },
  }
}

/** The real process: `spawnEmbeddingServer` over the fake engine. */
function realSpawn(
  options: FakeLlamaOptions = {},
  spawns: EmbeddingServerSpec[] = []
): EmbeddingServiceDeps['spawn'] {
  return (spec, signal) => {
    spawns.push(spec)
    return spawnEmbeddingServer(spec, {
      http: createDecisionHttp(),
      spawn: fakeEmbeddingSpawn(options),
      signal,
      pollIntervalMs: 25,
    })
  }
}

function stubHandle(pid: number): EmbeddingProcessHandle & { die: (code: number) => void } {
  let resolveExit: (exit: { code: number | null; signal: null }) => void = () => {}
  let exit: { code: number | null; signal: null } | undefined
  const exited = new Promise<{ code: number | null; signal: null }>((resolve) => (resolveExit = resolve))
  const end = (code: number) => {
    exit = { code, signal: null }
    resolveExit(exit)
    return exit
  }
  return {
    pid,
    port: 4000 + pid,
    apiKey: `key-${pid}`,
    exe: ENGINE.path,
    baseUrl: `http://127.0.0.1:${4000 + pid}`,
    modelId: 'embeddinggemma-2-Q8_0',
    dims: 768,
    modalities: ['text', 'image', 'audio'],
    tail: () => ['engine: last words'],
    exitStatus: () => exit,
    exited,
    terminate: async () => exit ?? end(0),
    die: (code) => void end(code),
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
/** A start that never gets ready, until the owner stops it. */
const hangingSpawn: EmbeddingServiceDeps['spawn'] = (_spec, signal) =>
  new Promise((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(new AtomicCoreError('EMBEDDING_UNAVAILABLE', 'stopped')), {
      once: true,
    })
  )
const rejection = <T>(p: Promise<unknown>): Promise<T> =>
  p.then(
    () => {
      throw new Error('expected a rejection')
    },
    (e: unknown) => e as T
  )

describe('pure helpers', () => {
  it('keys the launch on what the process is started with', () => {
    const base = { ...DEFAULT_EMBEDDING_SETTINGS, model_path: '/m.gguf' }
    expect(embeddingLaunchKey(base)).toBe(
      embeddingLaunchKey({ ...base, idle_unload_secs: 60, enabled: true })
    )
    for (const change of [
      { ctx_size: 4096 },
      { pooling: 'cls' as const },
      { mmproj_path: '/p' },
      { image_max_tokens: 1 },
    ])
      expect(embeddingLaunchKey({ ...base, ...change })).not.toBe(embeddingLaunchKey(base))
  })

  it('names the model by the setting, else the file', () => {
    expect(embeddingModelIdOf({ ...DEFAULT_EMBEDDING_SETTINGS })).toBeNull()
    expect(embeddingModelIdOf({ ...DEFAULT_EMBEDDING_SETTINGS, model_path: '/m/bge-m3-q8_0.gguf' })).toBe(
      'bge-m3-q8_0'
    )
    expect(
      embeddingModelIdOf({ ...DEFAULT_EMBEDDING_SETTINGS, model_path: '/m/x.gguf', model_id: 'bge-m3' })
    ).toBe('bge-m3')
  })

  it.each([
    ['disabled', true, 'turned off'],
    ['idle', false, 'No embedding model'],
    ['unsupported', true, 'llama.cpp'],
    ['failed', true, 'failed to start'],
    ['restarting', true, 'still starting'],
    ['ready', true, 'not running'],
  ] as const)('refuses %s (configured %s) with "%s"', (state, configured, says) =>
    expect(embeddingRefusal(state, configured)).toContain(says)
  )
})

describe('EmbeddingService lifecycle', () => {
  it('loads on the real process and reports what the model answers', async () => {
    const spawns: EmbeddingServerSpec[] = []
    const h = harness(
      { spawn: realSpawn({ embedding: { audio: true } }, spawns) },
      {
        mmproj_path: '/models/mmproj-Q8_0.gguf',
        ctx_size: 4096,
        image_max_tokens: 280,
        model_id: 'embeddinggemma-2',
      }
    )
    const status = await h.service.load()
    expect(status).toMatchObject({
      state: 'ready',
      enabled: true,
      model_path: '/models/embeddinggemma-2-Q8_0.gguf',
      model_id: 'embeddinggemma-2',
      engine: ENGINE,
      dims: 3,
      modalities: ['text', 'image', 'audio'],
      error: null,
    })
    // The GGUF's own pooling (mean) is left to the engine; the context is the setting.
    expect(spawns[0]).toEqual({
      engine: ENGINE,
      modelPath: '/models/embeddinggemma-2-Q8_0.gguf',
      mmprojPath: '/models/mmproj-Q8_0.gguf',
      modelId: 'embeddinggemma-2',
      ctxSize: 4096,
      imageMaxTokens: 280,
      startupTimeoutMs: 120_000,
    })
    expect(h.states()).toEqual(['starting', 'starting', 'ready'])
    const pid = status.pid as number
    await h.service.unload()
    expect(h.service.getStatus()).toMatchObject({ state: 'idle', pid: null, dims: null, modalities: [] })
    expect(isProcessAlive(pid)).toBe(false)
  })

  it('starts in the background once, when enabled and configured', async () => {
    const handle = stubHandle(1)
    const h = harness({ spawn: async () => handle })
    h.service.start()
    await tick()
    await tick()
    expect(h.service.getStatus()).toMatchObject({ state: 'ready', pid: 1 })
    const off = harness({}, { enabled: false })
    off.service.start()
    expect(off.service.getStatus().state).toBe('disabled')
  })

  it.each([
    [{ enabled: false }, 'EMBEDDING_NOT_CONFIGURED', 'disabled'],
    [{ model_path: '' }, 'EMBEDDING_NOT_CONFIGURED', 'idle'],
  ] as const)('refuses to load with %j', async (settings, code, state) => {
    const h = harness({}, settings)
    expect(await rejection<AtomicCoreError>(h.service.load())).toMatchObject({ code })
    expect(h.service.getStatus().state).toBe(state)
    expect(h.spawns).toEqual([])
  })

  it('checks the files and the header before starting anything', async () => {
    const missing = harness(
      { fileExists: async (p) => !p.endsWith('model.gguf') },
      { model_path: '/m/model.gguf' }
    )
    expect(await rejection<AtomicCoreError>(missing.service.load())).toMatchObject({
      code: 'MODEL_FILE_NOT_FOUND',
    })
    expect(missing.service.getStatus()).toMatchObject({
      state: 'failed',
      error: { code: 'MODEL_FILE_NOT_FOUND' },
    })

    const noProjector = harness(
      { fileExists: async (p) => !p.includes('mmproj') },
      { mmproj_path: '/m/mmproj.gguf' }
    )
    expect(await rejection<AtomicCoreError>(noProjector.service.load())).toMatchObject({
      code: 'MODEL_FILE_NOT_FOUND',
      details: '/m/mmproj.gguf',
    })

    const unreadable = harness({ readModelFacts: async () => undefined })
    expect(await rejection<AtomicCoreError>(unreadable.service.load())).toMatchObject({
      code: 'MODEL_LOAD_FAILED',
    })

    const chat = harness({
      readModelFacts: async () => ({ arch: 'llama', embedding: false, decision: false }),
    })
    const error = await rejection<AtomicCoreError>(chat.service.load())
    expect(error).toMatchObject({
      code: 'EMBEDDING_MODEL_NOT_EMBEDDING',
      message: expect.stringContaining('text generation'),
    })
    expect(chat.spawns).toEqual([])
  })

  it('passes mean for a file without pooling and the floor of its architecture', async () => {
    const floors: number[] = []
    const h = harness(
      {
        readModelFacts: async () => ({ arch: 'bert', embedding: true, decision: false, contextTrain: 512 }),
        resolveEngine: async (_path, minBuild) => {
          floors.push(minBuild)
          return ENGINE
        },
      },
      { threads: 4 }
    )
    await rejection(h.service.load())
    expect(floors).toEqual([0])
    expect(h.spawns[0]).toMatchObject({
      pooling: 'mean',
      ctxSize: 512,
      threads: 4,
      modelId: 'embeddinggemma-2-Q8_0',
    })
    const gemma = harness(
      { resolveEngine: async (_p, minBuild) => (floors.push(minBuild), ENGINE) },
      { mmproj_path: '/p' }
    )
    await rejection(gemma.service.load())
    expect(floors).toEqual([0, 11454])
  })

  it('is unsupported without a new enough build, and tries again when llama.cpp is installed', async () => {
    let engines = 0
    const handle = stubHandle(2)
    const h = harness({
      resolveEngine: async () => {
        if (engines++ === 0)
          throw new AtomicCoreError('EMBEDDING_ENGINE_UNSUPPORTED', 'Update llama.cpp to b11454 or newer.')
        return ENGINE
      },
      spawn: async () => handle,
    })
    expect(await rejection<AtomicCoreError>(h.service.load())).toMatchObject({
      code: 'EMBEDDING_ENGINE_UNSUPPORTED',
    })
    expect(h.service.getStatus().state).toBe('unsupported')
    // Another provider's install cannot help.
    expect((await h.service.onEnginesChanged('llamacpp')).state).toBe('unsupported')
    await h.service.onEnginesChanged('llamacpp-upstream')
    await tick()
    await tick()
    expect(h.service.getStatus()).toMatchObject({ state: 'ready', pid: 2 })
    // Nothing to retry for a module that runs.
    expect((await h.service.onEnginesChanged()).state).toBe('ready')
  })

  it('skips a build readiness refused and runs the next one', async () => {
    const rejected: string[] = []
    let spawned = 0
    const handle = stubHandle(3)
    const h = harness({
      resolveEngine: async () => ({ ...ENGINE, path: `/packs/${spawned}/llama-server` }),
      rejectEngine: async (exe) => void rejected.push(exe),
      spawn: async () => {
        if (spawned++ === 0)
          throw new AtomicCoreError('EMBEDDING_ENGINE_UNSUPPORTED', 'no embeddings', 'answered 501')
        return handle
      },
    })
    await h.service.load()
    expect(rejected).toEqual(['/packs/0/llama-server'])
    expect(h.service.getStatus()).toMatchObject({ state: 'ready', engine: { path: '/packs/1/llama-server' } })
  })

  it('restarts with backoff after a crash, and gives up after too many', async () => {
    let n = 0
    const handles: Array<ReturnType<typeof stubHandle>> = []
    const h = harness({
      spawn: async () => {
        const handle = stubHandle(++n)
        handles.push(handle)
        return handle
      },
      now: () => 0,
    })
    await h.service.load()
    handles[0]!.die(139)
    await tick()
    expect(h.service.getStatus()).toMatchObject({
      state: 'restarting',
      restarts: 1,
      error: { code: 'EMBEDDING_UNAVAILABLE' },
    })
    expect(h.events.some((e) => e.name === 'embedding:error')).toBe(true)
    h.fire()
    await tick()
    await tick()
    expect(h.service.getStatus()).toMatchObject({ state: 'ready', pid: 2 })
    for (let i = 1; i <= MAX_RESTARTS; i++) {
      handles.at(-1)!.die(1)
      await tick()
      h.fire()
      await tick()
      await tick()
    }
    expect(h.service.getStatus()).toMatchObject({ state: 'failed', restarts: MAX_RESTARTS + 1 })
  })

  it('reports a restart that fails and keeps trying', async () => {
    let n = 0
    const first = stubHandle(1)
    const h = harness({
      spawn: async () => {
        if (n++ === 0) return first
        throw new AtomicCoreError('MODEL_LOAD_FAILED', 'out of memory')
      },
      now: () => 0,
    })
    await h.service.load()
    first.die(1)
    await tick()
    h.fire()
    await tick()
    await tick()
    expect(h.service.getStatus()).toMatchObject({
      state: 'restarting',
      restarts: 2,
      error: { message: 'out of memory' },
    })
  })

  it('follows settings: a launch change restarts, idle_unload does not, turning off stops', async () => {
    let n = 0
    const h = harness({ spawn: async () => stubHandle(++n) })
    await h.service.load()
    await h.service.configure({ idle_unload_secs: 60 })
    expect(h.service.getStatus().pid).toBe(1)
    expect(h.timers.filter((t) => !t.cancelled).map((t) => t.ms)).toContain(60_000)
    await h.service.configure({ ctx_size: 8192 })
    await tick()
    await tick()
    expect(h.service.getStatus()).toMatchObject({ state: 'ready', pid: 2 })
    await h.service.configure({ enabled: false })
    expect(h.service.getStatus()).toMatchObject({ state: 'disabled', pid: null })
    await h.service.configure({ enabled: true, model_path: '' })
    expect(h.service.getStatus()).toMatchObject({ state: 'idle', model_id: null })
  })

  it('unloads after idling, unless a request is in flight', async () => {
    const h = harness({ spawn: async () => stubHandle(1) }, { idle_unload_secs: 30 })
    await h.service.load()
    const target = await h.service.publicBackend().acquire(1_000)
    h.fire()
    await tick()
    expect(h.service.getStatus().state).toBe('ready')
    expect(target.ok).toBe(true)
    // A second release is a no-op: the in-flight count must not go negative.
    if (target.ok) {
      target.release()
      target.release()
    }
    h.fire()
    await tick()
    await tick()
    expect(h.service.getStatus().state).toBe('idle')
  })
})

describe('EmbeddingService public target', () => {
  it('starts an idle module for a request and waits for it', async () => {
    const h = harness({ spawn: async () => stubHandle(5) }, { model_id: 'embeddinggemma-2' })
    const backend = h.service.publicBackend()
    expect(backend.modelId()).toBe('embeddinggemma-2')
    const target = await backend.acquire(5_000)
    expect(target).toMatchObject({
      ok: true,
      port: 4005,
      apiKey: 'key-5',
      dims: 768,
      modalities: ['text', 'image', 'audio'],
    })
  })

  it('says why it cannot answer, without waiting on a state no start will leave', async () => {
    const off = harness({}, { enabled: false })
    expect(off.service.publicBackend().modelId()).toBeNull()
    expect(await off.service.publicBackend().acquire(5_000)).toMatchObject({ ok: false, reason: 'disabled' })

    const failing = harness({
      spawn: async () => {
        throw new AtomicCoreError('MODEL_LOAD_FAILED', 'bad weights')
      },
    })
    const target = await failing.service.publicBackend().acquire(5_000)
    expect(target).toMatchObject({
      ok: false,
      reason: 'failed',
      message: expect.stringContaining('bad weights'),
    })
    await tick()
    expect(failing.events.some((e) => e.name === 'embedding:error')).toBe(true)

    const gone = harness({ spawn: hangingSpawn })
    expect(await gone.service.publicBackend().acquire(5_000, AbortSignal.abort())).toMatchObject({
      ok: false,
    })
  })

  it('stops waiting at its deadline', async () => {
    const h = harness({ spawn: hangingSpawn })
    const pending = h.service.publicBackend().acquire(10)
    await tick()
    h.fire()
    expect(await pending).toMatchObject({ ok: false, reason: 'starting' })
  })

  it('retries an unsupported module in the background, quietly and not too often', async () => {
    let now = 0
    let calls = 0
    const h = harness({
      now: () => now,
      resolveEngine: async () => {
        calls++
        throw new AtomicCoreError('EMBEDDING_ENGINE_UNSUPPORTED', 'Update llama.cpp to b11454 or newer.')
      },
    })
    await rejection(h.service.load())
    const events = h.events.length
    await h.service.publicBackend().acquire(10)
    expect(calls).toBe(1)
    now = UNSUPPORTED_RETRY_MS + 1
    await h.service.publicBackend().acquire(10)
    await tick()
    await tick()
    expect(calls).toBe(2)
    expect(h.events.length).toBe(events)
  })
})

describe('EmbeddingService.embed', () => {
  it('sends the body under the running model name and hands back what the engine said', async () => {
    const sent: Array<{ url: string; body: unknown; apiKey: string | undefined }> = []
    const http: DecisionHttp = {
      request: async (url, init) => {
        sent.push({ url, body: JSON.parse(String(init.body)), apiKey: init.apiKey })
        return { status: 200, text: '{"object":"list","data":[{"embedding":[1,2],"index":0}]}' }
      },
    }
    const h = harness({ http, spawn: async () => stubHandle(7) })
    const answer = await h.service.embed({ input: ['hello'], model: 'whatever' })
    expect(answer).toEqual({ status: 200, body: { object: 'list', data: [{ embedding: [1, 2], index: 0 }] } })
    expect(sent).toEqual([
      {
        url: 'http://127.0.0.1:4007/v1/embeddings',
        body: { input: ['hello'], model: 'embeddinggemma-2-Q8_0' },
        apiKey: 'key-7',
      },
    ])
  })

  it('relays an answer that is not JSON, and refuses when the model cannot be reached', async () => {
    const text: DecisionHttp = { request: async () => ({ status: 500, text: 'boom' }) }
    const h = harness({ http: text, spawn: async () => stubHandle(8) })
    expect(await h.service.embed({ input: 'x' })).toEqual({ status: 500, body: 'boom' })

    const down: DecisionHttp = {
      request: async () => {
        throw new Error('socket hang up')
      },
    }
    const d = harness({ http: down, spawn: async () => stubHandle(9) })
    expect(await rejection<AtomicCoreError>(d.service.embed({ input: 'x' }))).toMatchObject({
      code: 'EMBEDDING_UNAVAILABLE',
      details: 'socket hang up',
    })
    const off = harness({}, { enabled: false })
    expect(await rejection<AtomicCoreError>(off.service.embed({ input: 'x' }))).toMatchObject({
      code: 'EMBEDDING_UNAVAILABLE',
      message: expect.stringContaining('turned off'),
    })
  })
})

describe('EmbeddingService shutdown', () => {
  it('stops the process and a start in flight, and emits nothing after', async () => {
    const h = harness({ spawn: realSpawn() })
    const status = await h.service.load()
    await h.service.shutdown()
    expect(isProcessAlive(status.pid as number)).toBe(false)
    const events = h.events.length
    await h.service.unload()
    expect(h.events.length).toBe(events)
    expect(await rejection<AtomicCoreError>(h.service.load())).toMatchObject({
      code: 'EMBEDDING_UNAVAILABLE',
    })
  })
})
