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

/** A model a local engine is serving right now. */
export interface LocalTarget {
  provider: LocalProvider
  modelId: string
  port: number
  /** Per-session bearer the engine expects; empty for MLX, which has no auth layer. */
  apiKey: string
  isEmbedding: boolean
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
