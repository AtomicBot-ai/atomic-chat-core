import { describe, expect, it } from 'vitest'
import { cores, createCore, useCoreHarness } from '../../../../test/helpers/core-harness.js'

useCoreHarness()

describe('GET /atomic/v1/backends/:provider', () => {
  it('answers PROVIDER_NOT_FOUND for a provider this core does not run', async () => {
    const core = await createCore()
    cores.push(core)
    const response = await fetch(`${core.control.url}/atomic/v1/backends/not-a-provider`, {
      headers: { authorization: `Bearer ${core.controlToken}` },
    })
    const body = (await response.json()) as { error?: { code: string } }
    expect({ status: response.status, code: body.error?.code }).toEqual({
      status: 404,
      code: 'PROVIDER_NOT_FOUND',
    })
  })
})
