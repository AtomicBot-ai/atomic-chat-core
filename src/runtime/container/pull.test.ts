import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { DockerExec } from './types.js'
import { pullImage } from './pull.js'

const image = {
  repository: 'nvcr.io/nvidia/tensorrt-llm/release',
  digest: `sha256:${'a'.repeat(64)}`,
} as const

const servers: http.Server[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A fake Docker Engine API: listens on a unix socket in a fresh temp dir, and answers with `lines`.
 * Uses `os.tmpdir()` (review round 1, item 6), not a hardcoded `/tmp`: this whole suite is
 * `skipIf(win32)` below, and on every platform this runs on the resulting socket path is well under
 * the ~104-byte `sockaddr_un` limit (verified: `os.tmpdir()` + this prefix + `docker.sock` is under
 * 90 bytes even under macOS's longer `/var/folders/...` temp root).
 */
function fakeEngineApi(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, requestUrl: string) => void
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'docker-pull-test-'))
  dirs.push(dir)
  const socketPath = join(dir, 'docker.sock')
  const server = http.createServer((req, res) => handler(req, res, req.url ?? ''))
  servers.push(server)
  return new Promise((resolve) => server.listen(socketPath, () => resolve(socketPath)))
}

function ndjson(res: http.ServerResponse, lines: unknown[], status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  for (const line of lines) res.write(JSON.stringify(line) + '\n')
  res.end()
}

/** Writes lines with no trailing `\n` after the last one (review round 1, item 10: flush the tail). */
function ndjsonNoTrailingNewline(res: http.ServerResponse, lines: unknown[]): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.write(lines.map((line) => JSON.stringify(line)).join('\n'))
  res.end()
}

