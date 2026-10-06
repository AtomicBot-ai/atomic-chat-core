/**
 * The decision model: a small model that answers typed questions with probabilities in one forward
 * pass. It runs as its own core module, outside the sessions registry
 * (ADR 2026-09-30-the-decision-model-is-its-own-core-module), on one of two engines
 * (ADR 2026-10-06-run-decision-models-on-upstream-llamacpp):
 *  - `turboquant`: `llama-server --decision` of the TurboQuant fork (release 1.7.0 on), which also
 *    serves the router (`/v1/router/score`) and converts laya checkpoint folders;
 *  - `upstream`: ggml-org llama.cpp (b11370 on), which serves `/v1/systemone` for a GGUF stamped with
 *    `<arch>.decision.type` (laya, openjev, lev, kev, nimble, clef). No router.
 *
 * Two halves live here:
 *  - the engine's wire contract (`DECISION.md` in atomic-llama-cpp-turboquant, API version 1, which
 *    upstream's `/v1/systemone` shares for requests), mirrored as types only. Fields the engine may
 *    add later are tolerated: every object keeps an index signature, and nothing in the core rejects
 *    an unknown key;
 *  - the core's own surface: the settings section, the status, the fail-open outcome and the events.
 *
 * Browser-safe: types and constants only. snake_case throughout, like the engine and `settings.json`.
 */

/** `/props.decision.api_version` this core speaks. Anything else is treated as an unsupported engine. */
export const DECISION_API_VERSION = 1

/**
 * Which decision API an engine speaks, decided by the model file: a laya checkpoint folder or a GGUF
 * the fork converted (`decision.layout`, architecture `laya`) is `turboquant`; a GGUF with
 * `<arch>.decision.type` is `upstream`.
 */
export type DecisionDialect = 'turboquant' | 'upstream'

// ---------------------------------------------------------------------------------------------
// Engine contract (DECISION.md, API version 1)
// ---------------------------------------------------------------------------------------------

export type DecisionQuestionType = 'noul' | 'choice' | 'score'

export interface DecisionQuestion {
  type: DecisionQuestionType
  /** Any JSON value for the laya layout; a non-string is rendered as compact JSON by the engine. */
  instructions: unknown
  /** `choice`: `{label: description|null}` or `[label, …]`; `score`: `[level, …]`; `noul`: `{true?, false?}`. */
  criteria?: unknown
  /** `noul` only: `{"false": str, "true": str}`. */
  labels?: { false: string; true: string } | null
  [extra: string]: unknown
}

export type DecisionTruncation = 'allow' | 'error'

export interface SystemoneRequest {
  model?: string
  state: unknown
  questions: Record<string, DecisionQuestion>
  truncation?: DecisionTruncation
  [extra: string]: unknown
}

export interface DecisionAnswer {
  type: DecisionQuestionType
  /** `noul`: P(true). */
  noul?: number
  /** `choice`: the first argmax, the label as given (a number stays a number). */
  choice?: unknown
  /** `score`: sum(i * p_i). */
  score?: number
  probabilities?: Record<string, number>
  legend?: Record<string, unknown>
  confidence: number
  [extra: string]: unknown
}

export interface DecisionRuntimeInfo {
  layout: string
  format: string
  plan: string
  spec_sha256: string
  calibration: string
  [extra: string]: unknown
}

export interface DecisionTimings {
  queue_ms: number
  render_ms: number
  compute_ms: number
  [extra: string]: unknown
}

/** Upstream llama.cpp answers only `answers` and `usage.{input,output}_tokens`; the rest is the fork's. */
export interface SystemoneResponse {
  model?: string
  answers: Record<string, DecisionAnswer>
  usage: { input_tokens: number; output_tokens: number; evaluated_tokens?: number; [extra: string]: unknown }
  latency_ms?: number
  timings?: DecisionTimings
  warnings?: string[]
  runtime?: DecisionRuntimeInfo
  [extra: string]: unknown
}

/** One measured or missing skill check of an executor card (`atomic.executor-card/1`). */
export type ExecutorCheck =
  | {
      skill: string
      status: 'measured'
      /** Integers only: the engine rejects floats so Python and C++ render the same text. */
      passed: number
      total: number
      criterion?: string
      source?: string
      version?: string
      [extra: string]: unknown
    }
  | { skill: string; status: 'missing'; source?: string; version?: string; [extra: string]: unknown }

