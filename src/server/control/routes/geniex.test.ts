import { afterEach, describe, expect, it } from 'vitest'
import type { GeniexAccelerators, GeniexPrepareRequest } from '../../../contracts/index.js'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'

let h: ControlHarness | undefined
afterEach(() => h?.server.close())

const LIST: GeniexAccelerators = {
  installed: true,
  build: '0.9.3/win-arm64',
  chip: 'x-elite',
  accelerators: [
    { name: 'npu', device: 'npu', version: '0.9.3', size_bytes: 0, prepared: true },
    { name: 'gpu', device: 'gpu', version: '0.9.3', size_bytes: 0, prepared: true },
  ],
  error: null,
}

describe('geniex routes (task 6.4)', () => {
  it('answers the devices the build found and a prepare that has nothing to do', async () => {
    const calls: string[] = []
    h = await start({
      geniex: {
        accelerators: async () => {
          calls.push('list')
          return LIST
        },
        prepare: async (request: GeniexPrepareRequest) => {
          calls.push(`prepare ${JSON.stringify(request)}`)
          return { accelerators: [{ name: 'npu', prepared: true, reason: 'Nothing to prepare.' }] }
        },
      },
    })
    expect(await (await h.get('/atomic/v1/runtimes/geniex/accelerators')).json()).toEqual(LIST)
    const post = (body: unknown) =>
      h!.get('/atomic/v1/runtimes/geniex/accelerators/prepare', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    expect(await (await post({ accelerators: ['npu'] })).json()).toEqual({
      accelerators: [{ name: 'npu', prepared: true, reason: 'Nothing to prepare.' }],
    })
    expect((await post({})).status).toBe(200)
    expect((await post({ extra: 1 })).status).toBe(400)
    expect(calls).toEqual(['list', 'prepare {"accelerators":["npu"]}', 'prepare {}'])
  })

  it('answers PROVIDER_NOT_FOUND off a Snapdragon X', async () => {
    h = await start({})
    const response = await h.get('/atomic/v1/runtimes/geniex/accelerators')
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'PROVIDER_NOT_FOUND', details: 'geniex' } })
  })
})
