/**
 * Scripted HTTP server for download tests: serves in-memory files with Range/206 support, and lets a
 * test inject failures (drop the connection after N bytes, answer a status, refuse Range).
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

export interface ServedFile {
  body: Buffer
  /** Serve ranges (206) — default true. When false a Range request gets a full 200. */
  ranges?: boolean
  /** Close the socket after this many bytes of the first N responses. */
  dropAfterBytes?: number
  dropTimes?: number
  /** Answer this status (with a small body) for the first N requests. */
  failStatus?: number
  failTimes?: number
  /** Omit Content-Length on HEAD. */
  noHeadLength?: boolean
  /** Send this Content-Range instead of the correct one. */
  badContentRange?: string
  /** Wait before sending the body (lets a test cancel mid-flight). */
  delayMs?: number
}

export class FixtureHttpServer {
  readonly files = new Map<string, ServedFile>()
  readonly requests: Array<{ method: string; path: string; range?: string }> = []
  private server: Server | undefined
  private port = 0
  private drops = new Map<string, number>()
  private fails = new Map<string, number>()

  async start(): Promise<string> {
    this.server = createServer((req, res) => this.handle(req, res))
    await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', r))
    const addr = this.server.address()
    this.port = typeof addr === 'object' && addr ? addr.port : 0
    return `http://127.0.0.1:${this.port}`
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()))
  }

  url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`
  }

  private handle(req: IncomingMessage, res: ServerResponse) {
    const path = req.url ?? '/'
    const range = req.headers.range
    this.requests.push({ method: req.method ?? '', path, ...(range ? { range } : {}) })
    const file = this.files.get(path)
    if (!file) {
      res.writeHead(404).end('not found')
      return
    }
    const failsLeft = this.fails.get(path) ?? file.failTimes ?? 0
    if (file.failStatus && failsLeft > 0) {
      this.fails.set(path, failsLeft - 1)
      res.writeHead(file.failStatus).end('scripted failure')
      return
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, file.noHeadLength ? {} : { 'content-length': String(file.body.length) }).end()
      return
    }
    let start = 0
    let status = 200
    const headers: Record<string, string> = {}
    if (range && file.ranges !== false) {
      const m = /^bytes=(\d+)-$/.exec(range)
      if (m) {
        start = Number(m[1])
        if (start >= file.body.length) {
          res.writeHead(416).end()
          return
        }
        status = 206
        headers['content-range'] =
          file.badContentRange ?? `bytes ${start}-${file.body.length - 1}/${file.body.length}`
      }
    }
    const slice = file.body.subarray(start)
    headers['content-length'] = String(slice.length)
    res.writeHead(status, headers)
    const dropsLeft = this.drops.get(path) ?? file.dropTimes ?? 0
    if (file.dropAfterBytes !== undefined && dropsLeft > 0) {
      this.drops.set(path, dropsLeft - 1)
      // Flush the partial body, then kill the socket so the client sees a truncated stream.
      res.write(slice.subarray(0, file.dropAfterBytes), () => setTimeout(() => res.socket?.destroy(), 20))
      return
    }
    if (file.delayMs) setTimeout(() => res.end(slice), file.delayMs)
    else res.end(slice)
  }
}