export interface ExecutorCard {
  schema?: 'atomic.executor-card/1' | string
  name: string
  kind: string
  description?: string
  /** At most 32. */
  checks?: ExecutorCheck[]
  [extra: string]: unknown
}

export interface RouterCandidate {
  /** `[A-Za-z0-9._:/@+-]{1,128}`, unique within a request. */
  id: string
  card: ExecutorCard
  [extra: string]: unknown
}

export interface RouterScoreRequest {
  model?: string
  task: string
  criterion: string
  candidates: RouterCandidate[]
  truncation?: DecisionTruncation
  [extra: string]: unknown
}

export interface RouterScore {
  id: string
  /** Independent per candidate: the scores do not sum to 1, and there is no threshold or argmax. */
  p_success: number
  /** The raw z = s_true - s_false, for recalibration. */
  logit: number
  calibrated: boolean
  input_tokens: number
  truncated_tokens: number
  [extra: string]: unknown
}

export interface RouterScoreResponse {
  object: 'router.scores'
  model: string
  scores: RouterScore[]
  usage: { input_tokens: number; output_tokens: number; passes: number; [extra: string]: unknown }
  latency_ms: number
  timings?: DecisionTimings
  runtime: DecisionRuntimeInfo
  warnings: string[]
  [extra: string]: unknown
}

/** Reasons a decision handler puts in its error envelope (DECISION.md "Errors"). */
export const DECISION_ENGINE_REASONS = [
  'MALFORMED_JSON',
  'BODY_NOT_OBJECT',
  'INVALID_REQUEST',
  'UNKNOWN_QUESTION_TYPE',
  'EMPTY_INSTRUCTIONS',
  'TOO_FEW_OPTIONS',
  'TOO_MANY_OPTIONS',
  'INVALID_NOUL_CRITERIA',
  'UNSUPPORTED_NUMBER',
  'UNSUPPORTED_CRITERIA_VALUE',
  'TOO_MANY_QUESTIONS',
  'INVALID_CARD',
  'DUPLICATE_CANDIDATE_ID',
  'INVALID_CANDIDATE_ID',
  'TOO_MANY_CANDIDATES',
  'BODY_TOO_LARGE',
  'PROMPT_TOO_LONG',
  'CARD_TOO_LONG',
  'CRITERION_TOO_LONG',
  'OPTIONS_TRUNCATED',
  'STATE_TRUNCATED',
  'OVERLOADED',
  'INTERNAL',
  'ROUTER_NOT_CALIBRATED',
  'UNAVAILABLE',
] as const
/** A known reason, or a string a newer engine added. */
export type DecisionEngineReason = (typeof DECISION_ENGINE_REASONS)[number] | (string & {})

/**
 * `{"error": {...}}` of a decision handler. Middleware answers (401, 503 while loading, 404) carry no
 * `reason`, which is why it is optional here.
 */
export interface DecisionEngineError {
  code?: number
  type?: string
  reason?: DecisionEngineReason
  message: string
  /** JSON path of the bad field. */
  param?: string
  [extra: string]: unknown
}

export interface DecisionLimits {
  max_questions?: number
  max_candidates?: number
  max_options?: number
  max_checks?: number
  max_tokens?: number
  max_card_tokens?: number
  max_card_field_bytes?: number
  max_body_bytes?: number
  [extra: string]: unknown
}

/** The `decision` block of `GET /props`. Only `api_version` is required by the core. */
export interface DecisionProps {
  api_version: number
  endpoints?: string[]
  layout?: string
  format?: string
  model_id?: string
  model_version?: string
  spec_version?: number
  spec_sha256?: string
  spec_source?: 'gguf' | 'file' | 'default' | string
  question_types?: string[]
  limits?: DecisionLimits
  confidence?: string
  calibration?: { method?: string; calibrated?: boolean; version?: string; [extra: string]: unknown }
  router?: {
    available?: boolean
    calibrated?: boolean
    method?: string
    card_schema?: string
    card_renderer?: string
    [extra: string]: unknown
  }
  plan?: Record<string, unknown>
  /** `gguf` for `-m FILE`, `checkpoint-dir` for `-m DIR`. */
  source?: 'gguf' | 'checkpoint-dir' | (string & {})
  /** The cached GGUF a checkpoint folder was loaded from; `null` for `gguf`. */
  cache_path?: string | null
  /** How a checkpoint folder was loaded; `null` for `gguf`. */
  checkpoint?: DecisionCheckpointInfo | null
  [extra: string]: unknown
}

