/**
 * Event catalog. Every event the core emits is listed here with its payload. The app's
 * `CoreEventBridge` maps these onto the legacy `@janhq/core` names (PLAN.md §3.5).
 * Adding an event = add it here + add the relay mapping in the app, in the same PR pair.
 */

import type {
  DiffusionErrorEvent,
  DiffusionJobEvent,
  DiffusionVideoJobEvent,
  DiffusionVideoProgressEvent,
  DiffusionProgressEvent,
  DiffusionStateEvent,
} from './diffusion.js'
import type { EngineBuildChangedEvent } from './engine-builds.js'
import type { EngineChangedEvent } from './engines.js'
import type { EnvironmentOperation, EnvironmentSnapshot } from './environment.js'
import type { DecisionErrorEvent, DecisionStateEvent } from './decision.js'
import type { EmbeddingErrorEvent, EmbeddingStateEvent } from './embedding.js'
import type { ModelSetup } from './model-setup.js'
import type { RemoteAccessStatus } from './remote-access.js'
import type { LocalProviderId, RuntimeDeviceInfo, SessionInfo, SessionLoadStage } from './session.js'

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

  'settings:changed': {
    provider: LocalProviderId | 'server' | 'cloud' | 'decision' | 'embedding'
    key: string
    value: unknown
  }

  'session:started': SessionInfo & { provider: LocalProviderId }
  'session:died': {
    provider: LocalProviderId
    /** null when the session was a container: it never had a host process to report. */
    pid: number | null
    model_id: string
    exit_code: number | null
    signal: string | null
    message: string
    /**
     * Why the session ended when it was not the engine's own exit (change `add-tensorrt-llm-windows`):
     * `wsl-stopped` — the WSL distribution or VM stopped under it (`wsl --shutdown`). Absent otherwise;
     * additive, a client that predates it ignores the key.
     */
    reason?: 'wsl-stopped'
  }
  'session:ctx-increased': {
    provider: LocalProviderId
    modelId: string
    oldCtx: number
    newCtx: number
    reason: string
  }
  /** `pid` is null when the session was a container: it never had a host process to report. */
  'session:unloaded': { provider: LocalProviderId; model_id: string; pid: number | null }
  /**
   * Managed-runtime load stages (design D8, spec `tensorrt-llm-runtime`): `generation` ties the
   * progress to the exact load a caller started, since a second load of the same model replaces it
   * with a new one. Only a container-backed provider emits this; a native load has no stages to
   * report and goes straight from `session:started` to ready.
   */
  'session:load-progress': {
    provider: LocalProviderId
    model_id: string
    generation: string
    stage: SessionLoadStage
    elapsed_ms: number
    /**
     * Present on every progress event of a load whose saved card was not found by the probe, so it
     * runs on the card with the most free memory instead (spec `tensorrt-llm-runtime`, "Выбранная карта
     * исчезла"). Absent when the load runs where it was asked to.
     */
    gpu_substituted?: { requested_gpu_id: string; gpu_id: string }
  }

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
  /** Video generation shares `state` and `error`; its jobs have their own two, so image consumers see no new shape. */
  'diffusion:video-progress': DiffusionVideoProgressEvent
  'diffusion:video-job': DiffusionVideoJobEvent

  /**
   * Managed text runtimes (`src/contracts/environment.ts`; openspec change `add-tensorrt-llm-linux`).
   * Both carry full state rather than a delta, so a client that reconnects rebuilds from the
   * snapshot and then applies whatever arrives. Both are proposed: no producer exists yet.
   *
   * `changed` is one environment and the engines installed into it. `operation` is one durable
   * setup, update or removal. Each carries `instance_id` and `revision`: apply only a strictly
   * newer revision of the current instance, and treat an equal revision as a no-op.
   */
  'environment:changed': EnvironmentSnapshot
  'environment:operation': EnvironmentOperation

  /**
   * An sd.cpp or MLX build was installed, removed, or cleaned up at start (spec `engine-builds`):
   * re-read `POST /engine-builds/:engine/catalog` instead of polling it.
   */
  'engine-build:changed': EngineBuildChangedEvent

  /**
   * The set or the active build of any engine changed (change `unify-engine-lifecycle`, design D8):
   * published by every route that installs, activates or removes a build, `/backends` and
   * `/engine-builds` included. Re-read `POST /engines/versions`. `engine-build:changed` stays for
   * the desktop releases that listen to it.
   */
  'engine:changed': EngineChangedEvent

  /**
   * The decision model (ADR 2026-09-30-the-decision-model-is-its-own-core-module). `state` on every
   * status change (the payload is the whole `DecisionStatus`, like `GET /decision/status`); `error`
   * for a failure nobody is awaiting: a crash, a failed restart, restarts given up.
   */
  'decision:state': DecisionStateEvent
  'decision:error': DecisionErrorEvent

  /**
   * The embedding model (ADR 2026-10-07-embedding-models-are-their-own-core-module), the same pair:
   * `state` on every status change (the whole `EmbeddingStatus`, like `GET /embedding/status`),
   * `error` for a failure nobody is awaiting.
   */
  'embedding:state': EmbeddingStateEvent
  'embedding:error': EmbeddingErrorEvent

  /**
   * Every write of a model setup (`src/contracts/model-setup.ts`), the whole record: keep the one
   * with the highest `revision` per `setup_id`.
   */
  'model-setup:changed': ModelSetup

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