describe.skipIf(process.platform === 'win32')('pullImage', () => {
  it('requests POST /images/create?fromImage=<repo>&tag=<digest>', async () => {
    let seenMethod = ''
    let seenUrl = ''
    const socketPath = await fakeEngineApi((req, res, url) => {
      seenMethod = req.method ?? ''
      seenUrl = url
      ndjson(res, [{ status: 'Pulling from nvidia/tensorrt-llm/release' }])
    })
    await pullImage(image, { socketPath })
    expect(seenMethod).toBe('POST')
    expect(seenUrl).toBe(
      `/images/create?fromImage=${encodeURIComponent(image.repository)}&tag=${encodeURIComponent(image.digest)}`
    )
  })

  it('aggregates progressDetail.current/.total across Downloading layers into onProgress', async () => {
    const socketPath = await fakeEngineApi((_req, res) => {
      ndjson(res, [
        { id: 'layer1', status: 'Downloading', progressDetail: { current: 1000, total: 5000 } },
        { id: 'layer2', status: 'Downloading', progressDetail: { current: 2000, total: 8000 } },
        { id: 'layer1', status: 'Downloading', progressDetail: { current: 3000, total: 5000 } },
        { status: 'Digest: sha256:...' },
      ])
    })
    const progress: Array<{ current: number; total: number }> = []
    await pullImage(image, { socketPath, onProgress: (p) => progress.push({ ...p }) })
    expect(progress.length).toBeGreaterThan(0)
    const last = progress[progress.length - 1]!
    // layer1 ends at 3000/5000, layer2 at 2000/8000: summed current 5000, summed total 13000.
    expect(last).toEqual({ current: 5000, total: 13000 })
  })

  it('ignores a status-only line with no progressDetail (e.g. "Already exists")', async () => {
    const socketPath = await fakeEngineApi((_req, res) => {
      ndjson(res, [{ id: 'layer1', status: 'Already exists' }])
    })
    const progress: Array<{ current: number; total: number }> = []
    await pullImage(image, { socketPath, onProgress: (p) => progress.push(p) })
    expect(progress).toEqual([])
  })

  it('does not regress when a layer reports Extracting with its own, unrelated progressDetail (review round 1, item 4)', async () => {
    const socketPath = await fakeEngineApi((_req, res) => {
      ndjson(res, [
        // layer1 finishes downloading at 5000/5000...
        { id: 'layer1', status: 'Downloading', progressDetail: { current: 5000, total: 5000 } },
        // ...then reports Extracting with its OWN progressDetail, starting low again. A naive
        // aggregator that sums every progressDetail regardless of status would see the total
        // regress from 5000 back down to near 0.
        { id: 'layer1', status: 'Extracting', progressDetail: { current: 100, total: 5000 } },
        { id: 'layer1', status: 'Extracting', progressDetail: { current: 4000, total: 5000 } },
      ])
    })
    const progress: Array<{ current: number; total: number }> = []
    await pullImage(image, { socketPath, onProgress: (p) => progress.push({ ...p }) })
    // Only the Downloading line counted; Extracting lines are ignored entirely, so progress never
    // moves at all here (a real pull already had its Downloading total by the time Extracting starts).
    expect(progress).toEqual([{ current: 5000, total: 5000 }])
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]!.current).toBeGreaterThanOrEqual(progress[i - 1]!.current)
    }
  })

  it('uses knownTotalBytes when it is larger than the stream-reported total, from the very first report (review round 1, item 4)', async () => {
    const socketPath = await fakeEngineApi((_req, res) => {
      ndjson(res, [{ id: 'layer1', status: 'Downloading', progressDetail: { current: 100, total: 5000 } }])
    })
    const progress: Array<{ current: number; total: number }> = []
    await pullImage(image, {
      socketPath,
      knownTotalBytes: 21_000_000_000,
      onProgress: (p) => progress.push({ ...p }),
    })
    expect(progress).toEqual([{ current: 100, total: 21_000_000_000 }])
  })

  it('parses a final line with no trailing newline instead of dropping it (review round 1, item 10)', async () => {
    const socketPath = await fakeEngineApi((_req, res) => {
      ndjsonNoTrailingNewline(res, [
        { id: 'layer1', status: 'Downloading', progressDetail: { current: 100, total: 5000 } },
      ])
    })
    const progress: Array<{ current: number; total: number }> = []
    await pullImage(image, { socketPath, onProgress: (p) => progress.push(p) })
    expect(progress).toEqual([{ current: 100, total: 5000 }])
  })

  it('confirms the image is present locally via inspectImage when options.verify is given (review round 1, item 10)', async () => {
    const socketPath = await fakeEngineApi((_req, res) => {
      ndjson(res, [{ status: 'Status: Downloaded newer image' }])
    })
    const verify: DockerExec = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify([{ Id: 'x' }]),
      stderr: '',
    }))
    await expect(pullImage(image, { socketPath, verify })).resolves.toBeUndefined()
    expect(verify).toHaveBeenCalled()
  })

  it('rejects with IO_ERROR when options.verify says the image is not present after a "successful" pull', async () => {
    const socketPath = await fakeEngineApi((_req, res) => {
      ndjson(res, [{ status: 'Status: Downloaded newer image' }])
    })
    const verify: DockerExec = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'Error: No such image: x' }))
    await expect(pullImage(image, { socketPath, verify })).rejects.toMatchObject({ code: 'IO_ERROR' })
  })

  it('does not verify when options.verify is omitted (every other test in this file relies on this)', async () => {
    const socketPath = await fakeEngineApi((_req, res) => {
      ndjson(res, [{ status: 'Status: Downloaded newer image' }])
    })
    await expect(pullImage(image, { socketPath })).resolves.toBeUndefined()
  })

  it('guards onProgress exceptions: a throwing callback never aborts the pull (review round 1, item 11)', async () => {
    const socketPath = await fakeEngineApi((_req, res) => {
      ndjson(res, [
        { id: 'layer1', status: 'Downloading', progressDetail: { current: 1000, total: 5000 } },
        { id: 'layer1', status: 'Downloading', progressDetail: { current: 5000, total: 5000 } },
      ])
    })
    let calls = 0
    await expect(
      pullImage(image, {
        socketPath,
        onProgress: () => {
          calls++
          throw new Error('boom')
        },
      })
    ).resolves.toBeUndefined()
    expect(calls).toBe(2)
  })

  it('rejects with IO_ERROR on an {"error": ...} line mid-stream', async () => {
    const socketPath = await fakeEngineApi((_req, res) => {
      ndjson(res, [
        { status: 'Pulling' },
        { error: 'manifest unknown', errorDetail: { message: 'manifest unknown: no such digest' } },
      ])
    })
    await expect(pullImage(image, { socketPath })).rejects.toMatchObject({
      code: 'IO_ERROR',
    })
  })

  it('rejects with IO_ERROR on a non-200 response', async () => {
    const socketPath = await fakeEngineApi((_req, res) => {
      res.writeHead(500)
      res.end('internal error')
    })
    await expect(pullImage(image, { socketPath })).rejects.toMatchObject({ code: 'IO_ERROR' })
  })

  it('rejects with IO_ERROR when the socket cannot be reached', async () => {
    await expect(
      pullImage(image, { socketPath: '/tmp/definitely-not-a-real-docker.sock' })
    ).rejects.toMatchObject({ code: 'IO_ERROR' })
  })

  it('refuses a hostile repository before making any request', async () => {
    const hostile = { repository: '-foo/bar', digest: image.digest }
    await expect(pullImage(hostile, { socketPath: '/tmp/unused.sock' })).rejects.toThrow(AtomicCoreError)
  })

  it('refuses a digest that is not sha256:<64 hex>', async () => {
    const bad = { repository: image.repository, digest: 'sha256:short' as never }
    await expect(pullImage(bad, { socketPath: '/tmp/unused.sock' })).rejects.toThrow(AtomicCoreError)
  })
})