/** `/props.decision.checkpoint`: the conversion of a checkpoint folder into the GGUF cache. */
export interface DecisionCheckpointInfo {
  dir?: string
  cache_dir?: string
  key?: string
  outtype?: DecisionConvertType | (string & {})
  /** The cached GGUF was reused; `convert_ms` is then 0. */
  cache_hit?: boolean
  convert_ms?: number
  /** `LAYA_CONVERT_VERSION` of the engine's converter. */
  converter?: number
  [extra: string]: unknown
}

/** `--decision-convert-type`: what a checkpoint folder is converted to. */
export type DecisionConvertType = 'f16' | 'f32'
export const DECISION_CONVERT_TYPES: readonly DecisionConvertType[] = ['f16', 'f32']

/** `capabilities` values `GET /v1/models` lists for a decision process. */
export type DecisionCapability = 'decision' | 'systemone' | 'router_score' | (string & {})

// ---------------------------------------------------------------------------------------------
// The core's surface
// ---------------------------------------------------------------------------------------------

/**
 * `settings.json` → `decision`. The model is a file or folder the app downloaded (its registry is the
 * app's); the core only runs it. A relative `model_path` / `spec_path` is resolved against the data
 * folder.
 */
export interface DecisionSettings {
  /** Off by default: nothing is spawned until the app turns it on and names a model. */
  enabled: boolean
  /**
   * The decision GGUF (a laya model, any GGUF stamped with `decision.spec`, or an upstream one with
   * `<arch>.decision.type`), or a laya Hugging Face checkpoint folder, which the fork converts once
   * into `<data>/decision/gguf-cache`. The file decides the engine (`DecisionDialect`).
   */
  model_path: string
  /** `--mmproj` for an upstream model that reads images (openjev, clef); empty = none. Ignored by the fork. */
  mmproj_path: string
  /**
   * `-c` for an upstream model, also its batch (the decision outputs are read from one batch); 0 = the
   * core picks (`UPSTREAM_DECISION_DEFAULT_CTX`, capped at the trained context). Ignored by the fork.
   */
  ctx_size: number
  /** `-a`: the name the engine answers with; empty = the file name, or the folder name for a checkpoint. */
  model_id: string
  /** `--decision-spec`: a spec or a bare `calibration.json` replacing the embedded one; empty = none. */
  spec_path: string
  /** `-t`; 0 = the core picks (the physical core count, capped, see `decisionThreads`). */
  threads: number
  /** Budget of one `scoreCandidates` / `decide` call before it fails open, in milliseconds. */
  timeout_ms: number
  /** Unload after this many seconds without a call; 0 keeps the model resident. */
  idle_unload_secs: number
  /** How long a start may take before it counts as failed. */
  startup_timeout_secs: number
  /** `--decision-allow-uncalibrated`: serve `/v1/router/score` with `calibrated: false` scores. */
  allow_uncalibrated: boolean
  /** An explicit `llama-server` to run instead of an installed build of the model's engine; empty = resolve one. */
  engine_path: string
  /** `--decision-convert-type` for a checkpoint folder; ignored for a GGUF. */
  convert_type: DecisionConvertType
}

export const DEFAULT_DECISION_SETTINGS: DecisionSettings = {
  enabled: false,
  model_path: '',
  mmproj_path: '',
  ctx_size: 0,
  model_id: '',
  spec_path: '',
  threads: 0,
  // One systemone question takes 0.1-0.3 s on a CPU and a router pass per candidate 0.1-0.8 s
  // (DECISION.md); 500 ms timed out on ordinary x86 machines. A caller with a tighter budget passes
  // its own `timeout_ms`.
  timeout_ms: 2000,
  idle_unload_secs: 0,
  startup_timeout_secs: 60,
  allow_uncalibrated: false,
  engine_path: '',
  convert_type: 'f16',
}

