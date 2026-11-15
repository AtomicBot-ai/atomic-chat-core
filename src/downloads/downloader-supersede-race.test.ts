import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOWNLOAD_CANCELLED, Downloader } from './downloader.js'

const folders: string[] = []

afterEach(async () => {
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe('a second download() with the same task id', () => {
  it('stops the superseded attempt before it publishes the staging file the newcomer owns', async () => {
    const dataFolder = await mkdtemp(join(tmpdir(), 'atomic-dl-supersede-'))
    folders.push(dataFolder)
    // Same length, different bytes: the two attempts can be told apart on disk.
    const firstBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const secondBytes = new Uint8Array([11, 12, 13, 14, 15, 16, 17, 18])
    const releaseFirst = deferred()
    const releaseSecond = deferred()
    const firstChunk = deferred()
    const secondChunk = deferred()
    let calls = 0
    const fetchStub = (async () => {
      calls += 1
      const first = calls === 1
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            controller.enqueue(first ? firstBytes : secondBytes)
            ;(first ? firstChunk : secondChunk).resolve()
            await (first ? releaseFirst : releaseSecond).promise
            controller.close()
          },
        }),
        { status: 200, headers: { 'content-length': '8' } }
      )
    }) as unknown as typeof fetch
    const dl = new Downloader({
      dataFolder,
      platform: 'linux',
      fetch: fetchStub,
      availableSpace: async () => undefined,
      sleep: async () => {},
      emit: () => {},
    })
    const savePath = join(dataFolder, 'backends/pack.bin')
    const item = { url: 'http://engine.test/pack.bin', save_path: 'backends/pack.bin', size: 8 }

    // The first attempt has written its chunk and is waiting for the rest of its body.
    const first = dl.download('same', [item])
    await firstChunk.promise
    await vi.waitFor(async () => expect((await stat(`${savePath}.tmp`)).size).toBe(8))

    // A client retries with the same task id: the first attempt is superseded, the second owns the file.
    const second = dl.download('same', [item])
    await secondChunk.promise
    await vi.waitFor(async () => expect([...(await readFile(`${savePath}.tmp`))]).toEqual([...secondBytes]))

    // The superseded attempt's body ends. It must stand back; it used to publish the newcomer's file
    // and then remove it, so the newcomer read `ENOENT` from its own staging path.
    releaseFirst.resolve()
    await expect(first).rejects.toThrow(DOWNLOAD_CANCELLED)

    releaseSecond.resolve()
    await expect(second).resolves.toBeUndefined()
    expect([...(await readFile(savePath))]).toEqual([...secondBytes])
    // The newcomer published its own bytes: the staging file and the sidecar are gone.
    await expect(stat(`${savePath}.tmp`)).rejects.toThrow()
    await expect(stat(`${savePath}.url`)).rejects.toThrow()
  })
})
