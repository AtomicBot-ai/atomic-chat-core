import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { DockerExec } from './types.js'
import { pullImage, pullImageWithCurl } from './pull.js'

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

  it('never reports current > total when a Downloading line has no total at all (review round 2, item 1)', async () => {
    const socketPath = await fakeEngineApi((_req, res) => {
      ndjson(res, [{ id: 'layer1', status: 'Downloading', progressDetail: { current: 1234 } }])
    })
    const progress: Array<{ current: number; total: number }> = []
    await pullImage(image, { socketPath, onProgress: (p) => progress.push({ ...p }) })
    expect(progress).toEqual([{ current: 1234, total: 1234 }])
    for (const p of progress) expect(p.current).toBeLessThanOrEqual(p.total)
  })

  it('never reports current > total when a Downloading line reports total: 0 (review round 2, item 1)', async () => {
    const socketPath = await fakeEngineApi((_req, res) => {
      ndjson(res, [{ id: 'layer1', status: 'Downloading', progressDetail: { current: 777, total: 0 } }])
    })
    const progress: Array<{ current: number; total: number }> = []
    await pullImage(image, { socketPath, onProgress: (p) => progress.push({ ...p }) })
    expect(progress).toEqual([{ current: 777, total: 777 }])
    for (const p of progress) expect(p.current).toBeLessThanOrEqual(p.total)
  })

  it('folds a later line that does report the real total into the layer, without ever exceeding it (review round 2, item 1)', async () => {
    const socketPath = await fakeEngineApi((_req, res) => {
      ndjson(res, [
        // First tick: no total yet (common at the very start of a layer's download).
        { id: 'layer1', status: 'Downloading', progressDetail: { current: 500 } },
        // A second layer that never reports a total at all, mixed in.
        { id: 'layer2', status: 'Downloading', progressDetail: { current: 200, total: 0 } },
        // Then layer1 reports its real total.
        { id: 'layer1', status: 'Downloading', progressDetail: { current: 2000, total: 5000 } },
      ])
    })
    const progress: Array<{ current: number; total: number }> = []
    await pullImage(image, { socketPath, onProgress: (p) => progress.push({ ...p }) })
    expect(progress).toHaveLength(3)
    for (let i = 0; i < progress.length; i++) {
      expect(progress[i]!.current).toBeLessThanOrEqual(progress[i]!.total)
      if (i > 0) expect(progress[i]!.current).toBeGreaterThanOrEqual(progress[i - 1]!.current)
    }
    // layer1 ends at 2000/5000, layer2 stays at 200/200 (its own total inflated to its current).
    expect(progress[2]).toEqual({ current: 2200, total: 5200 })
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

describe('pullImageWithCurl (inside a WSL guest, design D4 of add-tensorrt-llm-windows)', () => {
  const IMAGE_REF = { repository: 'nvcr.io/nvidia/cuda', digest: `sha256:${'f'.repeat(64)}` as const }
  const lines = (...objects: object[]): string => objects.map((o) => `${JSON.stringify(o)}\n`).join('')

  it('asks the guest’s Engine API over its socket with curl — never a shell — and streams byte progress', async () => {
    const seen: { argv: string[] }[] = []
    const progress: { current: number; total: number }[] = []
    await pullImageWithCurl(IMAGE_REF, {
      run: async (argv, call) => {
        seen.push({ argv })
        // Two chunks, the first ending mid-line: the reader joins them before parsing.
        const text = lines(
          { status: 'Downloading', id: 'a', progressDetail: { current: 5, total: 10 } },
          { status: 'Downloading', id: 'a', progressDetail: { current: 10, total: 10 } }
        )
        call.onStdout(text.slice(0, 20))
        call.onStdout(text.slice(20))
        return { code: 0, stdout: text, stderr: '' }
      },
      onProgress: (p) => progress.push(p),
    })
    expect(seen[0]?.argv).toEqual([
      'curl',
      '--silent',
      '--show-error',
      '--no-buffer',
      '--fail-with-body',
      '--unix-socket',
      '/var/run/docker.sock',
      '-X',
      'POST',
      `http://localhost/images/create?fromImage=${encodeURIComponent('nvcr.io/nvidia/cuda')}&tag=${encodeURIComponent(IMAGE_REF.digest)}`,
    ])
    expect(progress).toEqual([
      { current: 5, total: 10 },
      { current: 10, total: 10 },
    ])
  })

  it('fails on an error line, as the socket pull does', async () => {
    await expect(
      pullImageWithCurl(IMAGE_REF, {
        run: async (_argv, call) => {
          const text = lines({ error: 'manifest unknown', errorDetail: { message: 'manifest unknown' } })
          call.onStdout(text)
          return { code: 0, stdout: text, stderr: '' }
        },
      })
    ).rejects.toMatchObject({ code: 'IO_ERROR', details: 'manifest unknown' })
  })

  it('fails when curl itself failed, with what it said', async () => {
    await expect(
      pullImageWithCurl(IMAGE_REF, {
        run: async () => ({ code: 7, stdout: '', stderr: 'curl: (7) Failed to connect' }),
      })
    ).rejects.toMatchObject({ code: 'IO_ERROR', details: expect.stringContaining('Failed to connect') })
  })

  it('is cancelled by its signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      pullImageWithCurl(IMAGE_REF, {
        run: async () => ({ code: null, stdout: '', stderr: 'aborted' }),
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
  })

  it('verifies the image is there afterwards, when asked', async () => {
    await expect(
      pullImageWithCurl(IMAGE_REF, {
        run: async () => ({ code: 0, stdout: '', stderr: '' }),
        verify: async () => ({ code: 1, stdout: '[]', stderr: 'Error: No such image' }),
      })
    ).rejects.toMatchObject({ code: 'IO_ERROR' })
  })
})
