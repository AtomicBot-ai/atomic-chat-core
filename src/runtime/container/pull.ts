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
 * streams byte counts, so there is no argv to build for this one operation.
 */
import http from 'node:http'
import { AtomicCoreError } from '../../contracts/index.js'
import { assertDigest, assertSafeArgvValue } from './argv.js'
import type { ImageRef, PullProgress, PullProgressCallback } from './types.js'

const DEFAULT_SOCKET_PATH = '/var/run/docker.sock'

export interface PullImageOptions {
  /** Default `/var/run/docker.sock`; tests point this at a fake Engine API. */
  socketPath?: string
  onProgress?: PullProgressCallback
  signal?: AbortSignal
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
 * `error` line; rejects with `AtomicCoreError('IO_ERROR', ...)` for a non-200 response, an `error`
 * line, a stream failure, or an unreachable socket. `onProgress` receives the sum of every layer's
 * reported `current`/`total` seen so far — a status-only line (e.g. "Already exists", the digest
 * line at the end) reports nothing and contributes nothing.
 */
export async function pullImage(image: ImageRef, options: PullImageOptions = {}): Promise<void> {
  // An `async` function: a validation failure below becomes a rejected promise, never a synchronous
  // throw, so every caller can treat `pullImage` uniformly as `.catch`/`await`-able I/O.
  const repository = assertSafeArgvValue(image.repository, 'image repository')
  const digest = assertDigest(image.digest, 'image digest')
  const socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH
  const path = `/images/create?fromImage=${encodeURIComponent(repository)}&tag=${encodeURIComponent(digest)}`

  return new Promise((resolve, reject) => {
    const layers = new Map<string, PullProgress>()
    let buffer = ''
    let settled = false

    const finish = (outcome: { ok: true } | { ok: false; error: Error }): void => {
      if (settled) return
      settled = true
      if (options.signal) options.signal.removeEventListener('abort', onAbort)
      if (outcome.ok) resolve()
      else reject(outcome.error)
    }

    const reportProgress = (): void => {
      if (!options.onProgress) return
      let current = 0
      let total = 0
      for (const layer of layers.values()) {
        current += layer.current
        total += layer.total
      }
      options.onProgress({ current, total })
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
      if (parsed.id && parsed.progressDetail && typeof parsed.progressDetail.current === 'number') {
        layers.set(parsed.id, {
          current: parsed.progressDetail.current,
          total: parsed.progressDetail.total ?? 0,
        })
        reportProgress()
      }
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
      res.on('end', () => finish({ ok: true }))
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
