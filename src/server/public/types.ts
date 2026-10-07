/**
 * What the public API server needs from the rest of the core, and how it is configured.
 *
 * Deliberately narrow and injected: the server is replayed against the Rust proxy's recorded
 * exchanges (`test/contract/proxy-http.test.ts`) with stub sessions, stub providers and a scripted
 * context-increase outcome, so none of this may reach for a runtime or a settings file directly.
 */

import type {
  CoreEvents,
  DiffusionErrorBody,
  DiffusionFamilyDefaults,
  DiffusionFamilyRanges,
  DiffusionModality,
  EmbeddingModality,
  GalleryListOptions,
  GalleryVideoItem,
  ImageGenerateRequest,
  ImageJob,
  VideoGalleryPage,
  VideoGenerateRequest,
  VideoJob,
} from '../../contracts/index.js'
import type { LocalProvider, RemoteProvider } from '../../router/index.js'
import type { ChatGptBackend } from '../../cloud/index.js'
import type { ErrorSink } from '../../telemetry/index.js'

/**
 * What a session whose engine declares its routes requires of this server (the runtime's
 * `SessionRoutePolicy`; `tensorrt-llm` today): refuse what it does not serve instead of forwarding it,
 * refuse `tools` it has no parser for, map the engine's own errors, and never grow or recreate it.
 */
export interface LocalTargetPolicy {
  routes: readonly { method: string; path: string }[]
  tools: boolean
  structuredOutput: boolean
  mapError: (status: number, body: string) => object | null
  /** The context the session was started with, when known: what `/muse-code/models` advertises. */
  contextLength?: number
  /** The per-request output cap the session enforces, when known. */
  maxOutputTokens?: number
}

/** A model a local engine is serving right now. */
export interface LocalTarget {
  provider: LocalProvider
  modelId: string
  port: number
  /** Per-session bearer the engine expects; empty for MLX, which has no auth layer. */
  apiKey: string
  isEmbedding: boolean
  /** Absent for an engine that takes every route (llama.cpp, MLX): the server's own defaults apply. */
  policy?: LocalTargetPolicy
}

/** What asking the owning runtime for a larger context produced. */
export interface CtxIncreaseOutcome {
  ok: boolean
  new_ctx_len?: number
  reason?: string
}

/** The resident image model as `POST /images/generations` needs it: who it is, and how a job runs. */
export interface ImagesBackend {
  /** The loaded model with the family defaults it was loaded with, or `undefined` when there is none. */
  loaded: () => { modelId: string; displayName: string; defaults: DiffusionFamilyDefaults } | undefined
  /** Start a job; `done` settles with the outcome and never rejects. */
  start: (request: ImageGenerateRequest) => Promise<{
    id: string
    done: Promise<
      { ok: true; outcome: { job: ImageJob; images: Buffer[] } } | { ok: false; error: DiffusionErrorBody }
    >
  }>
  /** Give up on a job the client no longer waits for. */
  cancel: (jobId: string) => Promise<unknown>
}

/** The resident video model as `/videos` needs it, plus the two places a video lives: the runner and the gallery. */
export interface VideosBackend {
  /** The loaded model with the family defaults and ranges it was loaded with, or `undefined` when there is none. */
  loaded: () =>
    | {
        modelId: string
        displayName: string
        modality: DiffusionModality
        defaults: DiffusionFamilyDefaults
        ranges: DiffusionFamilyRanges
      }
    | undefined
  /** Start a job; `done` settles with the outcome and never rejects. */
  start: (request: VideoGenerateRequest) => Promise<{
    id: string
    done: Promise<
      { ok: true; outcome: { job: VideoJob; images: Buffer[] } } | { ok: false; error: DiffusionErrorBody }
    >
  }>
  /** The runner's record of a job, while it keeps one. */
  job: (id: string) => VideoJob | null
  /** Every video job the runner remembers, newest first. */
  jobs: () => VideoJob[]
  /** The gallery's clip, which outlives the job record. */
  item: (id: string) => Promise<GalleryVideoItem | null>
  list: (options: GalleryListOptions) => Promise<VideoGalleryPage>
  cancel: (jobId: string) => Promise<unknown>
  delete: (id: string) => Promise<void>
}

