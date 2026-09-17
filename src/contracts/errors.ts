/**
 * Error codes shared with the Atomic Chat app. The app matches on `code` verbatim
 * (`extractModelErrorMessage`, `classifyDownloadFailure`), so these strings are a wire contract.
 *
 * Source of truth in the app: src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/error.rs,
 * src-tauri/src/core/downloads/disk.rs, src-tauri/src/core/server/proxy.rs.
 */

/** Runtime / model-load codes (Rust `ErrorCode`, `#[serde(rename_all = "SCREAMING_SNAKE_CASE")]`). */
export type RuntimeErrorCode =
  | 'BINARY_NOT_FOUND'
  | 'MODEL_LOAD_FAILED'
  | 'MODEL_FILE_NOT_FOUND'
  | 'MODEL_LOAD_TIMED_OUT'
  /** The user stopped a load before the engine reported ready (the plugins' `ModelLoadCancelled`). */
  | 'MODEL_LOAD_CANCELLED'
  | 'INVALID_ARGUMENT'
  | 'IO_ERROR'
  | 'INTERNAL_ERROR'
  | 'DEVICE_LIST_PARSE_FAILED'
  | 'OS_VERSION_UNSUPPORTED'
  | 'OUT_OF_MEMORY'
  | 'MODEL_ARCH_NOT_SUPPORTED'
  | 'MULTIMODAL_PROJECTOR_LOAD_FAILED'
  | 'MODEL_FILE_CORRUPT'
  | 'LLAMA_CPP_PROCESS_ERROR'
  /** MLX plugin (`tauri-plugin-mlx/src/error.rs`): an mlx-server failure no pattern explained. */
  | 'MLX_PROCESS_ERROR'
  /** Foundation Models plugin (`tauri-plugin-foundation-models/src/error.rs`). */
  | 'FOUNDATION_MODELS_UNAVAILABLE'
  | 'SERVER_START_FAILED'
  | 'SERVER_START_TIMED_OUT'
  | 'PROCESS_ERROR'

/**
 * Codes raised by the TypeScript extension layer of the app (coded `Error.code` own-properties);
 * the web-app maps them to actionable toasts. Source: extensions/llamacpp-upstream-extension/src/index.ts:173-204, util.ts:49.
 */
export type ExtensionErrorCode =
  | 'MODEL_SHARDS_INCOMPLETE'
  | 'CPU_NO_AVX'
  | 'BACKEND_TAG_UNRESOLVED'
  | 'BACKEND_INSUFFICIENT_DISK_SPACE'
  | 'TRANSCRIPTION_MODEL_MISSING'
  | 'TRANSCRIPTION_UNSUPPORTED'

/** Codes raised by the core itself (new; not present in the Rust app). */
export type CoreErrorCode =
  | 'CORE_ALREADY_RUNNING'
  | 'CORE_NOT_RUNNING'
  | 'CORE_START_FAILED'
  | 'CORE_PROTOCOL_MISMATCH'
  | 'ALREADY_MIGRATED'
  | 'NO_MODEL_LOADED'
  | 'MODEL_NOT_LOADED'
  | 'MODEL_NOT_FOUND'
  | 'PROVIDER_NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN_HOST'
  /** No ChatGPT subscription is connected, or its sign-in expired and needs doing again. */
  | 'AUTH_REQUIRED'
  /** A sign-in did not complete: the browser reported an error, `state` did not match, or the code exchange failed. */
  | 'AUTH_FAILED'
  | 'AUTH_CANCELLED'
  /** An external service (a token endpoint, the subscription API) could not be reached or refused. */
  | 'UPSTREAM_ERROR'

export type ErrorCode = RuntimeErrorCode | ExtensionErrorCode | CoreErrorCode

/**
 * Disk-failure tags. Rendered into the error message as `Error: [<tag>] <detail>`; the app's
 * telemetry parses the tag out of the string. Byte-identical with `disk.rs`.
 */
export const DISK_ERROR_TAGS = [
  'disk_full',
  'disk_permission',
  'disk_file_locked',
  'disk_path_too_long',
  'disk_device_lost',
  'disk_io',
] as const
export type DiskErrorTag = (typeof DISK_ERROR_TAGS)[number]

/** Wire shape of every error the core returns over HTTP / stdout. */
export interface ErrorBody {
  code: ErrorCode
  message: string
  details?: string
}

export class AtomicCoreError extends Error {
  readonly code: ErrorCode
  readonly details: string | undefined

  constructor(code: ErrorCode, message: string, details?: string) {
    super(message)
    this.name = 'AtomicCoreError'
    this.code = code
    this.details = details
  }

  toJSON(): ErrorBody {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details }
  }

  static fromBody(body: ErrorBody): AtomicCoreError {
    return new AtomicCoreError(body.code, body.message, body.details)
  }
}
