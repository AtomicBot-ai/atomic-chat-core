/**
 * A `WorkerLike` that stands in for the Worker of `geniex-host`, so `WorkerEngine`, the server and
 * the host run under vitest without Bun. Everything but a generation goes through the Worker's own
 * handler (`worker-protocol.ts`) on a fake library, delivered on a microtask as a real Worker's
 * messages would be. A generation is played as the real Worker plays it from its own thread: one
 * token at a time, asynchronously, reading the shared cancel flag before each — which an in-thread
 * call could never do, since the main thread would be blocked for the whole of it.
 */

import type { WorkerLike } from '../../src/runtime/geniex/host/engine.js'
import { createGeniexWorkerHandler } from '../../src/runtime/geniex/host/worker-protocol.js'
import type {
  GeniexWorkerAnswer,
  GeniexWorkerRequest,
} from '../../src/runtime/geniex/host/worker-protocol.js'
import type { FakeGeniexLibrary } from './fake-geniex-library.js'

export class FakeGeniexWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null
  onerror: WorkerLike['onerror'] = null
  terminated = false
  /** The next request kills the Worker with this message instead of answering. */
  crashOnNext: string | null = null
  readonly requests: GeniexWorkerRequest[] = []
  readonly loads: string[] = []
  private readonly handle: (request: GeniexWorkerRequest) => Promise<void>
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly library: FakeGeniexLibrary) {
    this.handle = createGeniexWorkerHandler({
      loadLibrary: async (libDir) => {
        this.loads.push(libDir)
        return library
      },
      post: (answer) => this.post(answer),
    })
  }

  private post(answer: GeniexWorkerAnswer): void {
    queueMicrotask(() => this.onmessage?.({ data: answer }))
  }

  postMessage(message: unknown): void {
    const request = message as GeniexWorkerRequest
    this.requests.push(request)
    if (this.crashOnNext !== null) {
      const text = this.crashOnNext
      this.crashOnNext = null
      queueMicrotask(() => this.onerror?.({ message: text }))
      return
    }
    // One message at a time, as the Worker handles them.
    this.tail = this.tail.then(() =>
      request.type === 'generate' ? this.generate(request) : this.handle(request)
    )
  }

  private async generate(request: Extract<GeniexWorkerRequest, { type: 'generate' }>): Promise<void> {
    const model = this.library.models.at(-1)
    if (!model) return this.post({ type: 'error', id: request.id, message: 'no model', code: null })
    const flag = new Int32Array(request.cancel)
    this.library.active++
    this.library.maxActive = Math.max(this.library.maxActive, this.library.active)
    try {
      const scripted = model.plan(request.prompt, request.config)
      if (!Array.isArray(scripted))
        return this.post({
          type: 'error',
          id: request.id,
          message: `llm_generate: ${scripted.error}`,
          code: scripted.code ?? -200101,
        })
      let given = 0
      for (const token of scripted) {
        if (this.library.tokenDelayMs > 0)
          await new Promise((resolve) => setTimeout(resolve, this.library.tokenDelayMs))
        else await new Promise((resolve) => setImmediate(resolve))
        if (Atomics.load(flag, 0) !== 0) {
          model.delivered.push(given)
          return this.post({
            type: 'done',
            id: request.id,
            result: { stopReason: 'cancelled', promptTokens: 0, generatedTokens: 0 },
          })
        }
        this.post({ type: 'token', id: request.id, text: token })
        given++
      }
      this.post({ type: 'done', id: request.id, result: model.result(request.prompt, scripted, given) })
    } finally {
      this.library.active--
    }
  }

  terminate(): void {
    this.terminated = true
  }
}
