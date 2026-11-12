import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { BackendService } from './service.js'
import type { UpstreamManifest } from '../types.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-backend-in-use-')
})
afterEach(() => data.cleanup())

const MANIFEST: UpstreamManifest = {
  tag_name: 'b6325',
  download_base: 'https://mirror.example/b6325',
  assets: [{ name: 'llama-b6325-bin-macos-arm64.tar.gz', sha256: 'a'.repeat(64), size: 1024 }],
}

/** The download step is where a refused install must never arrive. */
interface FakeDownloader {
  download: (taskId: string, items: Array<{ save_path: string }>) => Promise<void>
}

function fakeDownloader(): FakeDownloader {
  return {
    download: vi.fn(async () => {
      throw new Error('network went away')
    }),
  }
}

function service(downloader: FakeDownloader, busyDirs: string[] = []) {
  return new BackendService({
    layout: data.layout,
    provider: 'llamacpp-upstream',
    downloader: downloader as never,
    readManifest: async () => MANIFEST,
    platform: 'darwin',
    now: () => 1,
    host: { exclusive: (fn) => fn(), inUse: async () => busyDirs },
  })
}

describe('install', () => {
  it('refuses to replace a pack a session is running from', async () => {
    const busyDir = join(
      data.layout.provider('llamacpp-upstream').backendsDir,
      'b6325',
      'macos-arm64'
    )
    const downloader = fakeDownloader()

    const refusal = service(downloader, [busyDir]).install('b6325', 'macos-arm64', {
      taskId: 'test',
    })

    await expect(refusal).rejects.toMatchObject({ name: 'AtomicCoreError', code: 'BACKEND_IN_USE' })
    expect(downloader.download).not.toHaveBeenCalled()
  })

  it('installs when nothing runs from the pack', async () => {
    const downloader = fakeDownloader()

    await expect(
      service(downloader, []).install('b6325', 'macos-arm64', { taskId: 'test' })
    ).rejects.toThrow('network went away')
    expect(downloader.download).toHaveBeenCalled()
  })
})
