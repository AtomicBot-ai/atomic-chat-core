import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { failureObserver } from '../telemetry/index.js'
import type { ErrorReport } from '../telemetry/index.js'
import { Downloader } from './downloader.js'

/**
 * The event this reproduces (ATOMIC-CHAT-CORE-CE): a transfer that errored five times at the same
 * byte and was given up on. The thrown error already knows which stream failure ended the ladder,
 * but it keeps only that failure's message as a string cause, so the classifier has nothing to read
 * and the report says `downloads download: unknown`.
 */
it('keeps the failing stream cause on the retry-exhaustion error so a reset transfer is reported as network', async () => {
  const dataFolder = await mkdtemp(join(tmpdir(), 'atomic-dl-stream-cause-'))
  const reports: ErrorReport[] = []
  const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
  const dl = new Downloader({
    dataFolder,
    platform: 'linux',
    // Every reconnect re-opens the same failing transfer, so the ladder runs out at byte 0.
    fetch: (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(reset)
          },
        }),
        { status: 200, headers: { 'content-length': '1024' } }
      )) as unknown as typeof fetch,
    availableSpace: async () => undefined,
    sleep: async () => {},
    emit: () => {},
    onFailure: failureObserver({ capture: (report) => reports.push(report) }),
  })
  try {
    await expect(
      dl.download('stream-cause', [
        { url: 'http://engine.test/pack.tar.gz', save_path: 'p/pack.tar.gz', size: 1024 },
      ])
    ).rejects.toThrow(/Download failed after 5 retries at byte 0: read ECONNRESET/)
    expect(reports).toHaveLength(1)
    expect((reports[0]?.error as Error).cause).toBe(reset)
    expect(reports[0]).toMatchObject({
      level: 'warning',
      diagnostic: {
        component: 'downloads',
        operation: 'download',
        reason: 'network',
        category: 'operational',
      },
    })
  } finally {
    await rm(dataFolder, { recursive: true, force: true })
  }
})
