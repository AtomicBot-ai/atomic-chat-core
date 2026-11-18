import { readdir, rename } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import { classifyFailure } from '../../telemetry/diagnostics.js'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { OptimalBackendStore } from './optimal-store.js'
import type { OptimalBackendCacheRecord } from '../types.js'

// The store writes `<cache>.tmp-<uuid>` and renames it into place; only the rename is made to fail.
vi.mock(import('node:fs/promises'), async (original) => {
  const fs = await original()
  return { ...fs, rename: vi.fn(fs.rename) }
})

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-optimal-write-')
})
afterEach(() => data.cleanup())

const record: OptimalBackendCacheRecord = {
  schemaVersion: 1,
  provider: 'llamacpp-upstream',
  detectedAt: 1,
  detectionKind: 'cpu-optimal',
  currentBackend: 'b1/macos-arm64',
  recommendedCategory: 'CPU',
}

describe('OptimalBackendStore write failures', () => {
  it('reports a full disk while saving the cache as an IO_ERROR that keeps its filesystem cause', async () => {
    const store = await OptimalBackendStore.open(data.layout.core.optimalBackend)
    const native = Object.assign(
      new Error("ENOSPC: no space left on device, rename 'cache.json.tmp-1' -> 'cache.json'"),
      { code: 'ENOSPC', syscall: 'rename' }
    )
    vi.mocked(rename).mockRejectedValueOnce(native)

    const error = await store.set('llamacpp-upstream', record, 0).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AtomicCoreError)
    expect(error).toMatchObject({ code: 'IO_ERROR', details: native.message })
    expect((error as AtomicCoreError).message).toBe(
      `Cannot write the optimal-backend cache at ${data.layout.core.optimalBackend}`
    )
    expect((error as AtomicCoreError).cause).toBe(native)
    // Nothing was published, no temporary file was left behind, and the write chain still works.
    expect(store.get('llamacpp-upstream')).toEqual({ revision: 0, optimal: null })
    expect((await readdir(data.layout.core.dir)).filter((name) => name.includes('.tmp-'))).toEqual([])
    expect(await store.set('llamacpp-upstream', record, 0)).toMatchObject({ status: 'updated' })
    // The reporter must still see the disk, not an unexplained IO_ERROR.
    expect(classifyFailure(error, { component: 'http', operation: 'request' })).toMatchObject({
      category: 'operational',
      reason: 'disk_full',
    })
  })
})
