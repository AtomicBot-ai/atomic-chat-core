import { afterEach, describe, expect, it } from 'vitest'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'
import type { ModelCompatibilityControl } from '../types.js'

let h: ControlHarness | undefined
afterEach(async () => {
  await h?.server.close()
  h = undefined
})

const FAMILIES = {
  rules_version: 3,
  families: [
    {
      id: 'bonsai-8b',
      title: 'Bonsai 8B',
      repo: 'prism-ml/Bonsai-8B-gguf',
      revision: 'abc',
      files: [
        {
          file: 'Bonsai-8B-PQ2_0.gguf',
          size: 1,
          sha256: 'a'.repeat(64),
          treatment: 'prism_required' as const,
        },
      ],
      projectors: [],
    },
  ],
}

function fakeCompatibility(calls: string[]): ModelCompatibilityControl {
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
    families: async () => {
      calls.push('families')
      return FAMILIES
    },
  }
}

const send = (method: string, path: string, body?: unknown) =>
  h!.get(`/atomic/v1${path}`, {
    method,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })

describe('model compatibility routes', () => {
  it('answers compatibility for a Hub file from the body', async () => {
    const calls: string[] = []
    h = await start({ modelCompatibility: fakeCompatibility(calls) })
    const compat = await send('POST', '/models/compatibility', {
      repo: 'o/r',
      file: 'f.gguf',
      inspect_remote: true,
    })
    expect(compat.status).toBe(200)
    expect(await compat.json()).toMatchObject({ outcome: 'compatible' })
    expect(calls).toEqual(['compatibility {"repo":"o/r","file":"f.gguf","inspect_remote":true}'])
  })

  it('answers compatibility for a model on disk by its id', async () => {
    const calls: string[] = []
    h = await start({ modelCompatibility: fakeCompatibility(calls) })
    const compat = await send('POST', '/models/compatibility', { model_id: 'o/m', provider: 'atomic-prism' })
    expect(compat.status).toBe(200)
    expect(calls).toEqual(['compatibility {"model_id":"o/m","provider":"atomic-prism"}'])
  })

  it('lists the Bonsai families for the Hub', async () => {
    const calls: string[] = []
    h = await start({ modelCompatibility: fakeCompatibility(calls) })
    const families = await send('GET', '/models/atomic-prism/families')
    expect(families.status).toBe(200)
    expect(await families.json()).toEqual(FAMILIES)
    expect(calls).toEqual(['families'])
  })

  it('refuses a body that is not an object', async () => {
    h = await start({ modelCompatibility: fakeCompatibility([]) })
    expect((await send('POST', '/models/compatibility', [1])).status).toBe(400)
  })

  it('answers INVALID_ARGUMENT in a core without it', async () => {
    h = await start()
    expect((await send('GET', '/models/atomic-prism/families')).status).toBe(400)
  })
})

describe('the removed model setup', () => {
  it.each([
    ['POST', '/models/setup-plan', { repo: 'o/r', file: 'f.gguf' }],
    ['POST', '/model-setups', { repo: 'o/r', file: 'f.gguf', request_id: 'r1', plan_digest: 'd' }],
    ['GET', '/model-setups', undefined],
    ['GET', '/model-setups/s1', undefined],
    ['POST', '/model-setups/s1/cancel', {}],
    ['POST', '/model-setups/s1/resume', {}],
  ] as const)('answers %s %s as an unknown route', async (method, path, body) => {
    const calls: string[] = []
    h = await start({ modelCompatibility: fakeCompatibility(calls) })
    const res = await send(method, path, body)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: { code: 'INVALID_ARGUMENT', message: `No such control route: /atomic/v1${path}` },
    })
    expect(calls).toEqual([])
  })

  it('leaves model_setups out of the snapshot', async () => {
    h = await start({ modelCompatibility: fakeCompatibility([]) })
    const snapshot = (await (await send('GET', '/snapshot')).json()) as Record<string, unknown>
    expect(snapshot).not.toHaveProperty('model_setups')
    expect(snapshot).toHaveProperty('downloads')
  })
})
