/**
 * The decision model: a small model served by `llama-server --decision` (the TurboQuant fork, from
 * release 1.7.0) that answers calibrated probabilities in one forward pass. It runs as its own core
 * module, outside the sessions registry (ADR 2026-09-30-the-decision-model-is-its-own-core-module).
 *
 * Two halves live here:
 *  - the engine's wire contract (`DECISION.md` in atomic-llama-cpp-turboquant, API version 1),
 *    mirrored as types only. Fields the engine may add later are tolerated: every object keeps an
 *    index signature, and nothing in the core rejects an unknown key;
 *  - the core's own surface: the settings section, the status, the fail-open outcome and the events.
 *
 * Browser-safe: types and constants only. snake_case throughout, like the engine and `settings.json`.
 */

/** `/props.decision.api_version` this core speaks. Anything else is treated as an unsupported engine. */
export const DECISION_API_VERSION = 1

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

export interface SystemoneResponse {
  model: string
  answers: Record<string, DecisionAnswer>
  usage: { input_tokens: number; output_tokens: number; evaluated_tokens: number; [extra: string]: unknown }
  latency_ms: number
  timings?: DecisionTimings
  warnings: string[]
  runtime: DecisionRuntimeInfo
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
  [extra: string]: unknown
}

/** `capabilities` values `GET /v1/models` lists for a decision process. */
export type DecisionCapability = 'decision' | 'systemone' | 'router_score' | (string & {})

// ---------------------------------------------------------------------------------------------
// The core's surface
// ---------------------------------------------------------------------------------------------

/**
 * `settings.json` → `decision`. The model is a file the app downloaded (its registry is the app's);
 * the core only runs it. A relative `model_path` / `spec_path` is resolved against the data folder.
 */
export interface DecisionSettings {
  /** Off by default: nothing is spawned until the app turns it on and names a model. */
  enabled: boolean
  /** The decision GGUF (a laya model, or any GGUF stamped with `decision.spec`). */
  model_path: string
  /** `-a`: the name the engine answers with; empty = the engine's default (the file name). */
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
  /** An explicit `llama-server` to run instead of the installed fork build; empty = resolve one. */
  engine_path: string
}

export const DEFAULT_DECISION_SETTINGS: DecisionSettings = {
  enabled: false,
  model_path: '',
  model_id: '',
  spec_path: '',
  threads: 0,
  // The one-pager's hard budget: routing must never cost a chat turn more than this.
  timeout_ms: 500,
  idle_unload_secs: 0,
  startup_timeout_secs: 60,
  allow_uncalibrated: false,
  engine_path: '',
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
  /** No installed engine build speaks `--decision` (or it speaks another API version). */
  | 'unsupported'

/** Which `llama-server` runs the decision model, and why the core trusts it. */
export interface DecisionEngineInfo {
  path: string
  /** `<version>/<backend>` of the installed pack; `null` for an explicit `engine_path`. */
  version_backend: string | null
  /** Fork semver from the release tag (`b10269-1.7.0` → `1.7.0`); `null` when the tag has none. */
  fork_version: string | null
  /** Whether the tag alone says the build is new enough; the `-h` probe has the last word. */
  version_gate: boolean | null
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
