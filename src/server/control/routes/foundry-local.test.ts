import { foundryLocalVerdict, parseFoundryLocalCheckRequest } from '../../../runtime/foundry-local/index.js'
import { afterEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../../contracts/index.js'
import type { FoundryLocalAccelerators, FoundryLocalPrepareRequest } from '../../../contracts/index.js'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'

let h: ControlHarness | undefined
afterEach(() => h?.server.close())

const LIST: FoundryLocalAccelerators = {
  installed: true,
  build: 'v2.1.0/win-x64',
  version: '2.1.0',
  c_api_version: 2,
  probed_at: 1,
  accelerators: [
    { name: 'OpenVINOExecutionProvider', execution_provider: 'openvino', device: 'gpu/npu', prepared: false },
  ],
  error: null,
}

async function harness() {
  const calls: string[] = []
  h = await start({
    foundryLocal: {
      accelerators: async (force) => {
        calls.push(`list force=${String(force)}`)
        return LIST
      },
      prepare: async (request: FoundryLocalPrepareRequest) => {
        calls.push(`prepare ${JSON.stringify(request)}`)
        if (request.accelerators?.includes('busy'))
          throw new AtomicCoreError('ENGINE_INSTALL_IN_PROGRESS', 'already preparing')
        return { accelerators: [{ name: 'OpenVINOExecutionProvider', prepared: true }] }
      },
    },
  })
  return { h, calls }
}

describe('foundry-local routes (task 6.4)', () => {
  it('answers the accelerators, probing again only when asked to', async () => {
    const { h, calls } = await harness()
    expect(await (await h.get('/atomic/v1/runtimes/foundry-local/accelerators')).json()).toEqual(LIST)
    await h.get('/atomic/v1/runtimes/foundry-local/accelerators?force=1')
    expect(calls).toEqual(['list force=false', 'list force=true'])
  })

  it('prepares the accelerators named, or all of them, and says when one prepare already runs', async () => {
    const { h, calls } = await harness()
    const post = (body: unknown) =>
      h.get('/atomic/v1/runtimes/foundry-local/accelerators/prepare', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    expect(await (await post({ accelerators: ['OpenVINOExecutionProvider'] })).json()).toEqual({
      accelerators: [{ name: 'OpenVINOExecutionProvider', prepared: true }],
    })
    expect((await post({})).status).toBe(200)
    const busy = await post({ accelerators: ['busy'] })
    expect(busy.status).toBe(409)
    expect(await busy.json()).toMatchObject({ error: { code: 'ENGINE_INSTALL_IN_PROGRESS' } })
    expect(calls).toEqual([
      'prepare {"accelerators":["OpenVINOExecutionProvider"]}',
      'prepare {}',
      'prepare {"accelerators":["busy"]}',
    ])
  })

  it('refuses a body it does not understand before anything runs', async () => {
    const { h, calls } = await harness()
    for (const body of [
      [],
      { accelerators: 'CUDAExecutionProvider' },
      { accelerators: [1] },
      { accelerators: [''] },
      { all: true },
    ]) {
      const res = await h.get('/atomic/v1/runtimes/foundry-local/accelerators/prepare', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(calls).toEqual([])
  })

  it('answers PROVIDER_NOT_FOUND where this core has no Foundry Local', async () => {
    h = await start()
    const res = await h.get('/atomic/v1/runtimes/foundry-local/accelerators')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: 'PROVIDER_NOT_FOUND' } })
  })
})

describe('POST /models/foundry-local/check (task 6.5)', () => {
  it('accepts a minimum version, returns update-required, and rejects an invalid minimum over HTTP', async () => {
    h = await start({
      nativeModelChecks: {
        'foundry-local': async (body) =>
          foundryLocalVerdict(
            {
              platform: 'linux',
              arch: 'x64',
              installed: true,
              runtimeVersion: '2.1.0',
              accelerators: [],
              npu: false,
            },
            parseFoundryLocalCheckRequest(body)
          ),
      },
    })
    const post = (body: unknown) =>
      h!.get('/atomic/v1/models/foundry-local/check', { method: 'POST', body: JSON.stringify(body) })
    const cpu = { execution_provider: 'cpu', device: 'cpu' }
    expect(await (await post(cpu)).json()).toMatchObject({ verdict: 'ok' })
    const result = await post({ ...cpu, min_runtime_version: '2.4.0' })
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({
      verdict: 'engine-update-required',
      reason: expect.stringMatching(/2.1.0.*2.4.0/),
    })
    const bad = await post({ ...cpu, min_runtime_version: '2.4' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } })
  })

  it('answers from the native check table, after the managed one has no entry for the provider', async () => {
    const seen: unknown[] = []
    h = await start({
      nativeModelChecks: {
        'foundry-local': async (body) => {
          seen.push(body)
          return {
            verdict: 'accelerator-unavailable',
            reason: 'This computer has no NPU.',
            accelerator: 'OpenVINOExecutionProvider',
          }
        },
      },
    })
    const res = await h.get('/atomic/v1/models/foundry-local/check', {
      method: 'POST',
      body: JSON.stringify({ execution_provider: 'openvino', device: 'npu' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      verdict: 'accelerator-unavailable',
      reason: 'This computer has no NPU.',
      accelerator: 'OpenVINOExecutionProvider',
    })
    expect(seen).toEqual([{ execution_provider: 'openvino', device: 'npu' }])
  })

  it('is not found where the provider is not registered', async () => {
    h = await start()
    const res = await h.get('/atomic/v1/models/foundry-local/check', { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: 'PROVIDER_NOT_FOUND' } })
  })
})
