import { createHash } from 'node:crypto'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CoreEvents } from '../contracts/index.js'
import { FixtureHttpServer } from '../../test/helpers/fixture-http-server.js'
import { PROGRESS_EMIT_INTERVAL_BYTES } from './protocol.js'
import {
  canonicalizeExistingPrefix,
  defaultAvailableSpace,
  defaultSleep,
  DOWNLOAD_CANCELLED,
  Downloader,
} from './downloader.js'

const server = new FixtureHttpServer()
const body = Buffer.alloc(3 * 1024 * 1024)
for (let i = 0; i < body.length; i++) body[i] = i % 251
const sha = createHash('sha256').update(body).digest('hex')

type Emitted = { name: string; payload: unknown }

async function make(opts: { space?: number; platform?: NodeJS.Platform } = {}) {
  const dataFolder = await mkdtemp(join(tmpdir(), 'atomic-dl-'))
  const events: Emitted[] = []
  const dl = new Downloader({
    dataFolder,
    platform: opts.platform ?? 'linux',
    fetch,
    availableSpace: async () => opts.space,
    sleep: async () => {},
    emit: <K extends 'download:progress' | 'model:validation-started'>(name: K, payload: CoreEvents[K]) =>
      events.push({ name, payload }),
  })
  return { dl, dataFolder, events }
}

beforeAll(async () => {
  await server.start()
})
afterAll(async () => {
  await server.stop()
})

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false
  )

