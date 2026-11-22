import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { BackendService } from './service.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-backend-race-')
})
afterEach(() => data.cleanup())

it('refuses a second install of the same pack while the first is downloading', async () => {
  const staging = join(
    data.layout.provider('llamacpp-upstream').backendsDir,
    'b6325',
    'macos-arm64.incoming-1'
  )
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve))
  let releaseSecond!: () => void
  const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve))
  let firstStarted!: () => void
  const firstDownloading = new Promise<void>((resolve) => (firstStarted = resolve))
  const downloader = {
    download: vi.fn(async (taskId: string, items: Array<{ save_path: string }>) => {
      if (taskId === 'first') {
        firstStarted()
        await firstGate
      } else {
        await secondGate
      }
      for (const item of items) {
        await mkdir(join(item.save_path, '..'), { recursive: true })
        await writeFile(item.save_path, 'archive')
      }
    }),
  }
  const service = new BackendService({
    layout: data.layout,
    provider: 'llamacpp-upstream',
    downloader: downloader as never,
    readManifest: async () => null,
    platform: 'darwin',
    now: () => 1,
    verifyMacBackend: async () => {},
  })
  const first = service.install('b6325', 'macos-arm64', { taskId: 'first' })
  first.catch(() => {})
  try {
    await firstDownloading
    const marker = join(staging, 'first-install-marker')
    await writeFile(marker, 'the first install is still using this directory')
    const second = service.install('b6325', 'macos-arm64', { taskId: 'second' })
    second.catch(() => {})
    const settled = await Promise.race([
      second.then(
        () => 'installed' as const,
        () => 'refused' as const
      ),
      new Promise<'still downloading'>((resolve) => setTimeout(() => resolve('still downloading'), 300)),
    ])
    expect(settled).toBe('refused')
    expect(await readdir(staging)).toContain('first-install-marker')
  } finally {
    releaseSecond()
    releaseFirst()
  }
})

it('installs the same pack again after the earlier attempt has failed', async () => {
  const service = new BackendService({
    layout: data.layout,
    provider: 'llamacpp-upstream',
    downloader: { download: vi.fn() } as never,
    readManifest: async () => null,
    platform: 'darwin',
    host: {
      exclusive: <T>(fn: () => Promise<T>) => fn(),
      inUse: async () => {
        throw new Error('the load queue is unavailable')
      },
    },
  })
  await expect(service.install('b6325', 'macos-arm64', { taskId: 'first' })).rejects.toThrow(
    'the load queue is unavailable'
  )
  // The refusal belongs to the attempt in flight; a call after it settled must go through again.
  await expect(service.install('b6325', 'macos-arm64', { taskId: 'second' })).rejects.toThrow(
    'the load queue is unavailable'
  )
})
