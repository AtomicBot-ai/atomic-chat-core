import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HARNESS_SYSTEM_INFO,
  startControlHarness as start,
} from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'
import type { HardwareInfoResponse } from '../../../contracts/index.js'

let h: ControlHarness

beforeEach(async () => {
  h = await start()
})
afterEach(() => h.server.close())

describe('hardware info routes', () => {
  it('serves what the probe measured, with its warnings and source', async () => {
    const res = await h.get('/atomic/v1/hardware/info')
    expect(res.status).toBe(200)
    const body = (await res.json()) as HardwareInfoResponse
    expect(body).toEqual({
      info: HARNESS_SYSTEM_INFO,
      source: 'probe',
      probed_at: expect.any(Number),
      warnings: ['harness: canned probe'],
    })
  })

  it('probes again on refresh and never answers a probed_at older than before', async () => {
    const before = (await (await h.get('/atomic/v1/hardware/info')).json()) as HardwareInfoResponse
    const res = await h.get('/atomic/v1/hardware/refresh', { method: 'POST' })
    expect(res.status).toBe(200)
    const after = (await res.json()) as HardwareInfoResponse
    expect(after.probed_at).toBeGreaterThanOrEqual(before.probed_at)
    expect(after.source).toBe('probe')
    expect(after.info.gpus).toHaveLength(1)
  })

  it('serves the override in place of the probe while one stands', async () => {
    const gpus = [
      { vendor: 'AMD', total_memory: 24_576, vulkan_info: { device_id: 0x744c, device_type: 'DiscreteGpu' } },
    ]
    await h.get('/atomic/v1/hardware/override', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gpus, os_type: 'linux' }),
    })
    const overridden = (await (await h.get('/atomic/v1/hardware/info')).json()) as HardwareInfoResponse
    expect(overridden.source).toBe('override')
    expect(overridden.info.os_type).toBe('linux')
    expect(overridden.info.gpus).toEqual([
      {
        name: 'GPU 0',
        total_memory: 24_576,
        vendor: 'AMD',
        uuid: 'override-0',
        driver_version: '',
        nvidia_info: null,
        vulkan_info: { index: 0, device_type: 'DiscreteGpu', api_version: '', device_id: 0x744c },
      },
    ])
    // The probe's CPU and memory stay; only what the override carries is replaced.
    expect(overridden.info.cpu).toEqual(HARNESS_SYSTEM_INFO.cpu)
    expect(overridden.info.total_memory).toBe(HARNESS_SYSTEM_INFO.total_memory)

    await h.get('/atomic/v1/hardware/override', { method: 'DELETE' })
    expect(((await (await h.get('/atomic/v1/hardware/info')).json()) as HardwareInfoResponse).source).toBe(
      'probe'
    )
  })
})

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
