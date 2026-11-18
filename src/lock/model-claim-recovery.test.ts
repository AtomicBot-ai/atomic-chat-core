import { readFile, rm, writeFile } from 'node:fs/promises'
import type * as Fs from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { acquireModelClaim } from './model-claim.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>()
  return { ...fs, writeFile: vi.fn(fs.writeFile) }
})

let data: TmpDataFolder

beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-claim-recovery-')
})

afterEach(async () => {
  await data.cleanup()
})

describe('a model claim whose directory vanished', () => {
  it('writes the record again instead of failing the update that follows a finished load', async () => {
    const claim = await acquireModelClaim(data.layout, 'llamacpp-upstream', 'demo', 'instance-a')
    // The directory is created before a multi-minute engine start and only written again "ready"
    // after it: anything that removes it in between leaves an owned claim with no record on disk.
    await rm(claim.path, { recursive: true, force: true })
    await expect(claim.update('ready')).resolves.toBeUndefined()
    const record = JSON.parse(await readFile(join(claim.path, 'claim.json'), 'utf8')) as {
      claim_id: string
      state: string
    }
    expect(record).toMatchObject({ claim_id: claim.claim.claim_id, state: 'ready' })
  })

  it('refuses to update a claim already acquired by another owner', async () => {
    const first = await acquireModelClaim(data.layout, 'llamacpp-upstream', 'demo', 'instance-a')
    await rm(first.path, { recursive: true, force: true })
    const replacement = await acquireModelClaim(data.layout, 'llamacpp-upstream', 'demo', 'instance-b')
    const record = join(first.path, 'claim.json')
    const before = await readFile(record, 'utf8')

    await expect(first.update('ready')).rejects.toMatchObject({ code: 'CORE_ALREADY_RUNNING' })
    expect(first.claim.state).toBe('loading')
    await first.release()
    expect(await readFile(record, 'utf8')).toBe(before)
    await expect(replacement.update('ready')).resolves.toBeUndefined()
  })

  it('refuses recovery when a contender creates the directory after the failed write', async () => {
    const first = await acquireModelClaim(data.layout, 'llamacpp-upstream', 'demo', 'instance-a')
    await rm(first.path, { recursive: true, force: true })
    const record = join(first.path, 'claim.json')
    let replacementRecord: string | undefined
    vi.mocked(writeFile).mockImplementationOnce(async () => {
      await acquireModelClaim(data.layout, 'llamacpp-upstream', 'demo', 'instance-b')
      replacementRecord = await readFile(record, 'utf8')
      throw Object.assign(new Error('Claim directory disappeared'), { code: 'ENOENT' })
    })

    await expect(first.update('ready')).rejects.toMatchObject({ code: 'CORE_ALREADY_RUNNING' })
    expect(replacementRecord).toBeDefined()
    expect(await readFile(record, 'utf8')).toBe(replacementRecord)
  })

  it('still reports an unreachable claims folder as a coded IO_ERROR', async () => {
    const claim = await acquireModelClaim(data.layout, 'llamacpp-upstream', 'demo', 'instance-a')
    await rm(claim.path, { recursive: true, force: true })
    await rm(data.layout.core.modelClaims, { recursive: true, force: true })
    await writeFile(data.layout.core.modelClaims, 'not a directory')
    const error: unknown = await claim.update('ready').catch((e: unknown) => e)
    expect(error).toMatchObject({ name: 'AtomicCoreError', code: 'IO_ERROR' })
  })
})
