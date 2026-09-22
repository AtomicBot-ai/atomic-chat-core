import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'

let h: ControlHarness

beforeEach(async () => {
  h = await start()
})
afterEach(() => h.server.close())

const ask = (body?: unknown) =>
  h.get('/atomic/v1/disk/available', {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

describe('disk space route', () => {
  it('passes the path from the body and answers the bytes', async () => {
    const res = await ask({ path: '/data/diffusion/backends/tag/metal' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ bytes: 5_000_000_000 })
    expect(h.calls).toEqual(['disk "/data/diffusion/backends/tag/metal"'])
  })

  it('asks about the data folder when the body names no path', async () => {
    expect(await (await ask()).json()).toEqual({ bytes: 5_000_000_000 })
    expect(await (await ask({})).json()).toEqual({ bytes: 5_000_000_000 })
    expect(h.calls).toEqual(['disk undefined', 'disk undefined'])
  })

  it('answers null when the platform cannot say, which is not an error', async () => {
    h.diskBytes = null
    const res = await ask({})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ bytes: null })
  })

  it('refuses a path outside the data folder as a bad request, and never takes it from the URL', async () => {
    const strict = await start({
      disk: {
        available: async () => {
          throw Object.assign(new Error('Disk space is only reported inside the data folder.'), {
            code: 'INVALID_ARGUMENT',
          })
        },
      },
    })
    const res = await strict.get('/atomic/v1/disk/available', {
      method: 'POST',
      body: JSON.stringify({ path: '/etc' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as object).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } })
    const viaGet = await strict.get('/atomic/v1/disk/available?path=/etc')
    expect(viaGet.status).toBe(405)
    await strict.server.close()
  })
})
