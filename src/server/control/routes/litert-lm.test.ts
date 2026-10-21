import { afterEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../../contracts/index.js'
import type { LiteRtLmAccelerators, LiteRtLmPrepareRequest } from '../../../contracts/index.js'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'

let h: ControlHarness | undefined
afterEach(() => h?.server.close())

const LIST: LiteRtLmAccelerators = {
  installed: true,
  build: '0.18.1/win-x64',
  npu: 'intel-lnl',
  accelerators: [
    { name: 'openvino', device: 'npu', version: '2026.4.1', size_bytes: 84964415, prepared: false },
  ],
  error: null,
}

async function harness() {
  const calls: string[] = []
  h = await start({
    liteRtLm: {
      accelerators: async () => {
        calls.push('list')
        return LIST
      },
      prepare: async (request: LiteRtLmPrepareRequest) => {
        calls.push(`prepare ${JSON.stringify(request)}`)
        if (request.accelerators?.includes('busy'))
          throw new AtomicCoreError('ENGINE_INSTALL_IN_PROGRESS', 'already preparing')
        return { accelerators: [{ name: 'openvino', prepared: true }] }
      },
    },
  })
  return { h, calls }
}

describe('litert-lm routes (task 6.4)', () => {
  it('answers the accelerators and prepares the ones named, or all, one prepare at a time', async () => {
    const { h, calls } = await harness()
    expect(await (await h.get('/atomic/v1/runtimes/litert-lm/accelerators')).json()).toEqual(LIST)
    const post = (body: unknown) =>
      h.get('/atomic/v1/runtimes/litert-lm/accelerators/prepare', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    expect(await (await post({ accelerators: ['openvino'] })).json()).toEqual({
      accelerators: [{ name: 'openvino', prepared: true }],
    })
    expect((await post({})).status).toBe(200)
    const proxy = { url: 'http://proxy.local:3128', ignore_ssl: true }
    expect((await post({ proxy })).status).toBe(200)
    const busy = await post({ accelerators: ['busy'] })
    expect(busy.status).toBe(409)
    expect(calls).toEqual([
      'list',
      'prepare {"accelerators":["openvino"]}',
      'prepare {}',
      `prepare ${JSON.stringify({ proxy })}`,
      'prepare {"accelerators":["busy"]}',
    ])
  })

  it('refuses a body it does not understand before anything runs', async () => {
    const { h, calls } = await harness()
    for (const body of [
      [],
      { accelerators: 'openvino' },
      { accelerators: [1] },
      { all: true },
      { proxy: 'x' },
    ]) {
      const res = await h.get('/atomic/v1/runtimes/litert-lm/accelerators/prepare', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(calls).toEqual([])
  })

  it('is not found where LiteRT-LM is not registered', async () => {
    h = await start()
    const res = await h.get('/atomic/v1/runtimes/litert-lm/accelerators')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: 'PROVIDER_NOT_FOUND' } })
  })
})

describe('POST /models/litert-lm/check (task 6.5)', () => {
  it('answers from the native check table', async () => {
    h = await start({
      nativeModelChecks: {
        'litert-lm': async () => ({ verdict: 'engine-not-installed', reason: 'LiteRT-LM is not installed.' }),
      },
    })
    const res = await h.get('/atomic/v1/models/litert-lm/check', {
      method: 'POST',
      body: JSON.stringify({ backend: 'cpu' }),
    })
    expect(await res.json()).toEqual({
      verdict: 'engine-not-installed',
      reason: 'LiteRT-LM is not installed.',
    })
  })
})
