import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { acquireModelClaim, modelClaimKey } from './model-claim.js'

let data: TmpDataFolder

beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-claim-')
})

afterEach(async () => {
  await data.cleanup()
})

describe('model claims', () => {
  it('uses a stable provider-and-model key', () => {
    expect(modelClaimKey('llamacpp-upstream', 'owner/model')).toHaveLength(64)
    expect(modelClaimKey('llamacpp-upstream', 'owner/model')).not.toBe(
      modelClaimKey('llamacpp', 'owner/model')
    )
  })

  it('excludes another owner and can be released', async () => {
    const first = await acquireModelClaim(data.layout, 'llamacpp-upstream', 'demo', 'instance-a')
    await expect(
      acquireModelClaim(data.layout, 'llamacpp-upstream', 'demo', 'instance-b')
    ).rejects.toMatchObject({ code: 'CORE_ALREADY_RUNNING' })
    await first.update('ready')
    await first.release()
    const second = await acquireModelClaim(data.layout, 'llamacpp-upstream', 'demo', 'instance-b')
    await second.release()
  })

  it('reattaches to the same core instance without replacing its claim id', async () => {
    const first = await acquireModelClaim(data.layout, 'llamacpp-upstream', 'demo', 'instance-a')
    const attached = await acquireModelClaim(data.layout, 'llamacpp-upstream', 'demo', 'instance-a')
    expect(attached.claim.claim_id).toBe(first.claim.claim_id)
    await attached.release()
  })
})
