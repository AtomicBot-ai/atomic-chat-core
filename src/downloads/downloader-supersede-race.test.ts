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
      let cancelled = false
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            controller.enqueue(first ? firstBytes : secondBytes)
            ;(first ? firstChunk : secondChunk).resolve()
            await (first ? releaseFirst : releaseSecond).promise
            if (!cancelled) controller.close()
          },
          cancel() {
            cancelled = true
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
    const firstCancelled = expect(first).rejects.toThrow(DOWNLOAD_CANCELLED)
    const second = dl.download('same', [item])
    await secondChunk.promise
    await vi.waitFor(async () => expect([...(await readFile(`${savePath}.tmp`))]).toEqual([...secondBytes]))

    // The superseded attempt's body ends. It must stand back; it used to publish the newcomer's file
    // and then remove it, so the newcomer read `ENOENT` from its own staging path.
    releaseFirst.resolve()
    await firstCancelled

    releaseSecond.resolve()
    await expect(second).resolves.toBeUndefined()
    expect([...(await readFile(savePath))]).toEqual([...secondBytes])
    // The newcomer published its own bytes: the staging file and the sidecar are gone.
    await expect(stat(`${savePath}.tmp`)).rejects.toThrow()
    await expect(stat(`${savePath}.url`)).rejects.toThrow()
  })

  it('leaves the completed partial when the final progress callback supersedes the attempt', async () => {
    const dataFolder = await mkdtemp(join(tmpdir(), 'atomic-dl-publish-'))
    folders.push(dataFolder)
    const savePath = join(dataFolder, 'pack.bin')
    const item = { url: 'http://engine.test/pack.bin', save_path: 'pack.bin', size: 4 }
    let replacement: Promise<void> | undefined
    let partial: string | undefined
    let calls = 0
    const dl: Downloader = new Downloader({
      dataFolder,
      platform: 'linux',
      fetch: async () => {
        if (++calls === 1) return new Response('old!')
        partial = await readFile(`${savePath}.tmp`, 'utf8').catch(() => undefined)
        return new Response('new!')
      },
      availableSpace: async () => undefined,
      emit(event) {
        if (event === 'download:progress' && !replacement) replacement = dl.download('same', [item])
      },
    })

    await expect(dl.download('same', [item])).rejects.toThrow(DOWNLOAD_CANCELLED)
    await expect(replacement).resolves.toBeUndefined()
    expect(partial).toBe('old!')
    expect(await readFile(savePath, 'utf8')).toBe('new!')
  })

  it('keeps the finished file if cancellation interrupts validation before a retry', async () => {
    const dataFolder = await mkdtemp(join(tmpdir(), 'atomic-dl-validation-'))
    folders.push(dataFolder)
    const savePath = join(dataFolder, 'pack.bin')
    const sha256 = 'a'.repeat(64)
    const item = { url: 'http://engine.test/pack.bin', save_path: 'pack.bin', size: 4, sha256 }
    const verifying = deferred()
    const finishVerification = deferred()
    let calls = 0
    let original: string | undefined
    const dl = new Downloader({
      dataFolder,
      platform: 'linux',
      fetch: async () => {
        if (++calls === 1) return new Response('old!')
        original = await readFile(savePath, 'utf8').catch(() => undefined)
        return new Response('new!')
      },
      availableSpace: async () => undefined,
      emit: () => {},
      verify: {
        fileSize: async (path) => (await stat(path)).size,
        sha256: async (_path, signal) => {
          if (calls === 1) {
            verifying.resolve()
            await finishVerification.promise
            if (signal?.aborted) throw new Error('Validation cancelled')
          }
          return sha256
        },
      },
    })
    const firstCancelled = expect(dl.download('same', [item])).rejects.toThrow(DOWNLOAD_CANCELLED)
    await verifying.promise
    expect(dl.cancel('same')).toBe(true)
    expect(dl.active()).toEqual([])
    const second = dl.download('same', [item])
    finishVerification.resolve()

    await firstCancelled
    await expect(second).resolves.toBeUndefined()
    expect(original).toBe('old!')
    expect(await readFile(savePath, 'utf8')).toBe('new!')
  })
})
