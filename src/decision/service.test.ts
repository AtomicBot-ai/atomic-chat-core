import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_DECISION_SETTINGS } from '../contracts/index.js'
import type { CoreEvents, DecisionEngineInfo, DecisionSettings, ExecutorCard } from '../contracts/index.js'
import { fakeDecisionSpawn } from '../../test/helpers/fake-llama-server.js'
import type { FakeLlamaOptions } from '../../test/helpers/fake-llama-server.js'
import { AtomicCoreError } from '../contracts/index.js'
import { isProcessAlive } from '../runtime/shared/index.js'
import { parseDecisionSettingsPatch } from '../settings/index.js'
import { MAX_RESTARTS } from './backoff.js'
import { createDecisionHttp } from './http.js'
import type { DecisionHttp } from './http.js'
import { spawnDecisionServer } from './process.js'
import type { DecisionProcessHandle, DecisionServerSpec } from './process.js'
import { DecisionService, UNSUPPORTED_RETRY_MS } from './service.js'
import type { DecisionServiceDeps } from './service.js'

/** A real directory: on Windows it is the engine's working directory, and a missing one fails the spawn. */
const PACK_DIR = mkdtempSync(join(tmpdir(), 'atomic-decision-pack-'))
afterAll(() => rmSync(PACK_DIR, { recursive: true, force: true }))

const ENGINE: DecisionEngineInfo = {
  path: join(PACK_DIR, 'llama-server'),
  version_backend: 'b10269-1.7.0/macos-arm64',
  fork_version: '1.7.0',
  version_gate: true,
  dialect: 'turboquant',
  provider: 'llamacpp',
}

const CARD: ExecutorCard = {
  schema: 'atomic.executor-card/1',
  name: 'Qwen3.5-4B local',
  kind: 'local',
  checks: [{ skill: 'field extraction', status: 'measured', passed: 188, total: 200 }],
}

interface Harness {
  service: DecisionService
  settings: DecisionSettings
  events: Array<{ name: string; payload: unknown }>
  states: () => string[]
  spawns: DecisionServerSpec[]
  timers: Array<{ fn: () => void; ms: number; cancelled: boolean }>
  /** Run every pending timer once. */
  fire: () => void
}

const services: DecisionService[] = []
afterEach(async () => {
  for (const s of services.splice(0)) await s.shutdown()
})

function harness(over: Partial<DecisionServiceDeps> = {}, settings: Partial<DecisionSettings> = {}): Harness {
  const current: DecisionSettings = {
    ...DEFAULT_DECISION_SETTINGS,
    enabled: true,
    model_path: '/models/laya.gguf',
    ...settings,
  }
  const events: Harness['events'] = []
  const spawns: DecisionServerSpec[] = []
  const timers: Harness['timers'] = []
  const service = new DecisionService({
    dataFolder: '/data',
    readSettings: () => ({ ...current }),
    writeSettings: async (patch) => void Object.assign(current, parseDecisionSettingsPatch(patch)),
    resolveEngine: async () => ENGINE,
    cpu: async () => ({ physicalCores: 8, hybrid: true }),
    spawn: async (spec) => {
      spawns.push(spec)
      throw new Error('no spawn in this test')
    },
    http: createDecisionHttp(),
    emit: <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) =>
      void events.push({ name, payload }),
    log: () => {},
    fileExists: async () => true,
    inspectModel: async () => ({ kind: 'file' }),
    readModelFacts: async () => ({ dialect: 'turboquant' }),
    pruneConvertCache: async () => {},
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
      events.filter((e) => e.name === 'decision:state').map((e) => (e.payload as { state: string }).state),
    spawns,
    timers,
    fire: () => {
      for (const t of timers.splice(0)) if (!t.cancelled) t.fn()
    },
  }
}

/** The real decision process: `spawnDecisionServer` over the fake engine. */
function realSpawn(
  options: FakeLlamaOptions = {},
  spawns: DecisionServerSpec[] = []
): DecisionServiceDeps['spawn'] {
  return (spec, signal) => {
    spawns.push(spec)
    return spawnDecisionServer(spec, {
      http: createDecisionHttp(),
      spawn: fakeDecisionSpawn(options),
      signal,
      pollIntervalMs: 25,
    })
  }
}

