/**
 * What the owner asks of every local runtime — llama.cpp (both providers), MLX and Foundation
 * Models — so the facade, the control API and the public server hold them in one table and never
 * branch on which engine a session belongs to (PLAN.md §3.2, stage 5).
 *
 * The semantics are the core's, shared by every provider rather than copied from each extension:
 * loading a model that is already loaded answers with its session (a second client attaching is not
 * an error), and unloading one that is not loaded succeeds. The desktop extensions threw in both
 * cases; their adapters keep that wording for the webview where it matters.
 */

import type { LocalProviderId, SessionInfo, UnloadResult } from '../../contracts/index.js'

/** What `autoIncreaseCtx` did, or why it declined to do anything. */
export type CtxIncreaseResult =
  | { ok: true; new_ctx_len: number; session: SessionInfo }
  | {
      ok: false
      /**
       * `fit`: llama.cpp sizes the window itself. `at_max`: the model's trained context is reached.
       * `unsupported`: the engine has no context setting to grow (Foundation Models).
       */
      reason: 'fit' | 'at_max' | 'not-loaded' | 'unsupported'
      current_ctx_len?: number
      max_ctx_len?: number
    }

export type RecreateResult = { ok: true; session: SessionInfo } | { ok: false; reason: 'not-loaded' }

/** Options every runtime understands; each one reads the keys of `overrides` that are its own. */
export interface LocalLoadOptions {
  /** Per-model settings, canonical keys (the `settings` argument of an extension's `load()`). */
  overrides?: Record<string, unknown>
  isEmbedding?: boolean
  /** Use this executable instead of resolving one (CLI `--bin`, or a resources folder). */
  exePath?: string
  /** Readiness timeout in seconds. */
  timeoutSecs?: number
  /** Append backend stdout/stderr to this path for the lifetime of the session. */
  logPath?: string
  /** Relay backend stdout/stderr through `core:log` events. */
  verbose?: boolean
  /** Bind the backend to this port instead of a random free one. */
  port?: number
  /** Skip the auto-unload of other models of this provider. */
  bypassAutoUnload?: boolean
  /**
   * Aborted when the user cancels this load: the runtime kills what it started and rejects with
   * `MODEL_LOAD_CANCELLED`. Owner shutdown has its own signal and keeps its own error.
   */
  signal?: AbortSignal
}

/**
 * How the public server must treat one session's traffic, for a runtime whose engine declares what it
 * serves instead of taking everything (`tensorrt-llm`, spec `tensorrt-llm-runtime`). A runtime without
 * a policy keeps the server's own behaviour: forward everything, grow the context on an overflow.
 */
export interface SessionRoutePolicy {
  /** The method+path routes the session serves; any other model-bearing route is refused, never forwarded. */
  routes: readonly { method: string; path: string }[]
  /** False refuses a request that asks for tool calls with a clear error, instead of silently dropping them. */
  tools: boolean
  /** False refuses a request that asks for JSON output (`response_format` json_schema/json_object). */
  structuredOutput: boolean
  /**
   * The client-facing OpenAI error for an engine error this policy knows (a context overflow), or null
   * for the server's generic wrapping. A session with a policy is never grown or recreated: its
   * context was fixed when its container started.
   */
  mapError: (status: number, body: string) => object | null
  /** The context the session was started with, when known (advertised to clients that size by it). */
  contextLength?: number
  /** The per-request output cap the session enforces, when known. */
  maxOutputTokens?: number
}

export interface LocalRuntime {
  list(): SessionInfo[]
  findSession(modelId: string): SessionInfo | undefined
  getLoadedModels(): string[]
  isLoading(modelId: string): boolean
  load(modelId: string, opts?: LocalLoadOptions): Promise<SessionInfo>
  unload(modelId: string): Promise<UnloadResult>
  autoIncreaseCtx(modelId: string, reason?: string): Promise<CtxIncreaseResult>
  recreateSession(modelId: string): Promise<RecreateResult>
  shutdown(): Promise<void>
  /** The routing policy of a loaded session; absent (or undefined) keeps the public server's defaults. */
  routePolicy?(modelId: string): SessionRoutePolicy | undefined
}

export type { LocalProviderId }
