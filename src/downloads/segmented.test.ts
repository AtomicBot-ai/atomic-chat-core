import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvents } from '../contracts/index.js'
import { FixtureHttpServer } from '../../test/helpers/fixture-http-server.js'
import { DOWNLOAD_CANCELLED, Downloader, TIMED_PROGRESS_INTERVAL_MS } from './downloader.js'
import type { DownloaderEventName } from './downloader.js'
import { PROGRESS_EMIT_INTERVAL_BYTES } from './protocol.js'
import { downloadSegments, SEGMENTED_MIN_BYTES } from './segmented.js'
import type { SegmentedDownload } from './segmented.js'

const server = new FixtureHttpServer()
const small = Buffer.alloc(3 * 1024 * 1024 + 7)
for (let i = 0; i < small.length; i++) small[i] = (i * 7) % 253
const smallSha = createHash('sha256').update(small).digest('hex')
/** Where each of three ranges over `small` starts: `ceil(size / 3)` bytes apiece. */
const thirds = [0, 1048579, 2097158]

beforeAll(async () => {
  await server.start()
})
afterAll(async () => {
  await server.stop()
})
beforeEach(() => {
  server.files.clear()
  server.requests.length = 0
})

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false
  )

async function segmented(path: string, over: Partial<SegmentedDownload> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'atomic-seg-'))
  const destination = join(dir, 'model.gguf')
  const reported: number[] = []
  const run = (more: Partial<SegmentedDownload> = {}) =>
    downloadSegments({
      url: server.url(path),
      destination,
      size: small.length,
      sha256: smallSha,
      streams: 3,
      fetch,
      headers: {},
      signal: new AbortController().signal,
      sleep: async () => {},
      retryBaseMs: 1,
      now: Date.now,
      progress: (bytes) => reported.push(bytes),
      ...over,
      ...more,
    })
  return { dir, destination, reported, run }
}

describe('downloadSegments', () => {
  it('fetches the file over bounded ranges at once and joins them in order, leaving no segments behind', async () => {
    server.files.set('/s.bin', { body: small })
    const { dir, destination, reported, run } = await segmented('/s.bin')
    await expect(run()).resolves.toBe(true)
    expect((await readFile(destination)).equals(small)).toBe(true)
    const ranges = server.requests.map((r) => r.range).sort()
    expect(ranges).toEqual(['bytes=0-1048578', 'bytes=1048579-2097157', 'bytes=2097158-3145734'])
    expect(await readdir(dir)).toEqual(['model.gguf'])
    expect(reported.at(-1)).toBe(small.length)
  })

  it('never fetches over more than four ranges, whatever is asked for', async () => {
    server.files.set('/s.bin', { body: small })
    const { run } = await segmented('/s.bin', { streams: 16 })
    await run()
    expect(server.requests).toHaveLength(4)
  })

  it('falls back (false) and leaves nothing behind when the server answers a range with the whole file', async () => {
    server.files.set('/s.bin', { body: small, ranges: false })
    const { dir, run } = await segmented('/s.bin')
    await expect(run()).resolves.toBe(false)
    expect(await readdir(dir)).toEqual([])
  })

  it('falls back when the Content-Range is not the one asked for', async () => {
    server.files.set('/s.bin', { body: small, badContentRange: 'bytes 0-9/10' })
    const { run } = await segmented('/s.bin')
    await expect(run()).resolves.toBe(false)
  })

  it('retries a range whose stream drops, from where it got to', async () => {
    server.files.set('/s.bin', { body: small, dropAfterBytes: 1000, dropTimes: 1 })
    const { destination, run } = await segmented('/s.bin')
    await expect(run()).resolves.toBe(true)
    expect((await readFile(destination)).equals(small)).toBe(true)
    // The dropped range came back for what it was missing, not from its start again.
    const starts = server.requests.map((r) => Number(/^bytes=(\d+)-/.exec(r.range ?? '')?.[1]))
    expect(starts.some((start) => thirds.some((first) => start - first === 1000))).toBe(true)
  })

  it('retries a range that receives nothing for the inactivity timeout, and gives up after the retries', async () => {
    server.files.set('/s.bin', { body: small, delayMs: 300 })
    const { run } = await segmented('/s.bin', { inactivityTimeoutMs: 30 })
    await expect(run()).rejects.toThrow('no data received for 0.03 seconds')
    expect(server.requests.length).toBeGreaterThan(3)
  })

  it('keeps what every range already has when it is stopped, and continues from there the next time', async () => {
    server.files.set('/s.bin', { body: small, delayMs: 0 })
    const stop = new AbortController()
    const { destination, run } = await segmented('/s.bin', {
      signal: stop.signal,
      progress: (bytes) => {
        if (bytes > 0) stop.abort(new Error('stopped'))
      },
    })
    await expect(run()).rejects.toThrow('stopped')
    server.requests.length = 0
    await expect(run({ signal: new AbortController().signal, progress: () => {} })).resolves.toBe(true)
    expect((await readFile(destination)).equals(small)).toBe(true)
    const starts = server.requests.map((r) => Number(/^bytes=(\d+)-/.exec(r.range ?? '')?.[1]))
    expect(starts.some((start) => !thirds.includes(start))).toBe(true)
  })
})

