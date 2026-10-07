import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { fakeDecisionSpawn } from '../../test/helpers/fake-llama-server.js'
import type { FakeLlamaOptions } from '../../test/helpers/fake-llama-server.js'
import { isProcessAlive } from '../runtime/shared/index.js'
import { createDecisionHttp, DecisionTimeoutError } from './http.js'
import type { DecisionHttp } from './http.js'
import { decisionArgsFor, earlyExitError, spawnDecisionServer } from './process.js'
import type { DecisionProcessHandle, DecisionServerSpec } from './process.js'

/** The error a promise rejects with; a promise that resolves fails the test. */
const rejection = <T>(p: Promise<unknown>): Promise<T> =>
  p.then(
    () => {
      throw new Error('expected a rejection')
    },
    (e: unknown) => e as T
  )

/**
 * The pack directory must exist: on Windows it is the child's working directory, and a missing one
 * fails the spawn with ENOENT. The fake replaces only the executable, not the pack around it.
 */
const PACK_DIR = mkdtempSync(join(tmpdir(), 'atomic-decision-pack-'))
afterAll(() => rmSync(PACK_DIR, { recursive: true, force: true }))

const handles: DecisionProcessHandle[] = []
afterEach(async () => {
  for (const h of handles.splice(0)) await h.terminate(0)
})

const spec = (over: Partial<DecisionServerSpec> = {}): DecisionServerSpec => ({
  engine: {
    path: join(PACK_DIR, 'llama-server'),
    version_backend: null,
    fork_version: null,
    version_gate: null,
    dialect: 'turboquant',
    provider: null,
  },
  modelPath: '/models/laya-multilingual-Q8_0.gguf',
  modelId: 'atomic/router-laya',
  threads: 2,
  startupTimeoutMs: 4_000,
  ...over,
})

function start(options: FakeLlamaOptions = {}, over: Partial<DecisionServerSpec> = {}, extra = {}) {
  const events: string[] = []
  const lines: Array<{ provider: string; model: string; line: string }> = []
  const run = spawnDecisionServer(spec(over), {
    http: createDecisionHttp(),
    spawn: fakeDecisionSpawn(options),
    pollIntervalMs: 25,
    onSpawned: async (pid, port) => void events.push(`spawned ${pid > 0} ${port > 0}`),
    onGone: async () => void events.push('gone'),
    backendOutput: (line) => lines.push(line),
    ...extra,
  }).then((handle) => {
    handles.push(handle)
    return handle
  })
  return { run, events, lines }
}

describe('spawnDecisionServer', () => {
  it('starts the engine, passes the readiness chain and keeps the key out of argv', async () => {
    const { run, events, lines } = start()
    const handle = await run
    expect(handle.props).toMatchObject({ api_version: 1, layout: 'laya', model_id: 'atomic/router-laya' })
    // An additive field of a newer engine is kept, not refused.
    expect(handle.props['future_field']).toEqual({ added_by: 'a newer engine' })
    expect(handle.capabilities).toEqual(['decision', 'systemone', 'router_score'])
    expect(handle.baseUrl).toBe(`http://127.0.0.1:${handle.port}`)
    expect(events).toEqual(['spawned true true'])
    expect(lines.some((l) => l.provider === 'decision' && l.model === 'atomic/router-laya')).toBe(true)
    // The key gates everything but the public routes, and it is the one the handle carries.
    expect((await fetch(`${handle.baseUrl}/props`)).status).toBe(401)
    const props = await fetch(`${handle.baseUrl}/props`, {
      headers: { authorization: `Bearer ${handle.apiKey}` },
    })
    expect(
      ((await props.json()) as { decision: { plan: { n_threads: number } } }).decision.plan.n_threads
    ).toBe(2)
    expect((await fetch(`${handle.baseUrl}/v1/models`)).status).toBe(200)
    expect(handle.apiKey.length).toBeGreaterThan(20)
    await handle.terminate()
    expect(handle.exitStatus()).toBeDefined()
  })

  it('keeps LLAMA_ARG_DECISION_* of the owner out of the engine environment', async () => {
    let seen: Record<string, string | undefined> = {}
    const fake = fakeDecisionSpawn()
    const handle = await start(
      {},
      {},
      {
        env: { ...process.env, LLAMA_ARG_DECISION_DEBUG: '1', LLAMA_ARG_DECISION_QUEUE: '64' },
        spawn: (s: Parameters<typeof fake>[0], onLine: Parameters<typeof fake>[1]) => {
          seen = { ...s.env }
          return fake(s, onLine)
        },
      }
    ).run
    expect(seen['LLAMA_ARG_DECISION_DEBUG']).toBeUndefined()
    expect(seen['LLAMA_ARG_DECISION_QUEUE']).toBeUndefined()
    expect(seen['LLAMA_API_KEY']).toBe(handle.apiKey)
  })

  it('polls /health while the engine loads', async () => {
    const handle = await start({ decision: { loadMs: 300 } }).run
    expect(handle.props.api_version).toBe(1)
  })

  it('keeps polling through a slow /props and a 5xx on /v1/models, and ends ready', async () => {
    const real = createDecisionHttp()
    const asked: string[] = []
    let slowProps = 3
    let busyModels = 2
    const http: DecisionHttp = {
      request: async (url, init) => {
        const path = new URL(url).pathname
        asked.push(path)
        if (path === '/v1/models' && busyModels > 0) {
          busyModels--
          return { status: 500, text: 'busy' }
        }
        if (path === '/props' && slowProps > 0) {
          slowProps--
          throw new DecisionTimeoutError(init.timeoutMs)
        }
        return real.request(url, init)
      },
    }
    const handle = await start({}, {}, { http }).run
    expect(handle.props.api_version).toBe(1)
    // Three timed-out answers, then the good one: none of them was taken for a verdict.
    expect(asked.filter((p) => p === '/props')).toHaveLength(4)
  })

  it('refuses a server that speaks another decision API version, and kills it', async () => {
    const { run, events } = start({ decision: { apiVersion: 2 } })
    const error = await rejection<{ code: string; details: string }>(run)
    expect(error).toMatchObject({ code: 'DECISION_ENGINE_UNSUPPORTED' })
    expect(error.details).toContain('api_version 2')
    expect(events).toEqual(['spawned true true', 'gone'])
  })

  it('refuses a healthy server without the decision capability', async () => {
    const error = await rejection(start({ decision: { noCapability: true } }).run)
    expect(error).toMatchObject({ code: 'DECISION_ENGINE_UNSUPPORTED' })
  })

  it("reports an older build's exit with its own last lines", async () => {
    const { run, events } = start({ decision: false })
    const error = await rejection<{ code: string; message: string; details: string }>(run)
    expect(error).toMatchObject({ code: 'MODEL_LOAD_FAILED' })
    expect(error.message).toContain('code 1')
    expect(error.details).toContain('invalid argument: --decision')
    expect(events).toContain('gone')
  })

  it('times out a start that never becomes ready, and the child is gone', async () => {
    let pid = 0
    const { run } = start(
      { decision: { loadMs: 60_000 } },
      { startupTimeoutMs: 400 },
      {
        onSpawned: async (p: number) => void (pid = p),
      }
    )
    const error = await rejection(run)
    expect(error).toMatchObject({ code: 'MODEL_LOAD_TIMED_OUT' })
    expect(isProcessAlive(pid)).toBe(false)
  })

  it('stops a start when its signal fires', async () => {
    const controller = new AbortController()
    const { run } = start({ decision: { loadMs: 60_000 } }, {}, { signal: controller.signal })
    setTimeout(() => controller.abort(), 150)
    await expect(run).rejects.toMatchObject({ code: 'DECISION_UNAVAILABLE' })
  })

  it('kills the child when the journal write fails', async () => {
    let pid = 0
    const { run } = start(
      {},
      {},
      {
        onSpawned: async (p: number) => {
          pid = p
          throw new Error('journal is read-only')
        },
      }
    )
    await expect(run).rejects.toThrow('journal is read-only')
    expect(isProcessAlive(pid)).toBe(false)
  })
})