export type DecisionState =
  /** Turned off in settings. */
  | 'disabled'
  /** Enabled, not running (never started, unloaded, or idle-unloaded); the next call starts it. */
  | 'idle'
  | 'starting'
  | 'ready'
  /** The process died after it was ready; a restart is scheduled. */
  | 'restarting'
  /** A start failed, or restarts gave up; `error` says why. Cleared by `load` or a settings change. */
  | 'failed'
  /**
   * No installed build of the model's engine can run it: no fork build speaks `--decision` (or it
   * speaks another API version), or no upstream build is new enough for the model's decision type.
   */
  | 'unsupported'

/** The providers whose builds can run a decision model, one per dialect. */
export type DecisionEngineProvider = 'llamacpp' | 'llamacpp-upstream'

/** Which `llama-server` runs the decision model, and why the core trusts it. */
export interface DecisionEngineInfo {
  path: string
  /** `<version>/<backend>` of the installed pack; `null` for an explicit `engine_path`. */
  version_backend: string | null
  /** Fork semver from the release tag (`b10269-1.7.0` → `1.7.0`); `null` when the tag has none. */
  fork_version: string | null
  /**
   * Whether the tag alone says the build is new enough: for the fork the `-h` probe has the last
   * word, for upstream the build number is the gate.
   */
  version_gate: boolean | null
  /** The API the engine is started for. */
  dialect: DecisionDialect
  /** The provider whose pack it is; `null` for an explicit `engine_path`. */
  provider: DecisionEngineProvider | null
}

export interface DecisionStatus {
  state: DecisionState
  enabled: boolean
  /** Resolved absolute model path, or `null` when none is configured. */
  model_path: string | null
  engine: DecisionEngineInfo | null
  pid: number | null
  port: number | null
  /** `/props.decision` of the running process. */
  props: DecisionProps | null
  /** Capabilities the running process lists in `/v1/models`. */
  capabilities: DecisionCapability[]
  /**
   * Crashes counted towards giving up: one per unexpected exit or failed restart, back to zero after
   * a process stays up for a minute, or on an explicit load or a settings change.
   */
  restarts: number
  error: { code: string; message: string; details?: string } | null
  /** Milliseconds since the epoch of the last state change. */
  since: number
}

/** Why a call answered without the model's opinion. The caller then applies its default policy. */
export type DecisionUnavailableReason =
  | 'disabled'
  | 'not_configured'
  | 'unsupported'
  | 'starting'
  | 'failed'
  | 'not_running'
  | 'timeout'
  | 'overloaded'
  | 'aborted'
  /**
   * The router has no calibration and the process runs without `--decision-allow-uncalibrated`: a
   * configuration state, not a caller bug. Answered without a request when `/props.decision.router`
   * says `available: false`, else read from the engine's 501 `ROUTER_NOT_CALIBRATED`.
   */
  | 'not_calibrated'
  /** The engine refused the request (4xx/5xx with its envelope in `error`), or it could not be serialized. */
  | 'rejected'
  | 'transport_error'
  | 'invalid_response'

/**
 * What `scoreCandidates` and `decide` resolve to. They never throw into the caller: a chat turn must
 * not fail because the router could not answer (fail-open).
 */
export type DecisionOutcome<T> =
  | { unavailable: false; result: T; elapsed_ms: number }
  | {
      unavailable: true
      reason: DecisionUnavailableReason
      message: string
      elapsed_ms: number
      /** The engine's HTTP status, when it answered. */
      status?: number
      /** The engine's error envelope, when it answered with one. */
      error?: DecisionEngineError
    }

/** `POST /atomic/v1/decision/score` body. */
export interface DecisionScoreRequest {
  task: string
  criterion: string
  candidates: RouterCandidate[]
  truncation?: DecisionTruncation
  /** Overrides `settings.decision.timeout_ms` for this call. */
  timeout_ms?: number
}

/** `POST /atomic/v1/decision/decide` body. */
export interface DecisionDecideRequest {
  state: unknown
  questions: Record<string, DecisionQuestion>
  truncation?: DecisionTruncation
  timeout_ms?: number
}

/** `decision:state`: every status change. */
export type DecisionStateEvent = DecisionStatus

/** `decision:error`: a failure nobody is awaiting (a crash, a restart that failed, restarts given up). */
export interface DecisionErrorEvent {
  code: string
  message: string
  details?: string
}