describe('Downloader with streams', () => {
  const big = Buffer.alloc(SEGMENTED_MIN_BYTES)
  for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) % 251
  const bigSha = createHash('sha256').update(big).digest('hex')

  async function make(streams?: number, now: () => number = Date.now) {
    const dataFolder = await mkdtemp(join(tmpdir(), 'atomic-dl-seg-'))
    const events: Array<{ name: string; payload: unknown }> = []
    const dl = new Downloader({
      ...(streams !== undefined ? { streams } : {}),
      now,
      dataFolder,
      platform: 'linux',
      fetch,
      availableSpace: async () => undefined,
      sleep: async () => {},
      emit: <K extends DownloaderEventName>(name: K, payload: CoreEvents[K]) =>
        events.push({ name, payload }),
    })
    return { dl, dataFolder, events }
  }

  it('downloads a hash-pinned file of 32 MiB over parallel ranges and verifies it', async () => {
    server.files.set('/big.bin', { body: big })
    const { dl, dataFolder } = await make(2)
    await dl.download('seg', [
      { url: server.url('/big.bin'), save_path: 'm/big.gguf', sha256: bigSha, size: big.length },
    ])
    expect((await readFile(join(dataFolder, 'm/big.gguf'))).equals(big)).toBe(true)
    expect(server.requests.filter((r) => r.method === 'GET').map((r) => r.range)).toEqual(
      expect.arrayContaining(['bytes=0-16777215', 'bytes=16777216-33554431'])
    )
    expect(await exists(join(dataFolder, 'm/big.gguf.url'))).toBe(false)
  })

  it('fails a file whose ranges join into the wrong hash, and removes it', async () => {
    server.files.set('/big.bin', { body: big })
    const { dl, dataFolder } = await make(2)
    await expect(
      dl.download('seg-bad', [
        { url: server.url('/big.bin'), save_path: 'm/big.gguf', sha256: '0'.repeat(64), size: big.length },
      ])
    ).rejects.toThrow()
    expect(await exists(join(dataFolder, 'm/big.gguf'))).toBe(false)
  })

  it('downloads in one stream when the server cannot serve ranges', async () => {
    server.files.set('/big.bin', { body: big, ranges: false })
    const { dl, dataFolder } = await make(2)
    await dl.download('seg-fallback', [
      { url: server.url('/big.bin'), save_path: 'm/big.gguf', sha256: bigSha, size: big.length },
    ])
    expect((await readFile(join(dataFolder, 'm/big.gguf'))).equals(big)).toBe(true)
  })

  it('reports a cancelled parallel download as cancelled', async () => {
    server.files.set('/big.bin', { body: big, delayMs: 500 })
    const { dl } = await make(2)
    const running = dl.download('seg-cancel', [
      { url: server.url('/big.bin'), save_path: 'm/big.gguf', sha256: bigSha, size: big.length },
    ])
    await new Promise((resolve) => setTimeout(resolve, 50))
    dl.cancel('seg-cancel')
    await expect(running).rejects.toThrow(DOWNLOAD_CANCELLED)
  })

  it('never splits a file for the app, which sets no streams: one open-ended request', async () => {
    server.files.set('/big.bin', { body: big })
    const { dl } = await make()
    await dl.download('one', [
      { url: server.url('/big.bin'), save_path: 'm/big.gguf', sha256: bigSha, size: big.length },
    ])
    expect(server.requests.filter((r) => r.method === 'GET').map((r) => r.range ?? null)).toEqual([null])
  })

  it("keeps the app's progress cadence — every 10 MiB — however much time passes; streams add a timed report", async () => {
    // A clock that jumps a second per reading: any time-based report would fire on every chunk.
    let clock = 0
    const jumping = () => (clock += 1_000)
    const counted = async (streams?: number) => {
      server.files.set('/big.bin', { body: big, ranges: false })
      const { dl, events } = await make(streams, jumping)
      await dl.download('cadence', [
        { url: server.url('/big.bin'), save_path: 'm/big.gguf', size: big.length },
      ])
      return events.filter((e) => e.name === 'download:progress').length
    }
    const app = await counted()
    expect(app).toBeLessThanOrEqual(Math.ceil(big.length / PROGRESS_EMIT_INTERVAL_BYTES) + 2)
    expect(await counted(2)).toBeGreaterThan(app)
    expect(TIMED_PROGRESS_INTERVAL_MS).toBe(250)
  })

  it('lists a running task in snapshot() — zeros before its first report — and forgets it once it ends', async () => {
    server.files.set('/slow.bin', { body: small, delayMs: 300 })
    const { dl } = await make()
    const running = dl.download('snap', [
      { url: server.url('/slow.bin'), save_path: 'm/slow.bin', size: small.length },
    ])
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(dl.snapshot()).toEqual([{ taskId: 'snap', transferred: 0, total: 0, percent: 0 }])
    await running
    expect(dl.snapshot()).toEqual([])
  })

  it("keeps a running task's last reported progress in snapshot()", async () => {
    server.files.set('/big.bin', { body: big, delayMs: 300 })
    const { dl } = await make(2)
    const running = dl.download('snap-seg', [
      { url: server.url('/big.bin'), save_path: 'm/big.gguf', sha256: bigSha, size: big.length },
    ])
    await expect
      .poll(() => dl.snapshot()[0]?.transferred ?? 0, { timeout: 5_000, interval: 10 })
      .toBeGreaterThan(0)
    expect(dl.snapshot()[0]).toMatchObject({ taskId: 'snap-seg', total: big.length })
    await running
  })
})
