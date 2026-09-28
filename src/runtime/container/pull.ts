/**
 * Pulling the model image by digest, over the Docker Engine API rather than `docker pull` (task 2.8
 * controller ruling). The `docker` CLI prints no byte progress at all unless attached to a TTY —
 * `distribution/pull.go`'s progress writer special-cases an interactive terminal, and this core
 * never runs one — but spec `tensorrt-llm-runtime` needs byte progress for an image tens of
 * gigabytes large. `POST /images/create?fromImage=<repo>&tag=<digest>` streams one JSON object per
 * line, one per layer per progress tick; this aggregates every layer's `progressDetail.current`/
 * `.total` into a single running total and reports it after each update. See
 * `docs/decisions/2026-09-28-pull-the-model-image-over-the-docker-engine-api.md`.
 *
 * This talks to the Engine API directly over its unix socket (`node:http`'s `socketPath`, injectable
 * for tests) rather than through `exec.ts`'s `DockerExec` — there is no docker CLI subcommand that
 * streams byte counts, so there is no argv to build for this one operation. The default socket path
 * is `argv.ts`'s `DOCKER_SOCKET_PATH`, not a separate literal (review round 1, item 15).
 */
import http from 'node:http'
import { AtomicCoreError } from '../../contracts/index.js'
import { DOCKER_SOCKET_PATH, assertDigest, assertSafeArgvValue } from './argv.js'
import { inspectImage } from './operations.js'
import type { DockerExec, ImageRef, PullProgress, PullProgressCallback } from './types.js'

export interface PullImageOptions {
  /** Default derived from `argv.ts`'s `DOCKER_SOCKET_PATH` (review round 1, item 15 — one socket path constant); tests point this at a fake Engine API. */
  socketPath?: string
  onProgress?: PullProgressCallback
  signal?: AbortSignal
  /**
   * A known total byte size (e.g. the descriptor's `download_bytes`) used instead of the stream's
   * own running total whenever it is larger. The stream's total only sums layers that have already
   * reported at least one `Downloading` line, so early in a pull it always undercounts (review round
   * 1, item 4).
   */
  knownTotalBytes?: number
  /**
   * After a successful pull, confirm `image` is actually present locally via `operations.ts`'s
   * `inspectImage` (review round 1, item 10). Optional: a caller that only has the Engine API socket
   * and no `DockerExec` yet (as every test in this file does) can omit it and skip verification.
   */
  verify?: DockerExec
}

interface ProgressDetail {
  current?: number
  total?: number
}

interface ProgressLine {
  id?: string
  status?: string
  progressDetail?: ProgressDetail
  error?: string
  errorDetail?: { message?: string }
}

function ioError(message: string, details?: string): AtomicCoreError {
  return new AtomicCoreError('IO_ERROR', message, details)
}

/**
 * Pulls `image.repository@image.digest`. Resolves once the daemon's response stream ends without an
 * `error` line (and, if `options.verify` is given, once `inspectImage` confirms the image is present
 * locally); rejects with `AtomicCoreError('IO_ERROR', ...)` for a non-200 response, an `error` line,
 * a stream failure, an unreachable socket, or a failed post-pull verification.
 */
export async function pullImage(image: ImageRef, options: PullImageOptions = {}): Promise<void> {
  // An `async` function: a validation failure below becomes a rejected promise, never a synchronous
  // throw, so every caller can treat `pullImage` uniformly as `.catch`/`await`-able I/O.
  const repository = assertSafeArgvValue(image.repository, 'image repository')
  const digest = assertDigest(image.digest, 'image digest')
  const socketPath = options.socketPath ?? DOCKER_SOCKET_PATH
  const path = `/images/create?fromImage=${encodeURIComponent(repository)}&tag=${encodeURIComponent(digest)}`

  await streamPull(path, socketPath, options)

  if (options.verify) {
    const { found } = await inspectImage(options.verify, image)
    if (!found) {
      throw ioError(
        'Docker image pull completed but the image is not present locally.',
        `${repository}@${digest}`
      )
    }
  }
}