describe('Downloader', () => {
  it('downloads, verifies sha256 and size, reports progress and removes the sidecars', async () => {
    server.files.set('/ok.bin', { body })
    const { dl, dataFolder, events } = await make()
    await dl.download('t1', [
      {
        url: server.url('/ok.bin'),
        save_path: 'llamacpp/models/m/model.gguf',
        sha256: sha,
        size: body.length,
        model_id: 'm',
      },
    ])
    const out = join(dataFolder, 'llamacpp/models/m/model.gguf')
    expect((await readFile(out)).equals(body)).toBe(true)
    expect(await exists(`${out}.tmp`)).toBe(false)
    expect(await exists(`${out}.url`)).toBe(false)
    expect(
      events.some(
        (e) => e.name === 'model:validation-started' && (e.payload as { modelId: string }).modelId === 'm'
      )
    ).toBe(true)
    const last = events.filter((e) => e.name === 'download:progress').at(-1)?.payload as {
      transferred: number
      total: number
    }
    expect(last).toEqual({ taskId: 't1', transferred: body.length, total: body.length, percent: 100 })
    expect(dl.active()).toEqual([])
  })

  it('resumes a partial download with a Range request when the .url matches', async () => {
    server.files.set('/resume.bin', { body })
    const { dl, dataFolder } = await make()
    const out = join(dataFolder, 'llamacpp/models/r/model.gguf')
    await writeFile(`${out}.tmp`, body.subarray(0, 1000)).catch(async () => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(dataFolder, 'llamacpp/models/r'), { recursive: true })
      await writeFile(`${out}.tmp`, body.subarray(0, 1000))
    })
    await writeFile(`${out}.url`, server.url('/resume.bin'))
    server.requests.length = 0
    await dl.download(
      't2',
      [{ url: server.url('/resume.bin'), save_path: 'llamacpp/models/r/model.gguf', size: body.length }],
      { resume: true }
    )
    expect(server.requests.some((r) => r.method === 'GET' && r.range === 'bytes=1000-')).toBe(true)
    expect((await readFile(out)).equals(body)).toBe(true)
  })

  it('restarts from zero when the server ignores Range or the .url differs', async () => {
    server.files.set('/norange.bin', { body: body.subarray(0, 4096), ranges: false })
    const { dl, dataFolder } = await make()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dataFolder, 'x'), { recursive: true })
    await writeFile(join(dataFolder, 'x/f.bin.tmp'), Buffer.alloc(100))
    await writeFile(join(dataFolder, 'x/f.bin.url'), server.url('/norange.bin'))
    await dl.download('t3', [{ url: server.url('/norange.bin'), save_path: 'x/f.bin', size: 4096 }], {
      resume: true,
    })
    expect((await stat(join(dataFolder, 'x/f.bin'))).size).toBe(4096)

    await writeFile(join(dataFolder, 'x/g.bin.tmp'), Buffer.alloc(100))
    await writeFile(join(dataFolder, 'x/g.bin.url'), 'http://elsewhere/other')
    server.requests.length = 0
    await dl.download('t4', [{ url: server.url('/norange.bin'), save_path: 'x/g.bin', size: 4096 }], {
      resume: true,
    })
    expect(server.requests.every((r) => r.range === undefined)).toBe(true)
  })

  it('reconnects with a Range request after a dropped connection', async () => {
    server.files.set('/drop.bin', { body, dropAfterBytes: 500_000, dropTimes: 2 })
    const { dl, dataFolder } = await make()
    server.requests.length = 0
    await dl.download('t5', [
      { url: server.url('/drop.bin'), save_path: 'd/model.gguf', size: body.length, sha256: sha },
    ])
    expect(server.requests.filter((r) => r.range !== undefined).length).toBeGreaterThanOrEqual(1)
    expect((await readFile(join(dataFolder, 'd/model.gguf'))).equals(body)).toBe(true)
  })

  it('retries retryable statuses and gives up on fatal ones with the Rust message', async () => {
    server.files.set('/flaky.bin', { body: body.subarray(0, 10), failStatus: 503, failTimes: 2 })
    const { dl } = await make()
    await expect(
      dl.download('t6', [{ url: server.url('/flaky.bin'), save_path: 'f/a.bin', size: 10 }])
    ).resolves.toBeUndefined()
    server.files.set('/gone.bin', { body: body.subarray(0, 10), failStatus: 404, failTimes: 99 })
    await expect(
      dl.download('t7', [{ url: server.url('/gone.bin'), save_path: 'f/b.bin', size: 10 }])
    ).rejects.toThrow(/^Failed to download: HTTP status 404, scripted failure$/)
  })

  it('fails verification, deletes the file and its now-empty directory, keeps siblings', async () => {
    server.files.set('/bad.bin', { body: body.subarray(0, 2048) })
    const { dl, dataFolder } = await make()
    await expect(
      dl.download('t8', [
        { url: server.url('/bad.bin'), save_path: 'v/model.gguf', size: 2048, sha256: 'nope' },
      ])
    ).rejects.toThrow('Hash verification failed. The downloaded file is corrupted or has been tampered with.')
    expect(await exists(join(dataFolder, 'v/model.gguf'))).toBe(false)
    expect(await exists(join(dataFolder, 'v'))).toBe(false)
    // A wrong catalog size is caught by the transfer itself (as in Rust), before verification runs.
    await expect(
      dl.download('t9', [{ url: server.url('/bad.bin'), save_path: 'w/model.gguf', size: 1 }])
    ).rejects.toThrow(
      /^Incomplete download for .* expected 1 bytes but received 2048 bytes; partial file was kept for resume$/
    )
    expect(await exists(join(dataFolder, 'w/model.gguf.tmp'))).toBe(true)
  })

  it('refuses paths outside the data folder, over the Windows limit, and without free space', async () => {
    const { dl } = await make({ space: 10 })
    server.files.set('/small.bin', { body: body.subarray(0, 10) })
    await expect(
      dl.download('t10', [{ url: server.url('/small.bin'), save_path: '../escape.bin', size: 10 }])
    ).rejects.toThrow(/is outside of Jan data folder/)
    await expect(
      dl.download('t11', [{ url: server.url('/small.bin'), save_path: 'x.bin', size: 10 }])
    ).rejects.toThrow(/^Error: \[disk_full\]/)
    const win = await make({ platform: 'win32' })
    await expect(
      win.dl.download('t12', [
        { url: server.url('/small.bin'), save_path: `${'x'.repeat(300)}/x.bin`, size: 10 },
      ])
    ).rejects.toThrow(/^Error: \[disk_path_too_long\]/)
  })

  it('cancel aborts the transfer and keeps the partial; a same-id call supersedes', async () => {
    server.files.set('/slow.bin', { body, delayMs: 300 })
    const { dl, dataFolder } = await make()
    const p = dl.download('t13', [
      { url: server.url('/slow.bin'), save_path: 'c/model.gguf', size: body.length },
    ])
    await new Promise((r) => setTimeout(r, 30))
    expect(dl.cancel('t13')).toBe(true)
    await expect(p).rejects.toThrow(DOWNLOAD_CANCELLED)
    expect(await exists(join(dataFolder, 'c/model.gguf.url'))).toBe(true)
    expect(dl.cancel('t13')).toBe(false)

    const first = dl.download('same', [
      { url: server.url('/slow.bin'), save_path: 's/a.gguf', size: body.length },
    ])
    const second = dl.download('same', [
      { url: server.url('/slow.bin'), save_path: 's/a.gguf', size: body.length },
    ])
    await expect(first).rejects.toThrow(DOWNLOAD_CANCELLED)
    await expect(second).resolves.toBeUndefined()
  })

  it('treats an unknown size as open-ended and fails an incomplete known size', async () => {
    server.files.set('/nolen.bin', { body: body.subarray(0, 100), noHeadLength: true })
    const { dl, dataFolder } = await make()
    await dl.download('t14', [{ url: server.url('/nolen.bin'), save_path: 'n/a.bin' }])
    expect((await stat(join(dataFolder, 'n/a.bin'))).size).toBe(100)
    server.files.set('/short.bin', { body: body.subarray(0, 100) })
    await expect(
      dl.download('t15', [{ url: server.url('/short.bin'), save_path: 'n/b.bin', size: 5000 }])
    ).rejects.toThrow(/Download failed after 5 retries at byte 100/)
    expect(await exists(join(dataFolder, 'n/b.bin.tmp'))).toBe(true)
  })

  it('rejects an invalid proxy config before touching the network', async () => {
    const { dl } = await make()
    await expect(
      dl.download('t16', [{ url: server.url('/ok.bin'), save_path: 'p/a.bin', proxy: { url: 'ftp://p' } }])
    ).rejects.toThrow('Error: Unsupported proxy scheme: ftp')
  })
})

