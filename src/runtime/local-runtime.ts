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

import type { LocalProviderId, SessionInfo, UnloadResult } from '../contracts/index.js'

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
}

export type { LocalProviderId }
