import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'

let h: ControlHarness

beforeEach(async () => {
  h = await start()
})
afterEach(() => h.server.close())

describe('hardware override routes', () => {
  const put = (body: unknown) =>
    h.get('/atomic/v1/hardware/override', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('accepts what the app measured and reads it back', async () => {
    const gpus = [{ vendor: 'NVIDIA', driver_version: '551.23', nvidia_info: { compute_capability: '8.9' } }]

    const stored = await put({ gpus, cpu_extensions: ['AVX2'], source: 'tauri-plugin-hardware' })
    expect(stored.status).toBe(200)

    const read = (await (await h.get('/atomic/v1/hardware/override')).json()) as {
      override: { gpus: unknown[]; cpu_extensions: string[]; source: string }
    }
    expect(read.override.gpus).toEqual(gpus)
    expect(read.override.cpu_extensions).toEqual(['avx2'])
    expect(read.override.source).toBe('tauri-plugin-hardware')
  })

  it('reports no override before the app injects one', async () => {
    const read = (await (await h.get('/atomic/v1/hardware/override')).json()) as { override: unknown }

    expect(read.override).toBeNull()
  })

  it('refuses a payload it cannot read', async () => {
    const res = await put({ cpu_extensions: ['avx2'] })

    expect(res.status).toBe(400)
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'INVALID_ARGUMENT' },
    })
  })

  it('can be cleared, which puts the core back on its own probe', async () => {
    await put({ gpus: [] })

    const cleared = await h.get('/atomic/v1/hardware/override', { method: 'DELETE' })

    expect(await cleared.json()).toEqual({ cleared: true })
    expect(
      ((await (await h.get('/atomic/v1/hardware/override')).json()) as { override: unknown }).override
    ).toBeNull()
  })
})
