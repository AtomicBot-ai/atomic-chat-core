/**
 * What the public API server needs from the rest of the core, and how it is configured.
 *
 * Deliberately narrow and injected: the server is replayed against the Rust proxy's recorded
 * exchanges (`test/contract/proxy-http.test.ts`) with stub sessions, stub providers and a scripted
 * context-increase outcome, so none of this may reach for a runtime or a settings file directly.
 */

import type { CoreEvents } from '../../contracts/index.js'
import type { LocalProvider, RemoteProvider } from '../../router/index.js'
import type { ChatGptBackend } from '../../cloud/index.js'

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
  emit?: <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) => void
  fetch?: typeof fetch
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
