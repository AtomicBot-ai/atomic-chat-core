import { afterEach, describe, expect, it } from 'vitest'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'
import { AtomicCoreError } from '../../../contracts/index.js'
import type { ModelSetup } from '../../../contracts/index.js'
import type { ModelSetupControl } from '../types.js'

let h: ControlHarness | undefined
afterEach(async () => {
  await h?.server.close()
  h = undefined
})

const SETUP = {
  setup_id: 's1',
  request_id: 'r1',
  revision: 0,
  stage: 'queued',
  request: { repo: 'o/r', file: 'f.gguf' },
  plan: { digest: 'd', model_id: 'o/f' },
  task_ids: { model: 'model-setup-s1-model' },
  created_at: 1,
  updated_at: 1,
} as unknown as ModelSetup

function fakeSetups(calls: string[], over: Partial<ModelSetupControl> = {}): ModelSetupControl {
  return {
    compatibility: async (request) => {
      calls.push(`compatibility ${JSON.stringify(request)}`)
      return {
        outcome: 'compatible',
        provider: null,
        requires: [],
        evidence: 'rules',
        rules_version: 1,
        reason: 'ok',
      }
    },
    plan: async (request) => {
      calls.push(`plan ${JSON.stringify(request)}`)
      return SETUP.plan
    },
    start: async (request) => {
      calls.push(`start ${request.request_id}`)
      return SETUP
    },
    list: async () => [SETUP],
    get: async (id) => {
      if (id !== 's1') throw new AtomicCoreError('MODEL_SETUP_NOT_FOUND', 'No such model setup.', id)
      return SETUP
    },
    cancel: async (id) => {
      calls.push(`cancel ${id}`)
      return { ...SETUP, stage: 'cancelled' }
    },
    resume: async (id, options) => {
      calls.push(`resume ${id} ${JSON.stringify(options)}`)
      return SETUP
    },
    snapshot: () => [SETUP],
    ...over,
  }
}

const send = (method: string, path: string, body?: unknown) =>
  h!.get(`/atomic/v1${path}`, {
    method,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })

describe('model-setup routes', () => {
  it('answers compatibility and the plan from the body', async () => {
    const calls: string[] = []
    h = await start({ modelSetups: fakeSetups(calls) })
    const compat = await send('POST', '/models/compatibility', {
      repo: 'o/r',
      file: 'f.gguf',
      inspect_remote: true,
    })
    expect(compat.status).toBe(200)
    expect(await compat.json()).toMatchObject({ outcome: 'compatible' })
    expect(await (await send('POST', '/models/setup-plan', { repo: 'o/r', file: 'f.gguf' })).json()).toEqual(
      SETUP.plan
    )
    expect(calls).toEqual([
      'compatibility {"repo":"o/r","file":"f.gguf","inspect_remote":true}',
      'plan {"repo":"o/r","file":"f.gguf"}',
    ])
  })

  it('starts with 202, lists, reads, cancels and resumes', async () => {
    const calls: string[] = []
    h = await start({ modelSetups: fakeSetups(calls) })
    const started = await send('POST', '/model-setups', {
      repo: 'o/r',
      file: 'f.gguf',
      request_id: 'r1',
      plan_digest: 'd',
    })
    expect(started.status).toBe(202)
    expect(await (await send('GET', '/model-setups')).json()).toEqual({ setups: [SETUP] })
    expect(await (await send('GET', '/model-setups/s1')).json()).toEqual(SETUP)
    expect(await (await send('POST', '/model-setups/s1/cancel')).json()).toMatchObject({ stage: 'cancelled' })
    expect((await send('POST', '/model-setups/s1/resume')).status).toBe(200)
    expect(calls).toEqual(['start r1', 'cancel s1', 'resume s1 {"proxy":null}'])
  })

  it('carries a setup error code and status, and refuses a body that is not an object', async () => {
    h = await start({
      modelSetups: fakeSetups([], {
        start: async () => {
          throw new AtomicCoreError('MODEL_SETUP_PLAN_STALE', 'changed', '{"digest":"e"}')
        },
      }),
    })
    const stale = await send('POST', '/model-setups', { request_id: 'r1', plan_digest: 'd' })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({
      error: { code: 'MODEL_SETUP_PLAN_STALE', message: 'changed', details: '{"digest":"e"}' },
    })
    expect((await send('GET', '/model-setups/nope')).status).toBe(404)
    expect((await send('POST', '/models/setup-plan', [1])).status).toBe(400)
  })

  it('puts the setups in the snapshot', async () => {
    h = await start({ modelSetups: fakeSetups([]) })
    const snapshot = (await (await send('GET', '/snapshot')).json()) as { model_setups: ModelSetup[] }
    expect(snapshot.model_setups).toEqual([SETUP])
  })

  it('answers INVALID_ARGUMENT in a core without the setup', async () => {
    h = await start()
    expect((await send('GET', '/model-setups')).status).toBe(400)
    const snapshot = (await (await send('GET', '/snapshot')).json()) as { model_setups: ModelSetup[] }
    expect(snapshot.model_setups).toEqual([])
  })
})
