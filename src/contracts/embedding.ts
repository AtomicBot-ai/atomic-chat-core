/**
 * The embedding model (ADR 2026-10-07-embedding-models-are-their-own-core-module): one stock llama.cpp
 * `llama-server --embedding` the app turns on for the Local API Server's `/v1/embeddings`, outside the
 * sessions registry like the decision model. The model is a GGUF the app downloaded (its catalog is
 * the app's, `atomic-chat-conf/models/embedding.json`), plus a projector for one that reads images or
 * audio; the core only runs it.
 */

/** The pooling a model is started with (`--pooling`); empty in the settings = the GGUF's own. */
export const EMBEDDING_POOLINGS = ['mean', 'cls', 'last'] as const
export type EmbeddingPooling = (typeof EMBEDDING_POOLINGS)[number]

/** What one input may hold, as the running process reports it (`/props.modalities`). */
export type EmbeddingModality = 'text' | 'image' | 'audio' | 'video'

/** The provider whose builds run embedding models. */
export type EmbeddingEngineProvider = 'llamacpp-upstream'

/**
 * `settings.json` → `embedding`. A relative `model_path` / `mmproj_path` is resolved against the data
 * folder.
 */
export interface EmbeddingSettings {
  /** Off by default: nothing is spawned until the app turns it on and names a model. */
  enabled: boolean
  /** The embedding GGUF. */
  model_path: string
  /** `--mmproj` for a model that reads images or audio; empty = text only. */
  mmproj_path: string
  /** `-a`: the name API clients pass as `model`; empty = the file name without `.gguf`. */
  model_id: string
  /**
   * `-c`, and `-b`/`-ub`: an encoder reads one whole input (media tokens included) per batch. 0 = the
   * core picks (`EMBEDDING_DEFAULT_CTX`, capped at the trained context).
   */
  ctx_size: number
  /** `--pooling`; empty = the model's own (`<arch>.pooling_type`). */
  pooling: '' | EmbeddingPooling
  /** `--image-max-tokens`; 0 = the engine's own (at most half the batch). */
  image_max_tokens: number
  /** `-t`; 0 = llama.cpp's own default. */
  threads: number
  /** Unload after this many seconds without a request; 0 keeps the model resident. */
  idle_unload_secs: number
  /** How long a start may take before it counts as failed. */
  startup_timeout_secs: number
  /** An explicit `llama-server` to run instead of an installed llama.cpp build; empty = resolve one. */
  engine_path: string
}

export const DEFAULT_EMBEDDING_SETTINGS: EmbeddingSettings = {
  enabled: false,
  model_path: '',
  mmproj_path: '',
  model_id: '',
  ctx_size: 0,
  pooling: '',
  image_max_tokens: 0,
  threads: 0,
  idle_unload_secs: 0,
  // A first start maps the weights and, with a projector, warms the vision and audio encoders.
  startup_timeout_secs: 120,
  engine_path: '',
}

export type EmbeddingState =
  /** Turned off in settings. */
  | 'disabled'
  /** Enabled, not running (never started, unloaded, or idle-unloaded); the next request starts it. */
  | 'idle'
  | 'starting'
  | 'ready'
  /** The process died after it was ready; a restart is scheduled. */
  | 'restarting'
  /** A start failed, or restarts gave up; `error` says why. Cleared by `load` or a settings change. */
  | 'failed'
  /** No installed llama.cpp build is new enough for the model (`EMBEDDING_ENGINE_UNSUPPORTED`). */
  | 'unsupported'

/** Which `llama-server` runs the embedding model. */
export interface EmbeddingEngineInfo {
  path: string
  /** `<version>/<backend>` of the installed pack; `null` for an explicit `engine_path`. */
  version_backend: string | null
  /** The provider whose pack it is; `null` for an explicit `engine_path`. */
  provider: EmbeddingEngineProvider | null
}

export interface EmbeddingStatus {
  state: EmbeddingState
  enabled: boolean
  /** Resolved absolute model path, or `null` when none is configured. */
  model_path: string | null
  /** The name API clients pass as `model`, or `null` when no model is configured. */
  model_id: string | null
  engine: EmbeddingEngineInfo | null
  pid: number | null
  port: number | null
  /** Length of the vectors the running process returns; `null` until it is ready. */
  dims: number | null
  /** What one input may hold; `[]` until the process is ready. */
  modalities: EmbeddingModality[]
  /**
   * Crashes counted towards giving up: one per unexpected exit or failed restart, back to zero after
   * a process stays up for a minute, or on an explicit load or a settings change.
   */
  restarts: number
  error: EmbeddingErrorEvent | null
  /** Milliseconds since the epoch of the last state change. */
  since: number
}

/** `embedding:state`: every status change. */
export type EmbeddingStateEvent = EmbeddingStatus

/** `embedding:error`: a failure nobody is awaiting (a crash, a restart that failed, restarts given up). */
export interface EmbeddingErrorEvent {
  code: string
  message: string
  details?: string
}

/** `POST /atomic/v1/embedding/embed`: what the process answered, relayed as it came. */
export interface EmbeddingEmbedResponse {
  /** The engine's HTTP status. */
  status: number
  /** The engine's JSON answer (the OpenAI list, or its error envelope). */
  body: unknown
}
