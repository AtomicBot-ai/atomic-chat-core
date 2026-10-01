import { afterEach, describe, expect, it } from 'vitest'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'
import { AtomicCoreError, DEFAULT_DECISION_SETTINGS } from '../../../contracts/index.js'
import type { DecisionSettings, DecisionStatus } from '../../../contracts/index.js'
import type { DecisionControl } from '../types.js'

let h: ControlHarness | undefined
afterEach(async () => {
  await h?.server.close()
  h = undefined
})

const STATUS: DecisionStatus = {
  state: 'ready',
  enabled: true,
  model_path: '/m/laya.gguf',
  engine: null,
  pid: 42,
  port: 3999,
  props: { api_version: 1 },
  capabilities: ['decision'],
  restarts: 0,
  error: null,
  since: 1,
}

function fakeDecision(calls: string[], over: Partial<DecisionControl> = {}): DecisionControl {
  let settings: DecisionSettings = { ...DEFAULT_DECISION_SETTINGS }
  return {
    status: () => ({ ...STATUS, enabled: settings.enabled }),
    config: () => settings,
    configure: async (patch) => {
      calls.push(`configure ${JSON.stringify(patch)}`)
      settings = { ...settings, ...(patch as Partial<DecisionSettings>) }
      return STATUS
    },
    load: async () => {
      calls.push('load')
      return STATUS
    },
    unload: async () => {
      calls.push('unload')
      return { ...STATUS, state: 'idle', pid: null, port: null }
    },
    score: async (request) => {
      calls.push(`score ${JSON.stringify(request)}`)
      return { unavailable: true, reason: 'timeout', message: 'slow', elapsed_ms: 500 }
    },
    decide: async (request) => {
      calls.push(`decide ${JSON.stringify(request)}`)
      return { unavailable: false, result: { answers: {} } as never, elapsed_ms: 3 }
    },
    ...over,
  }
}

const send = (method: string, path: string, body?: unknown) =>
  h!.get(`/atomic/v1/decision/${path}`, {
    method,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })

describe('decision routes', () => {
  it('answers status and configuration', async () => {
    const calls: string[] = []
    h = await start({ decision: fakeDecision(calls) })
    expect(await (await send('GET', 'status')).json()).toMatchObject({ state: 'ready', pid: 42 })
    const config = (await (await send('GET', 'config')).json()) as {
      config: DecisionSettings
      status: DecisionStatus
    }
    expect(config.config).toEqual(DEFAULT_DECISION_SETTINGS)
    expect(config.status.state).toBe('ready')
  })

  it('writes a settings patch and answers the new configuration', async () => {
    const calls: string[] = []
    h = await start({ decision: fakeDecision(calls) })
    const res = await send('PUT', 'config', { enabled: true, model_path: '/m/laya.gguf' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      config: { enabled: true, model_path: '/m/laya.gguf' },
      status: { enabled: true },
    })
    expect(calls).toEqual(['configure {"enabled":true,"model_path":"/m/laya.gguf"}'])
    expect((await send('PUT', 'config', [1])).status).toBe(400)
  })

  it('loads and unloads, and a failed load keeps its code and status', async () => {
    const calls: string[] = []
    h = await start({ decision: fakeDecision(calls) })
    expect(await (await send('POST', 'load')).json()).toMatchObject({ state: 'ready' })
    expect(await (await send('POST', 'unload')).json()).toMatchObject({ state: 'idle' })
    expect(calls).toEqual(['load', 'unload'])
    await h.server.close()
    h = await start({
      decision: fakeDecision([], {
        load: async () => {
          throw new AtomicCoreError(
            'DECISION_ENGINE_UNSUPPORTED',
            'No engine can run it.',
            'b1-1.6.0/cpu: no'
          )
        },
      }),
    })
    const failed = await send('POST', 'load')
    expect(failed.status).toBe(409)
    expect(await failed.json()).toEqual({
      error: {
        code: 'DECISION_ENGINE_UNSUPPORTED',
        message: 'No engine can run it.',
        details: 'b1-1.6.0/cpu: no',
      },
    })
  })

  it('answers score and decide with the fail-open outcome and 200 once the body parses', async () => {
    const calls: string[] = []
    h = await start({ decision: fakeDecision(calls) })
    const candidates = [{ id: 'local/qwen', card: { name: 'Qwen', kind: 'local' } }]
    const score = await send('POST', 'score', { task: 't', criterion: 'c', candidates, timeout_ms: 300 })
    expect(score.status).toBe(200)
    expect(await score.json()).toEqual({
      unavailable: true,
      reason: 'timeout',
      message: 'slow',
      elapsed_ms: 500,
    })
    const decide = await send('POST', 'decide', {
      state: 's',
      questions: { q: { type: 'noul', instructions: 'x' } },
    })
    expect(await decide.json()).toEqual({ unavailable: false, result: { answers: {} }, elapsed_ms: 3 })
    expect(calls).toEqual([
      `score ${JSON.stringify({ task: 't', criterion: 'c', candidates, timeout_ms: 300 })}`,
      `decide ${JSON.stringify({ state: 's', questions: { q: { type: 'noul', instructions: 'x' } } })}`,
    ])
  })

  it('refuses a malformed body before calling anything', async () => {
    const calls: string[] = []
    h = await start({ decision: fakeDecision(calls) })
    const res = await send('POST', 'score', { task: 't', candidates: [] })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } })
    expect((await send('POST', 'decide', { questions: {} })).status).toBe(400)
    expect(calls).toEqual([])
  })

  it('answers 503 on every route of a core without the module', async () => {
    h = await start()
    const res = await send('GET', 'status')
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: 'DECISION_UNAVAILABLE' } })
    expect((await send('POST', 'score', { task: 't', criterion: 'c', candidates: [] })).status).toBe(503)
  })
})
