import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { failureObserver } from '../telemetry/index.js'
import type { ErrorReport } from '../telemetry/index.js'
import { Downloader } from './downloader.js'

/**
 * The event this reproduces (ATOMIC-CHAT-CORE-9S): a transfer whose staging file disappears before
 * the downloader publishes it. `downloadOne` reports `Error: [disk_device_lost] ENOENT: …`, but the
 * failure classifier has no ENOENT entry of its own, so the report says `downloads download: unknown`.
 */
it('names the disk reason of a vanished staging file instead of unknown', async () => {
  const dataFolder = await mkdtemp(join(tmpdir(), 'atomic-dl-disk-reason-'))
  const reports: ErrorReport[] = []
  const relDir = 'staging/linux-rocm/pack'
  const dir = join(dataFolder, relDir)
  const dl = new Downloader({
    dataFolder,
    platform: 'linux',
    fetch: (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            // The staging directory is removed while the `.tmp` file is open, as a concurrent
            // install cleanup leaves it: the post-transfer stat of the partial then fails ENOENT.
            await rm(dir, { recursive: true, force: true })
            controller.enqueue(new Uint8Array([1, 2, 3, 4]))
            controller.close()
          },
        }),
        { status: 200, headers: { 'content-length': '4' } }
      )) as unknown as typeof fetch,
    availableSpace: async () => undefined,
    sleep: async () => {},
    emit: () => {},
    onFailure: failureObserver({ capture: (report) => reports.push(report) }),
  })
  await expect(
    dl.download('disk-reason', [
      { url: 'http://engine.test/pack.tar.gz', save_path: `${relDir}/pack.tar.gz`, size: 4 },
    ])
  ).rejects.toThrow(/^Error: \[disk_device_lost\] ENOENT:/)
  expect(reports).toHaveLength(1)
  expect(reports[0]?.diagnostic).toMatchObject({
    component: 'downloads',
    operation: 'download',
    reason: 'disk_device_lost',
    category: 'operational',
  })
})
