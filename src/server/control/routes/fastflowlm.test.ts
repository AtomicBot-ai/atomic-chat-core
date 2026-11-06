import { expect, it } from 'vitest'
import { startControlHarness } from '../../../../test/helpers/control-harness.js'
it('rejects override fields before completing model maintenance', async () => {
  const h = await startControlHarness({
    fastFlowLmMaintenance: {
      begin: async () => {
        throw Error()
      },
      list: async () => [],
      get: async () => {
        throw Error()
      },
      complete: async () => {
        throw Error('must not run')
      },
    },
  })
  try {
    const r = await h.get('/atomic/v1/models/fastflowlm/maintenance/test/complete', {
      method: 'POST',
      body: JSON.stringify({ path: 'untrusted' }),
    })
    expect(r.status).toBe(400)
  } finally {
    await h.server.close()
  }
})
