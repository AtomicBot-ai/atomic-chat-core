import { mkdir, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { acquireModelClaim } from './model-claim.js'

let data: TmpDataFolder

beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-claim-io-')
})

afterEach(async () => {
  await data.cleanup()
})

describe('model claim filesystem failures', () => {
  it('reports a claim folder that is not a directory as a coded IO_ERROR and keeps the cause', async () => {
    await mkdir(data.layout.core.dir, { recursive: true })
    // A restored or partially copied data folder can hold a file where the claims folder belongs.
    // mkdir then fails on the real filesystem, exactly like a full volume refuses the same call.
    await writeFile(data.layout.core.modelClaims, 'not a directory')
    const error: unknown = await acquireModelClaim(
      data.layout,
      'llamacpp-upstream',
      'demo',
      'instance-a'
    ).catch((e: unknown) => e)
    expect(error).toMatchObject({ name: 'AtomicCoreError', code: 'IO_ERROR' })
    expect((error as Error & { cause?: { code?: string } }).cause?.code).toMatch(/^(EEXIST|ENOTDIR)$/)
  })
})
