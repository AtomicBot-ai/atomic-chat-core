import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { acquireModelClaim, modelClaimKey } from './model-claim.js'

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

  it('reports an unreachable claims folder as a coded IO_ERROR on every platform', async () => {
    // A file in the middle of the chain fails the recursive mkdir with ENOTDIR everywhere; the
    // first test above depends on whether the platform reports a final-component file as
    // EEXIST (macOS) or walks into the loop and fails at the claim directory (Linux).
    const layout = {
      ...data.layout,
      core: { ...data.layout.core, modelClaims: join(data.layout.root, 'blocker', 'claims') },
    }
    await writeFile(join(data.layout.root, 'blocker'), 'not a directory')
    const error: unknown = await acquireModelClaim(layout, 'llamacpp-upstream', 'demo', 'instance-a').catch(
      (e: unknown) => e
    )
    expect(error).toMatchObject({ name: 'AtomicCoreError', code: 'IO_ERROR' })
    expect((error as Error & { cause?: { code?: string } }).cause?.code).toMatch(/^(ENOTDIR|ENOENT)$/)
  })

  // Windows ignores the directory read-only attribute, so the refusal cannot be staged there;
  // POSIX honors it and the coded IO_ERROR is exercised on every other runner OS.
  it.skipIf(process.platform === 'win32')(
    'refuses a claim inside an unwritable claims folder as a coded IO_ERROR',
    async () => {
      // A full or read-only volume refuses the per-model mkdir; EACCES/EPERM must not leak as a
      // bare errno and must not be mistaken for claim contention (EEXIST).
      await mkdir(data.layout.core.modelClaims, { recursive: true })
      await chmod(data.layout.core.modelClaims, 0o555)
      try {
        const error: unknown = await acquireModelClaim(
          data.layout,
          'llamacpp-upstream',
          'demo',
          'instance-a'
        ).catch((e: unknown) => e)
        expect(error).toMatchObject({ name: 'AtomicCoreError', code: 'IO_ERROR' })
        expect((error as Error & { cause?: { code?: string } }).cause?.code).toMatch(/^(EACCES|EPERM)$/)
      } finally {
        await chmod(data.layout.core.modelClaims, 0o755)
      }
    }
  )

  it('refuses to load when the claim folder exists without a readable record', async () => {
    // An unreadable or missing record is not claim contention: there is no owner to reattach to
    // and none to consider stale, so the load refuses instead of silently taking over.
    await mkdir(data.layout.core.modelClaims, { recursive: true })
    await mkdir(join(data.layout.core.modelClaims, modelClaimKey('llamacpp-upstream', 'demo')))
    await expect(
      acquireModelClaim(data.layout, 'llamacpp-upstream', 'demo', 'instance-a')
    ).rejects.toMatchObject({ name: 'AtomicCoreError', code: 'CORE_ALREADY_RUNNING' })
  })
})