describe('earlyExitError', () => {
  it('names the exit and keeps the last twenty lines', () => {
    const tail = Array.from({ length: 30 }, (_, i) => `line ${i}`)
    const error = earlyExitError({ code: null, signal: 'SIGSEGV' }, tail)
    expect(error.message).toContain('signal SIGSEGV')
    expect(error.details?.split('\n')).toHaveLength(20)
    expect(earlyExitError({ code: 1, signal: null }, []).details).toBeUndefined()
  })
})

describe('spawnDecisionServer on upstream llama.cpp', () => {
  const upstreamEngine = {
    path: join(PACK_DIR, 'llama-server'),
    version_backend: 'b11436/macos-arm64',
    fork_version: null,
    version_gate: true,
    dialect: 'upstream' as const,
    provider: 'llamacpp-upstream' as const,
  }

  it('starts stock llama.cpp without --decision and is ready once /v1/models lists decisions', async () => {
    const { run } = start(
      { decision: { upstream: true } },
      {
        engine: upstreamEngine,
        modelPath: '/models/Clef-Flash-Q4_K_M.gguf',
        modelId: 'clef-flash',
        upstream: { mmprojPath: '/models/mmproj.gguf', ctxSize: 4096, wholePromptUbatch: true },
      }
    )
    const handle = await run
    expect(handle.props).toMatchObject({
      endpoints: ['/v1/systemone'],
      model_id: 'clef-flash',
      input_modalities: ['text', 'image'],
    })
    expect(handle.capabilities).toEqual(['decision', 'systemone'])
    const answer = await fetch(`${handle.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${handle.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'hi', questions: { q: { type: 'noul', instructions: 'greeting?' } } }),
    })
    expect(await answer.json()).toMatchObject({ answers: { q: { noul: 0.75 } }, usage: { output_tokens: 0 } })
  })

  it('refuses a stock server whose model is not a decision model', async () => {
    const { run } = start({ decision: { upstream: true, noCapability: true } }, { engine: upstreamEngine })
    await expect(run).rejects.toMatchObject({
      code: 'DECISION_ENGINE_UNSUPPORTED',
      message: 'The engine started but does not serve the model as a decision model.',
    })
  })

  it('builds the argv by dialect', () => {
    expect(decisionArgsFor(spec(), 7)[0]).toBe('--decision')
    const argv = decisionArgsFor(spec({ engine: upstreamEngine }), 7)
    expect(argv).not.toContain('--decision')
    expect(argv.slice(0, 2)).toEqual(['-m', '/models/laya-multilingual-Q8_0.gguf'])
    expect(argv).toEqual(expect.arrayContaining(['-c', '8192']))
  })
})