describe('helpers', () => {
  it('defaultSleep resolves after the delay and rejects as cancelled on abort, before or during', async () => {
    const t0 = Date.now()
    await defaultSleep(20, new AbortController().signal)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15)
    await expect(defaultSleep(10, AbortSignal.abort())).rejects.toThrow(DOWNLOAD_CANCELLED)
    const controller = new AbortController()
    const pending = defaultSleep(10_000, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow(DOWNLOAD_CANCELLED)
  })

  it('canonicalizeExistingPrefix resolves the existing part and keeps the rest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-canon-'))
    const real = await canonicalizeExistingPrefix(join(dir, 'a', 'b', 'c.bin'))
    expect(real.endsWith(join('a', 'b', 'c.bin'))).toBe(true)
    expect(real.startsWith(await canonicalizeExistingPrefix(dir))).toBe(true)
  })
  it('defaultAvailableSpace reports a number for an existing or future path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-space-'))
    expect(typeof (await defaultAvailableSpace(join(dir, 'not', 'yet')))).toBe('number')
  })
})

describe('the progress cadence the app draws its bar from', () => {
  it('reports on the 10 MiB boundary and always finishes on the total', async () => {
    // The app's bar is fed by one event stream and nothing else. Two properties it depends on: the
    // events are sparse enough not to flood the webview (hence the 10 MiB step), and the last one
    // says the transfer reached the total — a bar that stops at 97 % never completes.
    const size = Math.round(PROGRESS_EMIT_INTERVAL_BYTES * 2.5)
    const big = Buffer.alloc(size, 0x41)
    server.files.set('/big.bin', { body: big })
    const { dl, events } = await make()

    await dl.download('cadence', [{ url: server.url('/big.bin'), save_path: 'x/big.bin' }])

    const progress = events
      .filter((e) => e.name === 'download:progress')
      .map((e) => e.payload as { taskId: string; transferred: number; total: number })

    expect(progress.length, 'sparse, not one event per chunk').toBeLessThan(6)
    expect(progress.every((p) => p.taskId === 'cadence')).toBe(true)
    expect(progress.at(-1)?.transferred).toBe(size)
    expect(progress.at(-1)?.total).toBe(size)

    // Monotonic: a bar that goes backwards is a bar the user stops believing.
    const transferred = progress.map((p) => p.transferred)
    expect([...transferred].sort((a, b) => a - b)).toEqual(transferred)
  })

  it('names every event after the task the caller gave, which is what the listener keys on', async () => {
    server.files.set('/named.bin', { body })
    const { dl, events } = await make()

    await dl.download('llamacpp-backend-b6325/macos-arm64', [
      { url: server.url('/named.bin'), save_path: 'x/named.bin' },
    ])

    const tasks = new Set(
      events
        .filter((e) => e.name === 'download:progress')
        .map((e) => (e.payload as { taskId: string }).taskId)
    )
    expect([...tasks]).toEqual(['llamacpp-backend-b6325/macos-arm64'])
  })
})
