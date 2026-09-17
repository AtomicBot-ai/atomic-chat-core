/**
 * Event catalog. Every event the core emits is listed here with its payload. The app's
 * `CoreEventBridge` maps these onto the legacy `@janhq/core` names (PLAN.md §3.5).
 * Adding an event = add it here + add the relay mapping in the app, in the same PR pair.
 */

import type {
  DiffusionErrorEvent,
  DiffusionJobEvent,
  DiffusionProgressEvent,
  DiffusionStateEvent,
} from './diffusion.js'
import type { RemoteAccessStatus } from './remote-access.js'
import type { LocalProviderId, RuntimeDeviceInfo, SessionInfo } from './session.js'

export type DownloadKind = 'model' | 'backend' | 'draft' | 'cudart'

/**
 * What a download is doing while it has no bytes to report: reaching the server for the first time,
 * or waiting out a backoff before trying again. The app's `DownloadStage`
 * (`src-tauri/src/core/downloads/models.rs`), camelCase on the wire.
 */
export interface DownloadStage {
  /** `connecting` for the first attempt, `retrying` for each one after. */
  kind: 'connecting' | 'retrying'
  attempt: number
  maxAttempts: number
}

export interface CoreEvents {
  'download:started': { taskId: string; modelId?: string; kind: DownloadKind }
  'download:progress': {
    taskId: string
    modelId?: string
    transferred: number
    total: number
    percent: number
  }
  /**
   * A status change, never progress: it carries no byte counts on purpose, so a retry cannot rewind
   * a progress bar. Its own event rather than a field of `download:progress`, whose payload the
   * app's relay pins (ADR 2026-09-17-report-download-stages-as-their-own-event).
   */
  'download:stage': { taskId: string; stage: DownloadStage }
  'download:error': { taskId: string; modelId?: string; error: string }
  'download:stopped': { taskId: string; modelId?: string }
  'download:verified': { taskId: string; modelId?: string }

  'model:validation-started': { modelId: string }
  'model:validation-failed': { modelId: string; error: string }
  'model:imported': { provider: LocalProviderId; modelId: string; modelPath: string; mmprojPath?: string }

  'backend:download-started': { provider: LocalProviderId; backend: string; version: string }
  'backend:download-finished': {
    provider: LocalProviderId
    backend: string
    version?: string
    success: boolean
    error?: string
  }
  'backend:manual-downloading': { provider: LocalProviderId; selection: string }
  'backend:manual-failed': { provider: LocalProviderId; selection: string; error: string }
  'backend:better-detected': {
    provider: LocalProviderId
    currentBackend: string
    recommendedBackend: string
    recommendedCategory: string
    version: string
    backendId: string
  }
  'backend:runtime-reported': {
    provider: LocalProviderId
    modelId: string
    configuredVersionBackend: string
    effectiveVersionBackend: string
    runtimeDevice: RuntimeDeviceInfo | null
    mismatch: boolean
  }
  'backend:optimal-changed': {
    provider: LocalProviderId
    revision: number
    optimal: unknown | null
  }

  'settings:changed': { provider: LocalProviderId | 'server' | 'cloud'; key: string; value: unknown }

  'session:started': SessionInfo & { provider: LocalProviderId }
  'session:died': {
    provider: LocalProviderId
    pid: number
    model_id: string
    exit_code: number | null
    signal: string | null
    message: string
  }
  'session:ctx-increased': {
    provider: LocalProviderId
    modelId: string
    oldCtx: number
    newCtx: number
    reason: string
  }
  'session:unloaded': { provider: LocalProviderId; model_id: string; pid: number }

  'server:started': { host: string; port: number }
  'server:stopped': Record<string, never>
  'server:bind-failed': { port: number; error: string }

  /**
   * Every transition of the remote-access tunnel, and every change of the public server it depends
   * on: the URL arrives seconds after the request that asked for it has answered.
   */
  'remote-access:status': RemoteAccessStatus

  /**
   * Image generation, camelCase like the rest of that surface (the plugin's `atomic-diffusion://*`).
   * `state` on every change of the engine install, the model or the output folder; `progress` per
   * sampling step; `job` on every job transition; `error` for a failure nobody is awaiting.
   */
  'diffusion:state': DiffusionStateEvent
  'diffusion:progress': DiffusionProgressEvent
  'diffusion:job': DiffusionJobEvent
  'diffusion:error': DiffusionErrorEvent

  /**
   * One request to the Local API Server, for the app's analytics window and its API screen
   * (PLAN.md §2 decision 15). `started` and `progress` are sent only while the app's inspector is
   * watching, because they carry the prompt preview; `finished` carries the analytics observation
   * for every request that is product traffic, and the inspector's finish fields when it announced.
   */
  'api:request': ApiRequestEvent

  /** A process that owns engines the core does not published, refreshed or lost its registration. */
  'external-sessions:changed': {
    owner: string
    sessions: number
    reason: 'published' | 'expired' | 'unregistered'
  }
  /**
   * The core needs a registered session's context grown and asks its owner. The owner answers on
   * `POST /external-sessions/:owner/ctx/:request_id`; no answer within 60 s counts as declined.
   */
  'external-sessions:ctx-requested': {
    request_id: string
    owner: string
    provider: string
    model_id: string
    trigger: string
  }

  'core:log': { level: 'debug' | 'info' | 'warn' | 'error'; msg: string }
}

/** What the app's `api_request_analytics.rs` aggregates (never content, only shape and outcome). */
export interface ApiRequestObservation {
  endpoint: string
  method: string
  model_id: string | null
  /** `llamacpp`, `llamacpp-upstream`, `mlx`, `remote`, or `unknown` before a backend was chosen. */
  backend: string
  provider: string | null
  stream: boolean
  status: number
  /** Time to response headers. */
  latency_ms: number
  is_anthropic_fallback: boolean
  error_kind: string | null
  upstream_status: number | null
  oom_detected: boolean
  ctx_overflow_detected: boolean
}

/** The inspector's `request-started` fields. PRIVACY: `prompt_preview` is user content. */
export interface ApiRequestStartedFields {
  endpoint: string
  method: string
  model_id: string | null
  stream: boolean
  message_count: number | null
  prompt_preview: string | null
  prompt_chars: number | null
  has_non_text_parts: boolean
  client_max_tokens: number | null
}

/** The inspector's `request-finished` fields. PRIVACY: `reply_preview` is model output. */
export interface ApiRequestFinishFields {
  status: number | null
  error_kind: string | null
  aborted: boolean
  headers_ms: number | null
  ttft_ms: number | null
  duration_ms: number | null
  prompt_tokens: number | null
  completion_tokens: number | null
  total_tokens: number | null
  tokens_estimated: boolean
  prompt_per_second: number | null
  predicted_per_second: number | null
  finish_reason: string | null
  reply_preview: string | null
  reply_chars: number | null
}

export type ApiRequestEvent =
  | ({ phase: 'started'; id: string; seq: number; started_at_ms: number } & ApiRequestStartedFields)
  | {
      phase: 'progress'
      id: string
      seq: number
      ttft_ms: number | null
      completion_tokens: number | null
      reply_chars: number
      elapsed_ms: number
    }
  | {
      phase: 'finished'
      id: string
      seq: number
      finished_at_ms: number
      observation: ApiRequestObservation | null
      finish: ApiRequestFinishFields | null
    }

export type CoreEventName = keyof CoreEvents

/** One serialised event record as it crosses the process boundary (SSE and stdout NDJSON). */
export interface CoreEventRecord<K extends CoreEventName = CoreEventName> {
  seq: number
  ts: number
  name: K
  payload: CoreEvents[K]
}
