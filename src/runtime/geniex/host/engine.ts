/**
 * The main thread's handle on the Worker that owns the library (openspec change `add-geniex-runtime`,
 * design D1): one request at a time, each answered by the Worker's messages, tokens of a generation
 * delivered as they arrive. The Worker is the web-standard one of the Bun runtime; the tests drive
 * `WorkerEngine` with an in-process stand-in that runs the Worker's handler on a fake library.
 */

import { GeniexLibraryError } from './library.js'
import type {
  GeniexGenerateResult,
  GeniexGenerationConfig,
  GeniexModelSettings,
  GeniexTemplateInput,
} from './library.js'
import type { GeniexWorkerAnswer, GeniexWorkerRequest } from './worker-protocol.js'

/** What the engine needs of a Worker: the web `Worker` shape, which Bun's is. */
export interface WorkerLike {
  postMessage(message: unknown): void
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: { message?: string }) => void) | null
  terminate(): void
}

export interface GeniexProbeAnswer {
  version: string | null
  abi: number
  plugins: string[]
  devices: string[]
}

/** The host's asynchronous view of the library; `WorkerEngine` is the one implementation. */
export interface GeniexEngine {
  probe(libDir: string): Promise<GeniexProbeAnswer>
  create(libDir: string, settings: GeniexModelSettings): Promise<{ vision: boolean }>
  applyChatTemplate(input: GeniexTemplateInput): Promise<string>
  /**
   * Tokens arrive through `onToken` as the library makes them; `cancel` (one `Int32`, set non-zero)
   * ends the generation, which then resolves with `stopReason: 'cancelled'`.
   */
  generate(
    prompt: string,
    config: GeniexGenerationConfig,
    onToken: (token: string) => void,
    cancel: Int32Array
  ): Promise<GeniexGenerateResult>
  destroy(): Promise<void>
}

/** The Worker stopped before answering: a crash of the native library takes the Worker with it. */
export class GeniexWorkerGone extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GeniexWorkerGone'
  }
}

type Pending = { resolve: (answer: GeniexWorkerAnswer) => void; reject: (error: Error) => void }

export class WorkerEngine implements GeniexEngine {
  private tail: Promise<unknown> = Promise.resolve()
  private pending: Pending | null = null
  private onToken: ((token: string) => void) | null = null
  private nextId = 1
  private gone: Error | null = null

  constructor(private readonly worker: WorkerLike) {
    worker.onmessage = (event) => this.receive(event.data as GeniexWorkerAnswer)
    worker.onerror = (event) => {
      this.gone = new GeniexWorkerGone(`the GenieX worker failed: ${event.message ?? 'unknown error'}`)
      this.pending?.reject(this.gone)
      this.pending = null
    }
  }

  private receive(answer: GeniexWorkerAnswer): void {
    if (answer.type === 'token') {
      this.onToken?.(answer.text)
      return
    }
    const pending = this.pending
    this.pending = null
    pending?.resolve(answer)
  }

  /** One request, answered by the next non-token message; requests queue behind each other. */
  private ask(request: GeniexWorkerRequest): Promise<GeniexWorkerAnswer> {
    const run = this.tail.then(
      () =>
        new Promise<GeniexWorkerAnswer>((resolve, reject) => {
          if (this.gone) return reject(this.gone)
          this.pending = { resolve, reject }
          this.worker.postMessage(request)
        })
    )
    this.tail = run.catch(() => {})
    return run
  }

  private static refused(answer: GeniexWorkerAnswer, what: string): never {
    if (answer.type === 'failed' || answer.type === 'error')
      throw new GeniexLibraryError(
        answer.type === 'failed' ? answer.stage : what,
        answer.message,
        answer.code
      )
    throw new GeniexLibraryError(what, `unexpected answer ${answer.type}`)
  }

  async probe(libDir: string): Promise<GeniexProbeAnswer> {
    const answer = await this.ask({ type: 'probe', libDir })
    if (answer.type !== 'probed') WorkerEngine.refused(answer, 'probe')
    return { version: answer.version, abi: answer.abi, plugins: answer.plugins, devices: answer.devices }
  }

  async create(libDir: string, settings: GeniexModelSettings): Promise<{ vision: boolean }> {
    const answer = await this.ask({ type: 'create', libDir, settings })
    if (answer.type !== 'created') WorkerEngine.refused(answer, 'create')
    return { vision: answer.vision }
  }

  async applyChatTemplate(input: GeniexTemplateInput): Promise<string> {
    const answer = await this.ask({ type: 'template', id: this.nextId++, input })
    if (answer.type !== 'templated') WorkerEngine.refused(answer, 'apply_chat_template')
    return answer.prompt
  }

  async generate(
    prompt: string,
    config: GeniexGenerationConfig,
    onToken: (token: string) => void,
    cancel: Int32Array
  ): Promise<GeniexGenerateResult> {
    const buffer = cancel.buffer
    if (!(buffer instanceof SharedArrayBuffer))
      throw new GeniexLibraryError('generate', 'the cancel flag must live in a SharedArrayBuffer')
    this.onToken = onToken
    try {
      const answer = await this.ask({ type: 'generate', id: this.nextId++, prompt, config, cancel: buffer })
      if (answer.type !== 'done') WorkerEngine.refused(answer, 'generate')
      return answer.result
    } finally {
      this.onToken = null
    }
  }

  async destroy(): Promise<void> {
    try {
      if (!this.gone) await this.ask({ type: 'destroy' })
    } finally {
      this.worker.terminate()
    }
  }
}

/**
 * The Worker of the compiled binaries: `worker.ts`, bundled as its own entry (`scripts/build-binaries.mjs`,
 * `--entry-naming [name].[ext]`) and reached by the name the bundle gives it; under `bun src/…` the
 * same URL resolves to the source. Under Node there is no `Worker` global, and no host either.
 */
export function spawnGeniexWorker(): WorkerLike {
  const ctor = (globalThis as { Worker?: new (url: URL) => WorkerLike }).Worker
  if (!ctor)
    throw new GeniexLibraryError('load', 'geniex-host runs only inside a compiled binary (no Worker)')
  return new ctor(new URL('./worker.js', import.meta.url))
}