/**
 * Aggregates byte progress across layers. Only a `status: 'Downloading'` line counts: the same layer
 * `id` is reused for `Extracting` (and other phases) with its *own*, unrelated `progressDetail`, so
 * folding every phase into one sum makes the total regress as a layer moves from "fully downloaded"
 * to "partway extracted" (review round 1, item 4 — the non-monotonic bug). Each layer's contribution
 * is the running *max* ever reported for it (defensive: a real `Downloading` sequence is already
 * monotonic, but this does not trust that), clamped to that layer's own total.
 */
class PullProgressTracker {
  private readonly layers = new Map<string, PullProgress>()

  constructor(private readonly knownTotalBytes: number | undefined) {}

  /** Returns the new aggregate to report, or `undefined` if this line contributes nothing. */
  observe(parsed: ProgressLine): PullProgress | undefined {
    if (parsed.status !== 'Downloading') return undefined
    if (!parsed.id || !parsed.progressDetail || typeof parsed.progressDetail.current !== 'number')
      return undefined
    const total = parsed.progressDetail.total ?? 0
    const current = total > 0 ? Math.min(parsed.progressDetail.current, total) : parsed.progressDetail.current
    const existing = this.layers.get(parsed.id)
    this.layers.set(parsed.id, {
      current: existing ? Math.max(existing.current, current) : current,
      total: existing ? Math.max(existing.total, total) : total,
    })
    return this.aggregate()
  }

  private aggregate(): PullProgress {
    let current = 0
    let streamTotal = 0
    for (const layer of this.layers.values()) {
      current += layer.current
      streamTotal += layer.total
    }
    const total =
      this.knownTotalBytes !== undefined ? Math.max(streamTotal, this.knownTotalBytes) : streamTotal
    return { current: total > 0 ? Math.min(current, total) : current, total }
  }
}

function streamPull(path: string, socketPath: string, options: PullImageOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const tracker = new PullProgressTracker(options.knownTotalBytes)
    let buffer = ''
    let settled = false

    const finish = (outcome: { ok: true } | { ok: false; error: Error }): void => {
      if (settled) return
      settled = true
      if (options.signal) options.signal.removeEventListener('abort', onAbort)
      if (outcome.ok) resolve()
      else reject(outcome.error)
    }

    const reportProgress = (progress: PullProgress): void => {
      if (!options.onProgress) return
      try {
        options.onProgress(progress)
      } catch {
        // A caller's progress callback misbehaving must not abort a multi-gigabyte pull that is
        // otherwise proceeding fine (review round 1, item 11).
      }
    }

    const handleLine = (line: string, req: http.ClientRequest): void => {
      if (line.trim() === '') return
      let parsed: ProgressLine
      try {
        parsed = JSON.parse(line) as ProgressLine
      } catch {
        return // a partial/non-JSON line; one bad line should not fail the whole pull
      }
      if (parsed.error) {
        finish({
          ok: false,
          error: ioError('Docker image pull failed.', parsed.errorDetail?.message ?? parsed.error),
        })
        req.destroy()
        return
      }
      const progress = tracker.observe(parsed)
      if (progress) reportProgress(progress)
    }

    const req = http.request({ socketPath, path, method: 'POST' }, (res) => {
      if (res.statusCode !== 200) {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => {
          finish({
            ok: false,
            error: ioError(`Docker image pull failed with status ${res.statusCode}.`, body),
          })
        })
        return
      }
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buffer += chunk
        let newlineIndex: number
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIndex)
          buffer = buffer.slice(newlineIndex + 1)
          handleLine(line, req)
          if (settled) return
        }
      })
      res.on('end', () => {
        // The stream can end with a final line that never got a trailing `\n` (review round 1, item
        // 10): flush whatever is left in `buffer` before declaring the pull done.
        if (!settled && buffer.trim() !== '') handleLine(buffer, req)
        buffer = ''
        finish({ ok: true })
      })
      res.on('error', (error) =>
        finish({ ok: false, error: ioError('Docker image pull stream failed.', error.message) })
      )
    })

    req.on('error', (error) =>
      finish({ ok: false, error: ioError('Could not reach the Docker daemon.', error.message) })
    )

    const onAbort = (): void => {
      req.destroy()
      finish({ ok: false, error: new AtomicCoreError('MODEL_LOAD_CANCELLED', 'Image pull was cancelled.') })
    }
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    req.end()
  })
}