/** The running decision process as `/systemone` and `/router/score` need it: where to forward, with which key. */
export type DecisionTarget =
  | {
      ok: true
      port: number
      /** The process's own bearer key; the client's key for this server never reaches it. */
      apiKey: string
      /**
       * The engine paths the process serves (`/props.decision.endpoints`, or the core's for upstream);
       * absent when it did not say, and then every route is forwarded.
       */
      endpoints?: readonly string[]
      /** Called once the answer has been relayed (or abandoned): the idle unload counts from here. */
      release: () => void
    }
  | { ok: false; reason: string; message: string }

export interface DecisionBackend {
  /**
   * The running decision process. When the module is enabled but not running (never started, idle
   * unloaded) it is started first; while it is starting or restarting this waits up to `waitMs` for
   * it, and stops waiting when `signal` fires (the client left).
   */
  acquire: (waitMs: number, signal?: AbortSignal) => Promise<DecisionTarget>
  /** The configured model's id for the request log, `null` when none is set. */
  modelId?: () => string | null
}

/** The running embedding process as `/embeddings` needs it: where to forward, with which key, and what it takes. */
export type EmbeddingTarget =
  | {
      ok: true
      port: number
      /** The process's own bearer key; the client's key for this server never reaches it. */
      apiKey: string
      /** The `-a` the process answers with. */
      modelId: string
      /** Length of the vectors it returns. */
      dims: number
      /** What one input may hold. */
      modalities: readonly EmbeddingModality[]
      /** Called once the answer has been relayed (or abandoned): the idle unload counts from here. */
      release: () => void
    }
  | { ok: false; reason: string; message: string }

export interface EmbeddingBackend {
  /**
   * The running embedding process. When the module is enabled but not running it is started first;
   * while it is starting or restarting this waits up to `waitMs`, and stops when `signal` fires.
   */
  acquire: (waitMs: number, signal?: AbortSignal) => Promise<EmbeddingTarget>
  /** The name the module serves (`model` in a request), `null` when it is off or has no model. */
  modelId: () => string | null
}

export interface PublicServerDeps {
  /** The session `provider` serves for `modelId`, matched with the proxy's `.`/`_` rule. */
  findLocal: (provider: LocalProvider, modelId: string) => LocalTarget | undefined
  /** Every loaded session, in `LOCAL_SEARCH_ORDER` provider order. */
  listLocal: () => LocalTarget[]
  /** Registered cloud providers, keyed by provider id. */
  providers: () => ReadonlyMap<string, RemoteProvider>
  /**
   * Reload a local model with a larger context because a request overflowed it. In the app this was
   * a round trip to the llama.cpp extension; in the core it is the runtime's own `increaseCtx`.
   */
  increaseCtx: (provider: LocalProvider, modelId: string, trigger: string) => Promise<CtxIncreaseOutcome>
  /**
   * Whether the app's API screen is watching. Only then are prompt and reply previews and stream
   * telemetry collected (ATO-113); the analytics observation is sent regardless.
   */
  inspecting?: () => boolean
  /** The ChatGPT subscription, for models registered under the `chatgpt` provider. */
  chatgpt?: ChatGptBackend
  /**
   * Hosts trusted for this one request besides the configured ones: the live tunnel name, and the
   * accepted socket's own address when the listener is reachable from the LAN. Asked per request,
   * not per connection — a keep-alive connection outlives a tunnel (see `dynamic-hosts.ts`).
   */
  dynamicTrustedHosts?: (localAddress: string | undefined) => readonly string[]
  emit?: <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) => void
  fetch?: typeof fetch
  /** Image generation on the resident image model; without it the route answers 503. */
  images?: ImagesBackend
  /** The video counterpart, for `/videos`. */
  videos?: VideosBackend
  /** The decision model, for `/systemone` and `/router/score`; without it those routes answer 503. */
  decision?: DecisionBackend
  /**
   * The embedding model, for `/embeddings` requests that name it; every other `/embeddings` request
   * goes to the sessions and cloud providers as before.
   */
  embedding?: EmbeddingBackend
  /** Where a request that failed on our side, or a failing local engine, is reported. */
  errors?: ErrorSink | undefined
}

export interface PublicServerConfig {
  host: string
  port: number
  /** Normalised: `''` or `/segment` without a trailing slash. */
  prefix: string
  /** Key clients must present; empty disables the check. */
  apiKey: string
  /** Hosts allowed besides the built-in loopback names; `*` allows every host. */
  trustedHosts: string[]
  /** Timeout for requests to a cloud provider, in seconds (the proxy's `proxy_timeout`). */
  proxyTimeoutSecs: number
}
