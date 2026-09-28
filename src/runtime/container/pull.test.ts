import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
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

/** A fake Docker Engine API: listens on a unix socket in a fresh temp dir, and answers with `lines`. */
function fakeEngineApi(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, requestUrl: string) => void
): Promise<string> {
  // `/tmp` directly (not `os.tmpdir()`, which on macOS resolves under a long `/var/folders/...`
  // path) so the unix socket path stays under the platform's ~104-byte limit.
  const dir = mkdtempSync(join('/tmp', 'docker-pull-test-'))
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

describe('pullImage', () => {
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

  it('aggregates progressDetail.current/.total across layers into onProgress', async () => {
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
