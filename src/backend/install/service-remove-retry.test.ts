import type * as Fs from 'node:fs/promises'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { BackendService } from './service.js'

vi.mock(import('node:fs/promises'), async (original) => {
  const fs = await original()
  return { ...fs, rm: vi.fn(fs.rm) }
})

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-remove-retry-')
})
afterEach(() => data.cleanup())

/** A Windows host whose deletion of an old ROCm pack meets a handle still closing. */
function service() {
  return new BackendService({
    layout: data.layout,
    provider: 'llamacpp-upstream',
    downloader: { download: vi.fn() } as never,
    readManifest: async () => null,
    platform: 'win32',
    moveRetry: { delaysMs: [0, 0], sleep: async () => {} },
    host: { exclusive: (fn) => fn(), inUse: async () => [] },
  })
}

describe('remove on Windows', () => {
  it('waits out a pack a process has only just let go of', async () => {
    await data.writeBackend('llamacpp-upstream', 'b6100', 'win-rocm-10.0-x64')
    const target = join(data.layout.provider('llamacpp-upstream').backendsDir, 'b6100', 'win-rocm-10.0-x64')
    const actual = await vi.importActual<typeof Fs>('node:fs/promises')
    let held = 2
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (path !== target) return actual.rm(path, options)
      if (held-- > 0)
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rm '${target}'`), {
          code: 'EBUSY',
          path: String(path),
          syscall: 'rm',
        })
      return actual.rm(path, options)
    })
    try {
      await expect(service().remove('b6100', 'win-rocm-10.0-x64')).resolves.toBe(true)
      expect(vi.mocked(rm).mock.calls.filter(([path]) => path === target)).toHaveLength(3)
      await expect(actual.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      vi.mocked(rm).mockImplementation(actual.rm)
    }
  })
})