function stubHandle(pid: number): DecisionProcessHandle & { die: (code: number) => void } {
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
    props: { api_version: 1, layout: 'laya' },
    capabilities: ['decision', 'systemone'],
    tail: () => ['engine: last words'],
    exitStatus: () => exit,
    exited,
    terminate: async () => exit ?? end(0),
    die: (code) => void end(code),
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('DecisionService calls (fail-open)', () => {
  it('scores candidates through the running process', async () => {
    const spawns: DecisionServerSpec[] = []
    const h = harness({ spawn: realSpawn({}, spawns) })
    await h.service.load()
    const outcome = await h.service.scoreCandidates('Extract the invoice total', 'exact', [
      { id: 'local/qwen', card: CARD },
    ])
    expect(outcome.unavailable).toBe(false)
    expect(outcome.unavailable === false && outcome.result.scores).toEqual([
      expect.objectContaining({ id: 'local/qwen', p_success: 0.94, calibrated: true }),
    ])
    const answer = await h.service.decide('Billed twice, refund please', {
      refund: { type: 'noul', instructions: 'Asks for money back?' },
    })
    expect(answer.unavailable === false && answer.result.answers['refund']).toMatchObject({
      type: 'noul',
      noul: 0.75,
    })
    // Apple silicon with 8 physical cores: half of them, the performance cores.
    expect(spawns[0]).toMatchObject({ threads: 4, modelPath: '/models/laya.gguf', startupTimeoutMs: 60_000 })
  })

  it('answers timeout within its budget instead of waiting for a slow model, and never throws', async () => {
    const h = harness({ spawn: realSpawn({ decision: { delayMs: 2_000 } }) }, { timeout_ms: 150 })
    await h.service.load()
    const started = Date.now()
    const outcome = await h.service.scoreCandidates('t', 'c', [{ id: 'a', card: CARD }])
    expect(outcome).toMatchObject({ unavailable: true, reason: 'timeout' })
    expect(Date.now() - started).toBeLessThan(1_000)
    // A per-call budget overrides the setting.
    const quick = await h.service.decide('s', { q: { type: 'noul', instructions: 'x' } }, { timeoutMs: 50 })
    expect(quick).toMatchObject({
      unavailable: true,
      reason: 'timeout',
      message: expect.stringContaining('50 ms'),
    })
  })

  it("hands the engine's refusal back with its reason and path", async () => {
    const h = harness({ spawn: realSpawn() })
    await h.service.load()
    const outcome = await h.service.scoreCandidates('t', 'c', [
      { id: 'a', card: CARD },
      { id: 'a', card: CARD },
    ])
    expect(outcome).toMatchObject({
      unavailable: true,
      reason: 'rejected',
      status: 400,
      error: { reason: 'DUPLICATE_CANDIDATE_ID', param: 'candidates[1].id' },
    })
  })

  it('passes allow_uncalibrated to the engine, which otherwise refuses the router', async () => {
    const refused = harness({ spawn: realSpawn({ decision: { calibrated: false } }) })
    await refused.service.load()
    expect(refused.service.getStatus().props?.router?.available).toBe(false)
    // `/props` already said the router is off: answered without a request, so no engine status.
    const outcome0 = await refused.service.scoreCandidates('t', 'c', [{ id: 'a', card: CARD }])
    expect(outcome0).toMatchObject({ unavailable: true, reason: 'not_calibrated' })
    expect(outcome0.unavailable && outcome0.status).toBeUndefined()
    // systemone does not need the router calibration.
    expect(await refused.service.decide('s', { q: { type: 'noul', instructions: 'x' } })).toMatchObject({
      unavailable: false,
    })
    const allowed = harness(
      { spawn: realSpawn({ decision: { calibrated: false } }) },
      { allow_uncalibrated: true }
    )
    await allowed.service.load()
    const outcome = await allowed.service.scoreCandidates('t', 'c', [{ id: 'a', card: CARD }])
    expect(outcome.unavailable === false && outcome.result.scores[0]?.calibrated).toBe(false)
  })

  it('says why without calling anything when the module cannot answer', async () => {
    const disabled = harness({}, { enabled: false })
    expect(await disabled.service.scoreCandidates('t', 'c', [])).toMatchObject({ reason: 'disabled' })
    const unconfigured = harness({}, { model_path: '' })
    expect(await unconfigured.service.decide('s', {})).toMatchObject({ reason: 'not_configured' })
    expect(disabled.spawns).toEqual([])
    expect(unconfigured.spawns).toEqual([])
    const aborted = await disabled.service.scoreCandidates('t', 'c', [], { signal: AbortSignal.abort() })
    expect(aborted).toMatchObject({ reason: 'aborted', elapsed_ms: 0 })
  })

  it('starts an idle module on the first call and answers starting meanwhile', async () => {
    const handle = stubHandle(1)
    const h = harness({ spawn: async () => handle })
    expect(await h.service.scoreCandidates('t', 'c', [])).toMatchObject({ reason: 'starting' })
    await tick()
    await tick()
    expect(h.service.getStatus()).toMatchObject({ state: 'ready', pid: 1 })
  })

  it('reads a 501 as not_calibrated when /props did not say the router is off', async () => {
    const http: DecisionHttp = {
      request: async () => ({
        status: 501,
        text: '{"error":{"code":501,"type":"not_supported_error","reason":"ROUTER_NOT_CALIBRATED","message":"no"}}',
      }),
    }
    const h = harness({ http, spawn: async () => stubHandle(4) })
    await h.service.load()
    expect(await h.service.scoreCandidates('t', 'c', [{ id: 'a', card: CARD }])).toMatchObject({
      reason: 'not_calibrated',
      status: 501,
      error: { reason: 'ROUTER_NOT_CALIBRATED' },
    })
  })

  it("refuses a body that cannot be serialized as the caller's error, without a request", async () => {
    const sent: string[] = []
    const http: DecisionHttp = {
      request: async (url) => {
        sent.push(url)
        return { status: 200, text: '{"answers":{}}' }
      },
    }
    const h = harness({ http, spawn: async () => stubHandle(5) })
    await h.service.load()
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    for (const state of [{ amount: 10n }, cyclic])
      expect(await h.service.decide(state, {})).toMatchObject({
        unavailable: true,
        reason: 'rejected',
        message: expect.stringContaining('could not be serialized'),
      })
    expect(sent).toEqual([])
  })

  it('does not trust router scores that do not match the candidates in order', async () => {
    let scores: Array<{ id: string; p_success: number }> = []
    const http: DecisionHttp = {
      request: async () => ({ status: 200, text: JSON.stringify({ object: 'router.scores', scores }) }),
    }
    const h = harness({ http, spawn: async () => stubHandle(6) })
    await h.service.load()
    const candidates = [
      { id: 'a', card: CARD },
      { id: 'b', card: CARD },
    ]
    scores = [
      { id: 'b', p_success: 0.9 },
      { id: 'a', p_success: 0.1 },
    ]
    expect(await h.service.scoreCandidates('t', 'c', candidates)).toMatchObject({
      reason: 'invalid_response',
    })
    scores = [{ id: 'a', p_success: 0.9 }]
    expect(await h.service.scoreCandidates('t', 'c', candidates)).toMatchObject({
      reason: 'invalid_response',
    })
    scores = [
      { id: 'a', p_success: 0.9 },
      { id: 'b', p_success: 0.1 },
    ]
    expect(await h.service.scoreCandidates('t', 'c', candidates)).toMatchObject({ unavailable: false })
  })

  it('turns any transport failure into an outcome', async () => {
    const http: DecisionHttp = {
      request: async () => {
        throw new Error('socket hang up')
      },
    }
    const h = harness({ http, spawn: async () => stubHandle(2) })
    await h.service.load()
    expect(await h.service.scoreCandidates('t', 'c', [])).toMatchObject({
      unavailable: true,
      reason: 'transport_error',
      message: expect.stringContaining('socket hang up'),
    })
    const garbage: DecisionHttp = { request: async () => ({ status: 200, text: '<html>' }) }
    const g = harness({ http: garbage, spawn: async () => stubHandle(3) })
    await g.service.load()
    expect(await g.service.decide('s', {})).toMatchObject({ reason: 'invalid_response' })
  })
})

describe('DecisionService lifecycle', () => {
  it('reports each state change and the status shape', async () => {
    const h = harness({ spawn: async () => stubHandle(7) }, { model_path: 'decision/laya.gguf' })
    expect(h.service.getStatus()).toMatchObject({ state: 'idle', enabled: true, pid: null })
    const status = await h.service.load()
    expect(status).toMatchObject({
      state: 'ready',
      enabled: true,
      engine: ENGINE,
      pid: 7,
      port: 4007,
      props: { api_version: 1 },
      capabilities: ['decision', 'systemone'],
      restarts: 0,
      error: null,
    })
    expect(status.model_path).toMatch(/[\\/]data[\\/]decision[\\/]laya\.gguf$/)
    // The second `starting` carries the engine the gate chose, before the process exists.
    expect(h.states()).toEqual(['starting', 'starting', 'ready'])
    expect(h.events[1]?.payload).toMatchObject({ state: 'starting', engine: ENGINE, pid: null })
    await h.service.unload()
    expect(h.service.getStatus()).toMatchObject({ state: 'idle', pid: null })
  })

  it('fails a start on a missing model file and does not retry by itself', async () => {
    const h = harness({ inspectModel: async () => ({ kind: 'none' }) })
    await expect(h.service.load()).rejects.toMatchObject({ code: 'MODEL_FILE_NOT_FOUND' })
    expect(h.service.getStatus()).toMatchObject({ state: 'failed', error: { code: 'MODEL_FILE_NOT_FOUND' } })
    expect(h.timers).toEqual([])
    expect(await h.service.scoreCandidates('t', 'c', [])).toMatchObject({ reason: 'failed' })
  })

  it('reports an unsupported engine as its own state, and a background start as a decision:error', async () => {
    const h = harness({
      resolveEngine: async () => {
        throw new AtomicCoreError(
          'DECISION_ENGINE_UNSUPPORTED',
          'No installed engine build can run it.',
          'b1-1.6.0/cpu: no'
        )
      },
    })
    h.service.start()
    await tick()
    await tick()
    expect(h.service.getStatus()).toMatchObject({
      state: 'unsupported',
      error: { code: 'DECISION_ENGINE_UNSUPPORTED' },
    })
    expect(h.events.filter((e) => e.name === 'decision:error')).toEqual([
      { name: 'decision:error', payload: expect.objectContaining({ code: 'DECISION_ENGINE_UNSUPPORTED' }) },
    ])
    expect(await h.service.scoreCandidates('t', 'c', [])).toMatchObject({ reason: 'unsupported' })
  })

  it('restarts a process that died after it was ready, with backoff, and gives up after MAX_RESTARTS', async () => {
    const handles: Array<ReturnType<typeof stubHandle>> = []
    let failRestarts = false
    const h = harness({
      spawn: async () => {
        if (failRestarts) throw new AtomicCoreError('MODEL_LOAD_FAILED', 'exited while loading')
        const handle = stubHandle(handles.length + 10)
        handles.push(handle)
        return handle
      },
    })
    await h.service.load()
    handles[0]!.die(139)
    await tick()
    expect(h.service.getStatus()).toMatchObject({ state: 'restarting', restarts: 1, pid: null })
    expect(h.events.find((e) => e.name === 'decision:error')?.payload).toMatchObject({
      code: 'DECISION_UNAVAILABLE',
      message: expect.stringContaining('code 139'),
      details: 'engine: last words',
    })
    expect(h.timers.map((t) => t.ms)).toEqual([1_000])
    expect(await h.service.scoreCandidates('t', 'c', [])).toMatchObject({ reason: 'starting' })
    h.fire()
    await tick()
    await tick()
    expect(h.service.getStatus()).toMatchObject({ state: 'ready', pid: 11, restarts: 1 })

    // From here every restart fails: the delays double until the module gives up.
    failRestarts = true
    handles[1]!.die(1)
    const delays: number[] = []
    for (let i = 0; i < MAX_RESTARTS + 2; i++) {
      await tick()
      await tick()
      delays.push(...h.timers.filter((t) => !t.cancelled).map((t) => t.ms))
      h.fire()
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000])
    expect(h.service.getStatus()).toMatchObject({ state: 'failed', restarts: MAX_RESTARTS + 1 })
    // An explicit load starts over.
    failRestarts = false
    await h.service.load()
    expect(h.service.getStatus()).toMatchObject({ state: 'ready', restarts: 0 })
  })

  it('brings a killed real process back', async () => {
    const h = harness({ spawn: realSpawn() })
    const first = await h.service.load()
    process.kill(first.pid as number, 'SIGKILL')
    // The exit event arrives when the OS gets to it: poll (up to 5 s) instead of a fixed sleep.
    for (let i = 0; i < 200 && h.service.getStatus().state !== 'restarting'; i++)
      await new Promise((resolve) => setTimeout(resolve, 25))
    expect(h.service.getStatus().state).toBe('restarting')
    h.fire()
    for (let i = 0; i < 200 && h.service.getStatus().state !== 'ready'; i++)
      await new Promise((resolve) => setTimeout(resolve, 25))
    const second = h.service.getStatus()
    expect(second).toMatchObject({ state: 'ready', restarts: 1 })
    expect(second.pid).not.toBe(first.pid)
    expect(await h.service.decide('s', { q: { type: 'noul', instructions: 'x' } })).toMatchObject({
      unavailable: false,
    })
  })

  it('follows settings: a new model restarts it, turning it off stops it', async () => {
    const handles: Array<ReturnType<typeof stubHandle>> = []
    const h = harness({
      spawn: async (spec) => {
        const handle = stubHandle(handles.length + 20)
        handles.push(handle)
        h.spawns.push(spec)
        return handle
      },
    })
    await h.service.load()
    await h.service.configure({ idle_unload_secs: 60 })
    expect(h.service.getStatus().pid).toBe(20)
    await h.service.configure({ model_path: '/models/other.gguf', threads: 3 })
    await tick()
    await tick()
    expect(h.service.getStatus()).toMatchObject({ state: 'ready', pid: 21 })
    expect(h.spawns.at(-1)).toMatchObject({ modelPath: '/models/other.gguf', threads: 3 })
    expect(handles[0]!.exitStatus()).toBeDefined()
    await h.service.configure({ enabled: false })
    expect(h.service.getStatus()).toMatchObject({ state: 'disabled', pid: null })
    expect(handles[1]!.exitStatus()).toBeDefined()
    await expect(h.service.configure({ nonsense: 1 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('unloads after idling, but not while a call is in flight', async () => {
    const h = harness({ spawn: async () => stubHandle(30) }, { idle_unload_secs: 5 })
    await h.service.load()
    expect(h.timers.filter((t) => !t.cancelled).map((t) => t.ms)).toEqual([5_000])
    const target = await h.service.publicBackend().acquire(1_000)
    expect(target).toMatchObject({ ok: true, port: 4030, apiKey: 'key-30' })
    h.fire()
    expect(h.service.getStatus().state).toBe('ready')
    if (target.ok) target.release()
    h.fire()
    await tick()
    await tick()
    expect(h.service.getStatus()).toMatchObject({ state: 'idle', pid: null })
  })

  it('names the configured model for the public request log', () => {
    expect(harness({}, { model_id: 'laya' }).service.publicBackend().modelId?.()).toBe('laya')
    expect(harness({}, { model_id: '' }).service.publicBackend().modelId?.()).toBeNull()
  })

  it('starts a module for a public request and refuses when it cannot', async () => {
    const h = harness({ spawn: async () => stubHandle(40) })
    const target = await h.service.publicBackend().acquire(2_000)
    expect(target).toMatchObject({ ok: true, port: 4040 })
    const off = harness({}, { enabled: false })
    expect(await off.service.publicBackend().acquire(2_000)).toMatchObject({ ok: false, reason: 'disabled' })
    const broken = harness({ inspectModel: async () => ({ kind: 'none' }) })
    const refused = await broken.service.publicBackend().acquire(2_000)
    expect(refused).toMatchObject({ ok: false, reason: 'failed' })
    expect(refused.ok === false && refused.message).toContain('does not exist')
    // A start the public route triggered reports its failure like a call's does.
    await tick()
    expect(broken.events.filter((e) => e.name === 'decision:error')).toEqual([
      { name: 'decision:error', payload: expect.objectContaining({ code: 'MODEL_FILE_NOT_FOUND' }) },
    ])
  })

  it('makes a public request wait through a scheduled restart', async () => {
    const handles: Array<ReturnType<typeof stubHandle>> = []
    const h = harness({
      spawn: async () => {
        const handle = stubHandle(handles.length + 50)
        handles.push(handle)
        return handle
      },
    })
    await h.service.load()
    handles[0]!.die(139)
    await tick()
    expect(h.service.getStatus().state).toBe('restarting')
    const pending = h.service.publicBackend().acquire(30_000)
    await tick()
    // Only the restart timer fires (1 s), not the request's 30 s wait.
    const restart = h.timers.find((t) => t.ms === 1_000 && !t.cancelled)!
    restart.fn()
    const target = await pending
    expect(target).toMatchObject({ ok: true, port: 4051 })
    expect(h.timers.find((t) => t.ms === 30_000)?.cancelled).toBe(true)
  })

  it('stops waiting for a start when the client leaves, or when the wait runs out', async () => {
    let finish: (handle: DecisionProcessHandle) => void = () => {}
    const h = harness({ spawn: () => new Promise((resolve) => (finish = resolve)) })
    const client = new AbortController()
    const pending = h.service.publicBackend().acquire(30_000, client.signal)
    await tick()
    expect(h.service.getStatus().state).toBe('starting')
    client.abort()
    expect(await pending).toMatchObject({ ok: false, reason: 'starting' })
    const timedOut = h.service.publicBackend().acquire(5_000)
    await tick()
    h.timers.find((t) => t.ms === 5_000)!.fn()
    expect(await timedOut).toMatchObject({ ok: false, reason: 'starting' })
    // A client already gone does not start anything.
    const gone = harness({ spawn: async () => stubHandle(59) })
    expect(await gone.service.publicBackend().acquire(30_000, AbortSignal.abort())).toMatchObject({
      ok: false,
    })
    expect(gone.service.getStatus().state).toBe('idle')
    finish(stubHandle(58))
  })

  it('stops a start in flight on unload, and leaves nothing running on shutdown', async () => {
    const h = harness({ spawn: realSpawn({ decision: { loadMs: 60_000 } }) })
    const load = h.service.load()
    await new Promise((resolve) => setTimeout(resolve, 150))
    await h.service.unload()
    await expect(load).rejects.toMatchObject({ code: 'DECISION_UNAVAILABLE' })
    expect(h.service.getStatus().state).toBe('idle')

    const running = harness({ spawn: realSpawn() })
    const status = await running.service.load()
    const before = running.events.length
    await running.service.shutdown()
    expect(isProcessAlive(status.pid as number)).toBe(false)
    expect(running.events.length).toBe(before)
  })
})

describe('DecisionService follows the world while it starts', () => {
  it('keeps a start in flight across a settings write that does not touch the launch', async () => {
    const gates: Array<(handle: DecisionProcessHandle) => void> = []
    const h = harness({
      spawn: (spec) => {
        h.spawns.push(spec)
        return new Promise((resolve) => gates.push(resolve))
      },
    })
    const load = h.service.load()
    for (let i = 0; i < 5 && gates.length === 0; i++) await tick()
    expect(gates).toHaveLength(1)
    await h.service.configure({ timeout_ms: 900 })
    await h.service.configure({ idle_unload_secs: 30 })
    expect(h.spawns).toHaveLength(1)
    gates[0]!(stubHandle(60))
    expect(await load).toMatchObject({ state: 'ready', pid: 60 })
    // The idle timer uses the setting written during the start.
    expect(h.timers.filter((t) => !t.cancelled).map((t) => t.ms)).toEqual([30_000])
  })

  it('restarts a start in flight when a launch setting changes', async () => {
    const h = harness({ spawn: realSpawn({ decision: { loadMs: 60_000 } }) })
    const load = h.service.load()
    await new Promise((resolve) => setTimeout(resolve, 150))
    await h.service.configure({ threads: 3 })
    await expect(load).rejects.toMatchObject({ code: 'DECISION_UNAVAILABLE' })
    expect(h.service.getStatus().state).toBe('starting')
  })

  it('re-arms the idle unload when idle_unload_secs changes while ready', async () => {
    const h = harness({ spawn: async () => stubHandle(61) }, { idle_unload_secs: 0 })
    await h.service.load()
    expect(h.timers).toEqual([])
    await h.service.configure({ idle_unload_secs: 7 })
    expect(h.service.getStatus().pid).toBe(61)
    expect(h.timers.filter((t) => !t.cancelled).map((t) => t.ms)).toEqual([7_000])
    await h.service.configure({ idle_unload_secs: 0 })
    expect(h.timers.filter((t) => !t.cancelled)).toEqual([])
  })

  it('tries again when a TurboQuant build is installed, but only from unsupported or failed', async () => {
    let supported = false
    const h = harness({
      resolveEngine: async () => {
        if (!supported) throw new AtomicCoreError('DECISION_ENGINE_UNSUPPORTED', 'none', 'b1-1.6.0/cpu: no')
        return ENGINE
      },
      spawn: async () => stubHandle(62),
    })
    await expect(h.service.load()).rejects.toMatchObject({ code: 'DECISION_ENGINE_UNSUPPORTED' })
    expect(h.service.getStatus().state).toBe('unsupported')
    supported = true
    await h.service.onEnginesChanged()
    await tick()
    await tick()
    expect(h.service.getStatus()).toMatchObject({ state: 'ready', pid: 62 })
    const before = h.events.length
    expect(await h.service.onEnginesChanged()).toMatchObject({ state: 'ready', pid: 62 })
    expect(h.events.length).toBe(before)
  })

  it('retries an unsupported module from a call, quietly and at most once per UNSUPPORTED_RETRY_MS', async () => {
    let now = 1_000_000
    let resolves = 0
    let supported = false
    const h = harness({
      now: () => now,
      resolveEngine: async () => {
        resolves++
        if (!supported) throw new AtomicCoreError('DECISION_ENGINE_UNSUPPORTED', 'none')
        return ENGINE
      },
      spawn: async () => stubHandle(63),
    })
    h.service.start()
    await tick()
    await tick()
    expect(h.service.getStatus().state).toBe('unsupported')
    expect(resolves).toBe(1)
    const settled = h.events.length
    expect(await h.service.scoreCandidates('t', 'c', [])).toMatchObject({ reason: 'unsupported' })
    await tick()
    expect(resolves).toBe(1)
    now += UNSUPPORTED_RETRY_MS
    expect(await h.service.scoreCandidates('t', 'c', [])).toMatchObject({ reason: 'unsupported' })
    await tick()
    await tick()
    expect(resolves).toBe(2)
    // The same failure again is not a second decision:error, and not even a transient `starting`.
    expect(h.events.filter((e) => e.name === 'decision:error')).toHaveLength(1)
    expect(h.events.length).toBe(settled)
    // The retry kept its own clock: a call right after it does not retry again.
    await h.service.scoreCandidates('t', 'c', [])
    await tick()
    expect(resolves).toBe(2)
    now += UNSUPPORTED_RETRY_MS
    supported = true
    await h.service.scoreCandidates('t', 'c', [])
    await tick()
    await tick()
    expect(h.service.getStatus()).toMatchObject({ state: 'ready', pid: 63, engine: ENGINE })
    // A retry that gets somewhere goes straight from unsupported to ready.
    expect(h.states().slice(-2)).toEqual(['unsupported', 'ready'])
  })

  it('reports a quiet retry that fails differently', async () => {
    let now = 1_000_000
    let details = 'b1-1.6.0/cpu: no'
    const h = harness({
      now: () => now,
      resolveEngine: async () => {
        throw new AtomicCoreError('DECISION_ENGINE_UNSUPPORTED', 'none', details)
      },
    })
    h.service.start()
    await tick()
    await tick()
    now += UNSUPPORTED_RETRY_MS
    details = 'b2-1.8.0/cpu: refused at readiness: api_version 2'
    await h.service.scoreCandidates('t', 'c', [])
    await tick()
    await tick()
    expect(h.states()).toEqual(['starting', 'unsupported', 'unsupported'])
    expect(h.service.getStatus().error).toMatchObject({ details })
    // Still the same code: the app already heard about it, so no second decision:error.
    expect(h.events.filter((e) => e.name === 'decision:error')).toHaveLength(1)
  })

  it('tries refused engine builds again on load, on a new build and on new launch settings, not on a retry', async () => {
    let now = 1_000_000
    let forgets = 0
    const h = harness({
      now: () => now,
      forgetRejectedEngines: () => void forgets++,
      resolveEngine: async () => {
        throw new AtomicCoreError('DECISION_ENGINE_UNSUPPORTED', 'refused at readiness')
      },
    })
    h.service.start()
    await tick()
    await tick()
    expect(forgets).toBe(0)
    // A quiet retry from a call keeps the refusals.
    now += UNSUPPORTED_RETRY_MS
    await h.service.scoreCandidates('t', 'c', [])
    await tick()
    await tick()
    expect(forgets).toBe(0)
    await expect(h.service.load()).rejects.toMatchObject({ code: 'DECISION_ENGINE_UNSUPPORTED' })
    expect(forgets).toBe(1)
    await h.service.onEnginesChanged()
    await tick()
    await tick()
    expect(forgets).toBe(2)
    // A settings write that does not touch the launch keeps them; one that does forgets them.
    await h.service.configure({ timeout_ms: 900 })
    await tick()
    await tick()
    expect(forgets).toBe(2)
    await h.service.configure({ spec_path: '/models/other-spec.json' })
    await tick()
    await tick()
    expect(forgets).toBe(3)
  })

  it('skips an engine build that readiness refused and starts the next one', async () => {
    const newer: DecisionEngineInfo = { ...ENGINE, path: '/packs/b10400-1.8.0/cpu/llama-server' }
    const rejected: string[] = []
    const h = harness({
      resolveEngine: async () => (rejected.includes(newer.path) ? ENGINE : newer),
      rejectEngine: async (exe) => void rejected.push(exe),
      spawn: async (spec) => {
        h.spawns.push(spec)
        if (spec.engine.path === newer.path)
          throw new AtomicCoreError(
            'DECISION_ENGINE_UNSUPPORTED',
            'The engine started but does not serve decision API version 1.',
            `${newer.path}: api_version 2`
          )
        return stubHandle(64)
      },
    })
    expect(await h.service.load()).toMatchObject({ state: 'ready', pid: 64, engine: ENGINE })
    expect(rejected).toEqual([newer.path])
    expect(h.spawns.map((s) => s.engine.path)).toEqual([newer.path, ENGINE.path])

    // An explicit engine has nothing to fall back to.
    const explicit = harness(
      {
        resolveEngine: async () => newer,
        rejectEngine: async (exe) => void rejected.push(exe),
        spawn: async () => {
          throw new AtomicCoreError('DECISION_ENGINE_UNSUPPORTED', 'api_version 2')
        },
      },
      { engine_path: newer.path }
    )
    await expect(explicit.service.load()).rejects.toMatchObject({ code: 'DECISION_ENGINE_UNSUPPORTED' })
    expect(rejected).toEqual([newer.path])
    expect(explicit.service.getStatus().state).toBe('unsupported')
  })
})

describe('DecisionService with a checkpoint folder', () => {
  const FOLDER = 'decision/models/laya-multilingual'
  const CACHE = join('/data', 'decision', 'gguf-cache')
  const folderProps = (key: string) => ({
    api_version: 1,
    source: 'checkpoint-dir',
    cache_path: join(CACHE, key, 'laya-multilingual.gguf'),
    checkpoint: { cache_hit: false, convert_ms: 940 },
  })
  const withProps = (pid: number, props: DecisionProcessHandle['props']) => ({ ...stubHandle(pid), props })

  it('converts into the data folder cache, names the model and asks for a build with the converter', async () => {
    const needs: unknown[] = []
    const h = harness(
      {
        inspectModel: async () => ({ kind: 'checkpoint-dir', missing: [] }),
        resolveEngine: async (_path, need) => {
          needs.push(need)
          return ENGINE
        },
        spawn: async (spec) => {
          h.spawns.push(spec)
          return withProps(70, folderProps('k1'))
        },
      },
      { model_path: FOLDER }
    )
    expect(await h.service.load()).toMatchObject({ state: 'ready', props: { source: 'checkpoint-dir' } })
    expect(needs).toEqual([{ checkpointDir: true }])
    expect(h.spawns[0]).toMatchObject({
      modelPath: join('/data', FOLDER),
      modelId: 'laya-multilingual',
      convert: { cacheDir: CACHE, type: 'f16' },
    })
  })

  it('keeps the model_id it is given, and a GGUF gets no conversion', async () => {
    const spawns: DecisionServerSpec[] = []
    const spying = harness(
      {
        inspectModel: async () => ({ kind: 'checkpoint-dir', missing: [] }),
        spawn: async (spec) => {
          spawns.push(spec)
          return stubHandle(73)
        },
      },
      { model_path: FOLDER, model_id: 'laya' }
    )
    await spying.service.load()
    expect(spawns[0]?.modelId).toBe('laya')
    const ggufSpawns: DecisionServerSpec[] = []
    const plain = harness({
      spawn: async (spec) => {
        ggufSpawns.push(spec)
        return stubHandle(74)
      },
    })
    await plain.service.load()
    expect(ggufSpawns[0]?.convert).toBeUndefined()
    expect(ggufSpawns[0]?.modelId).toBeUndefined()
  })

  it('refuses an incomplete folder before any engine is looked for, naming the missing files', async () => {
    let resolved = 0
    const h = harness(
      {
        inspectModel: async () => ({ kind: 'checkpoint-dir', missing: ['model.safetensors'] }),
        resolveEngine: async () => {
          resolved++
          return ENGINE
        },
      },
      { model_path: FOLDER }
    )
    await expect(h.service.load()).rejects.toMatchObject({
      code: 'DECISION_CHECKPOINT_INCOMPLETE',
      details: expect.stringContaining('missing model.safetensors'),
    })
    expect(resolved).toBe(0)
    expect(h.service.getStatus()).toMatchObject({
      state: 'failed',
      error: { code: 'DECISION_CHECKPOINT_INCOMPLETE' },
    })
  })

  it('keeps only the conversion in use, and drops the cache when the model is removed', async () => {
    const pruned: Array<[string, string | undefined]> = []
    let pid = 80
    const h = harness(
      {
        inspectModel: async () => ({ kind: 'checkpoint-dir', missing: [] }),
        spawn: async () => withProps(pid++, folderProps(`key-${pid}`)),
        pruneConvertCache: async (dir, keep) => void pruned.push([dir, keep]),
      },
      { model_path: FOLDER }
    )
    await h.service.load()
    expect(pruned).toEqual([[CACHE, 'key-81']])
    await h.service.configure({ model_path: '' })
    expect(pruned.at(-1)).toEqual([CACHE, undefined])
  })

  it('restarts with the new type when convert_type changes', async () => {
    let pid = 90
    const h = harness(
      {
        inspectModel: async () => ({ kind: 'checkpoint-dir', missing: [] }),
        spawn: async (spec) => {
          h.spawns.push(spec)
          return withProps(pid++, folderProps('k'))
        },
      },
      { model_path: FOLDER }
    )
    await h.service.load()
    await h.service.configure({ convert_type: 'f32' })
    await h.service.load()
    expect(h.spawns.map((s) => s.convert?.type)).toEqual(['f16', 'f32'])
  })
})

describe('DecisionService with an upstream decision GGUF', () => {
  const UPSTREAM_ENGINE: DecisionEngineInfo = {
    path: join(PACK_DIR, 'llama-server'),
    version_backend: 'b11436/macos-arm64',
    fork_version: null,
    version_gate: true,
    dialect: 'upstream',
    provider: 'llamacpp-upstream',
  }
  const upstreamHandle = (pid: number): DecisionProcessHandle => ({
    ...stubHandle(pid),
    props: { api_version: 1, endpoints: ['/v1/systemone'], source: 'gguf' },
  })

  it('asks for a stock build at the model floor and starts it with its projector and context', async () => {
    const needs: unknown[] = []
    const h = harness(
      {
        readModelFacts: async () => ({ dialect: 'upstream', decisionType: 'clef', contextTrain: 262144 }),
        resolveEngine: async (_path, need) => {
          needs.push(need)
          return UPSTREAM_ENGINE
        },
        spawn: async (spec) => {
          h.spawns.push(spec)
          return upstreamHandle(80)
        },
      },
      {
        model_path: 'decision/models/clef-flash/Clef-Flash-Q4_K_M.gguf',
        mmproj_path: 'decision/models/clef-flash/mmproj-Clef-Flash-Q8_0.gguf',
        spec_path: 'never/checked.json',
      }
    )
    expect(await h.service.load()).toMatchObject({ state: 'ready', engine: { dialect: 'upstream' } })
    expect(needs).toEqual([{ dialect: 'upstream', minBuild: 11418 }])
    expect(h.spawns[0]).toMatchObject({
      modelPath: join('/data', 'decision/models/clef-flash/Clef-Flash-Q4_K_M.gguf'),
      upstream: {
        mmprojPath: join('/data', 'decision/models/clef-flash/mmproj-Clef-Flash-Q8_0.gguf'),
        ctxSize: 8192,
        wholePromptUbatch: true,
      },
    })
    // The spec is the fork's: it is neither checked nor passed for an upstream model.
    expect(h.spawns[0]?.specPath).toBeUndefined()
  })

  it('keeps the projector away from the fork and the text-only floor without one', async () => {
    const needs: unknown[] = []
    const fork = harness(
      {
        resolveEngine: async (_path, need) => {
          needs.push(need)
          return ENGINE
        },
        spawn: async (spec) => {
          fork.spawns.push(spec)
          return stubHandle(81)
        },
      },
      { mmproj_path: 'stray/mmproj.gguf' }
    )
    await fork.service.load()
    expect(fork.spawns[0]?.upstream).toBeUndefined()
    const text = harness({
      readModelFacts: async () => ({ dialect: 'upstream', decisionType: 'lev' }),
      resolveEngine: async (_path, need) => {
        needs.push(need)
        return UPSTREAM_ENGINE
      },
      spawn: async () => upstreamHandle(82),
    })
    await text.service.load()
    expect(needs).toEqual([{ checkpointDir: false }, { dialect: 'upstream', minBuild: 11370 }])
  })

  it('refuses a projector that is not on disk before any engine is looked for', async () => {
    let resolved = 0
    const h = harness(
      {
        readModelFacts: async () => ({ dialect: 'upstream', decisionType: 'openjev' }),
        fileExists: async (path) => !path.endsWith('mmproj.gguf'),
        resolveEngine: async () => {
          resolved++
          return UPSTREAM_ENGINE
        },
      },
      { mmproj_path: 'decision/models/openjev/mmproj.gguf' }
    )
    await expect(h.service.load()).rejects.toMatchObject({
      code: 'MODEL_FILE_NOT_FOUND',
      message: 'The decision model projector does not exist.',
    })
    expect(resolved).toBe(0)
  })

  it('answers the router as unsupported without a request: upstream serves systemone only', async () => {
    const h = harness({
      readModelFacts: async () => ({ dialect: 'upstream', decisionType: 'laya' }),
      spawn: async () => upstreamHandle(83),
    })
    await h.service.load()
    const outcome = await h.service.scoreCandidates('t', 'c', [{ id: 'a', card: CARD }])
    expect(outcome).toMatchObject({
      unavailable: true,
      reason: 'unsupported',
      message: 'The running decision model does not serve /v1/router/score.',
    })
    const target = await h.service.publicBackend().acquire(1_000)
    expect(target).toMatchObject({ ok: true, endpoints: ['/v1/systemone'] })
    if (target.ok) target.release()
  })

  it('retries after an install of the provider its model needs, and ignores the other one', async () => {
    let installed = false
    let resolves = 0
    const h = harness({
      readModelFacts: async () => ({ dialect: 'upstream', decisionType: 'kev' }),
      resolveEngine: async () => {
        resolves++
        if (!installed) throw new AtomicCoreError('DECISION_ENGINE_UNSUPPORTED', 'Update llama.cpp')
        return UPSTREAM_ENGINE
      },
      spawn: async () => upstreamHandle(84),
    })
    await expect(h.service.load()).rejects.toMatchObject({ code: 'DECISION_ENGINE_UNSUPPORTED' })
    installed = true
    await h.service.onEnginesChanged('llamacpp')
    await tick()
    expect(resolves).toBe(1)
    expect(h.service.getStatus().state).toBe('unsupported')
    await h.service.onEnginesChanged('llamacpp-upstream')
    await tick()
    await tick()
    expect(h.service.getStatus()).toMatchObject({ state: 'ready', pid: 84 })
  })
})
