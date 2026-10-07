import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { c as tarCreate } from 'tar'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { AtomicCoreError } from '../contracts/index.js'
import { DOWNLOAD_CANCELLED, HASH_MISMATCH_MESSAGE } from '../downloads/index.js'
import type { DownloadItem } from '../downloads/index.js'
import { DISK_SPACE_FACTOR, installStaged } from './install.js'
import type { StagedInstall } from './install.js'

let data: TmpDataFolder
let archive: string
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-staged-install-')
  const src = join(data.root, 'src')
  await mkdir(src, { recursive: true })
  await writeFile(join(src, 'server'), 'new build')
  archive = join(data.root, 'build.tar.gz')
  await tarCreate({ gzip: true, cwd: src, file: archive }, ['server'])
})
afterEach(() => data.cleanup())

/** A downloader that "downloads" by copying the fixture archive to every save path. */
function copyingDownloader(fail?: Error) {
  const seen: DownloadItem[][] = []
  return {
    seen,
    download: async (_taskId: string, items: DownloadItem[]) => {
      seen.push(items)
      if (fail) throw fail
      for (const item of items) await writeFile(item.save_path, await readFile(archive))
    },
  }
}

function plan(overrides: Partial<StagedInstall> = {}): StagedInstall {
  return {
    dataFolder: data.root,
    target: join(data.root, 'engine', 'backends', 'tag-1', 'backend'),
    archives: [
      { url: 'https://example.test/build.tar.gz', name: 'build.tar.gz', sha256: 'a'.repeat(64), size: 100 },
    ],
    taskId: 'task',
    downloader: copyingDownloader(),
    availableSpace: async () => undefined,
    now: () => 42,
    verify: async () => {},
    record: async (staging) => writeFile(join(staging, '.atomic-owned'), 'atomic-chat\n'),
    ...overrides,
  }
}

const tagDir = () => join(data.root, 'engine', 'backends', 'tag-1')

describe('installStaged', () => {
  it('unpacks, verifies and records in staging, then renames into place with nothing left beside it', async () => {
    const downloader = copyingDownloader()
    const order: string[] = []
    const result = await installStaged(
      plan({
        downloader,
        verify: async (staging) => {
          order.push(`verify ${(await readdir(staging)).join(',')}`)
        },
        record: async (staging) => {
          order.push('record')
          await writeFile(join(staging, '.atomic-owned'), '')
        },
      })
    )
    expect(result).toEqual({ replaced: false })
    expect(order).toEqual(['verify server', 'record'])
    expect(await readdir(tagDir())).toEqual(['backend'])
    expect((await readdir(join(tagDir(), 'backend'))).sort()).toEqual(['.atomic-owned', 'server'])
    // The task id names the downloader's validation event, not the staging folder.
    expect(downloader.seen[0]?.[0]).toMatchObject({ sha256: 'a'.repeat(64), size: 100, model_id: 'task' })
  })

  it('swaps an existing target on a reinstall', async () => {
    await mkdir(join(tagDir(), 'backend'), { recursive: true })
    await writeFile(join(tagDir(), 'backend', 'stale'), 'old')
    expect(await installStaged(plan())).toEqual({ replaced: true })
    expect(await readdir(join(tagDir(), 'backend'))).not.toContain('stale')
    expect(await readdir(tagDir())).toEqual(['backend'])
  })

  it(`refuses before downloading when less than ${DISK_SPACE_FACTOR}× the archives is free`, async () => {
    const downloader = copyingDownloader()
    await expect(installStaged(plan({ downloader, availableSpace: async () => 299 }))).rejects.toMatchObject({
      code: 'BACKEND_INSUFFICIENT_DISK_SPACE',
    })
    expect(downloader.seen).toEqual([])
    await expect(installStaged(plan({ availableSpace: async () => 300 }))).resolves.toEqual({
      replaced: false,
    })
  })

  it.each([
    [new Error(DOWNLOAD_CANCELLED), 'CANCELLED'],
    [new Error(HASH_MISMATCH_MESSAGE), 'ENGINE_INSTALL_FAILED'],
    [new Error('Size verification failed. Expected 100 bytes but got 3 bytes.'), 'ENGINE_INSTALL_FAILED'],
    [new Error('Error: [disk_full] no space'), 'ENGINE_INSTALL_FAILED'],
  ])('maps a download failure (%s) to %s and leaves nothing behind', async (error, code) => {
    await expect(installStaged(plan({ downloader: copyingDownloader(error) }))).rejects.toMatchObject({
      code,
    })
    expect(await readdir(tagDir()).catch(() => [])).toEqual([])
  })

  it('codes a plain failure as ENGINE_INSTALL_FAILED and keeps the build already there', async () => {
    await mkdir(join(tagDir(), 'backend'), { recursive: true })
    await writeFile(join(tagDir(), 'backend', 'current'), 'keep')
    await expect(
      installStaged(plan({ record: async () => Promise.reject(new Error('EACCES: nope')) }))
    ).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED', details: expect.stringMatching(/EACCES/) })
    expect(await readdir(tagDir())).toEqual(['backend'])
    expect(await readdir(join(tagDir(), 'backend'))).toEqual(['current'])
  })

  it('removes the staging when the probe fails, keeping the build already there', async () => {
    await mkdir(join(tagDir(), 'backend'), { recursive: true })
    await writeFile(join(tagDir(), 'backend', 'current'), 'keep')
    const probe = new AtomicCoreError('ENGINE_INSTALL_FAILED', 'does not run')
    await expect(installStaged(plan({ verify: async () => Promise.reject(probe) }))).rejects.toBe(probe)
    expect(await readdir(tagDir())).toEqual(['backend'])
    expect(await readdir(join(tagDir(), 'backend'))).toEqual(['current'])
  })
})
