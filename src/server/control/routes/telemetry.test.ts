import { afterEach, describe, expect, it } from 'vitest'
import { startControlHarness } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'
import { AtomicCoreError } from '../../../contracts/index.js'
import { ErrorReporter } from '../../../telemetry/index.js'
import type { ErrorReport } from '../../../telemetry/index.js'
import { parseTelemetryUpdate } from './telemetry.js'

let h: ControlHarness | undefined
afterEach(() => h?.server.close())

const put = (harness: ControlHarness, body: unknown) =>
  harness.get('/atomic/v1/telemetry', { method: 'PUT', body: JSON.stringify(body) })

describe('parseTelemetryUpdate', () => {
  it('keeps only the fields that were sent', () => {
    expect(parseTelemetryUpdate({})).toEqual({})
    expect(parseTelemetryUpdate({ enabled: false, user_id: null, tags: { os: 'macOS' }, extra: 1 })).toEqual({
      enabled: false,
      user_id: null,
      tags: { os: 'macOS' },
    })
  })

  it.each([
    [null, 'telemetry needs a JSON object'],
    [[1], 'telemetry needs a JSON object'],
    [{ enabled: 'yes' }, '"enabled" must be true or false'],
    [{ user_id: 7 }, '"user_id" must be a string or null'],
    [{ tags: null }, '"tags" must map names to strings'],
    [{ tags: ['x'] }, '"tags" must map names to strings'],
    [{ tags: { vram_mb: 8192 } }, '"tags" must map names to strings'],
  ])('refuses %j', (body, message) => {
    expect(parseTelemetryUpdate(body)).toBe(message)
  })
})

describe('/atomic/v1/telemetry', () => {
  it('applies what the app says and answers the resulting state', async () => {
    const reporter = new ErrorReporter({
      config: null,
      coreVersion: '0.3.0',
      platform: 'darwin',
      arch: 'arm64',
    })
    h = await startControlHarness({ telemetry: reporter })
    expect(await (await h.get('/atomic/v1/telemetry')).json()).toEqual({
      enabled: false,
      reporting: false,
      has_user: false,
      tags: {},
    })
    const updated = await put(h, {
      enabled: true,
      user_id: 'device-1',
      tags: { gpu_model: 'M3', secret: 'x' },
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toEqual({
      enabled: true,
      reporting: false,
      has_user: true,
      tags: { gpu_model: 'M3' },
    })
    const refused = await put(h, { enabled: 1 })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } })
  })

  it('says nothing is reported by a core without a reporter, whatever it is told', async () => {
    h = await startControlHarness()
    const answer = await put(h, { enabled: true })
    expect(await answer.json()).toEqual({ enabled: false, reporting: false, has_user: false, tags: {} })
  })

  it('reports a route that failed on our side with its pattern, not its path', async () => {
    const captured: ErrorReport[] = []
    const telemetry = {
      capture: (report: ErrorReport) => captured.push(report),
      state: () => ({ enabled: true, reporting: true, has_user: false, tags: {} }),
      update: () => {},
    }
    h = await startControlHarness({ telemetry })
    h.loadResult = async () => {
      throw new TypeError('cannot read properties of undefined')
    }
    const failed = await h.get('/atomic/v1/models/llamacpp-upstream/secret-model/load', {
      method: 'POST',
      body: '{}',
    })
    expect(failed.status).toBe(500)
    expect(captured).toEqual([
      expect.objectContaining({
        source: 'control_route',
        tags: expect.objectContaining({
          route: 'POST /atomic/v1/models/:provider/*modelId/load',
          http_status: 500,
        }),
      }),
    ])
    h.loadResult = async () => {
      throw new AtomicCoreError('MODEL_NOT_FOUND', 'no such model')
    }
    await h.get('/atomic/v1/models/llamacpp-upstream/m/load', { method: 'POST', body: '{}' })
    expect(captured).toHaveLength(1)
  })
})
