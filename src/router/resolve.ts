/**
 * Which backend serves a model (PLAN.md §3.2).
 *
 * Ported from: src-tauri/src/core/server/proxy.rs (the provider lookup shared by `/chat/completions`,
 * `/messages` and `/responses`) and `core/sessions/resolver.rs`.
 * See PLAN.md §3.2. Public API of this module is exported from this file only.
 */

import type { CloudProviderMedia, MediaKind, MediaTarget } from '../contracts/index.js'

/** A cloud provider the app registered: where to send its models and with which credentials. */
export interface RemoteProvider {
  /** Registry key, e.g. `openai`, `openrouter`. */
  provider: string
  apiKey?: string | null
  baseUrl?: string | null
  customHeaders: Array<{ header: string; value: string }>
  /** Model ids the user has enabled for this provider. */
  models: string[]
  /** The image and video models enabled for this provider; never part of chat routing. */
  media?: CloudProviderMedia
}

export type LocalProvider =
  | 'llamacpp'
  | 'llamacpp-upstream'
  | 'mlx'
  | 'tensorrt-llm'
  | 'atomic-prism'
  | 'vllm'
  | 'sglang'
  | 'foundry-local'

/**
 * The order local providers are searched in when a request names only a model. The same model id
 * loaded under two engines resolves to the first; changing the order would silently move traffic.
 * `tensorrt-llm`, `atomic-prism`, `vllm` and `sglang` come last, in the order they were added, for
 * exactly that reason: adding a provider moves nothing that already resolved (`vllm` after
 * `atomic-prism`, which core 0.10.0 already shipped; change `add-vllm-runtime`, D11; `sglang` after
 * `vllm`, change `add-sglang-runtime`, D8; `foundry-local` after `sglang`, change `add-foundry-local`, D5). A Prism-only file never loads
 * under another engine (the compatibility gate), so its sessions are found here even near the end of
 * the list; one store model is never loaded in two managed providers at once, so their order never
 * decides between two live sessions of one id.
 */
export const LOCAL_SEARCH_ORDER: readonly LocalProvider[] = [
  'llamacpp',
  'llamacpp-upstream',
  'mlx',
  'tensorrt-llm',
  'atomic-prism',
  'vllm',
  'sglang',
  'foundry-local',
]

/**
 * The remote provider that owns `modelId`, if any. For an id the app selected no provider for
 * (`resolveSelectedRoute`), remote wins over local — a model id the user enabled for a cloud
 * provider is never served by a local session of the same name. An id with a selection goes to the
 * selected provider only (ADR 2026-10-21-route-a-selected-model-id-to-its-selected-provider-only).
 *
 * Three rules, in order, exactly as the proxy applies them:
 * 1. a provider that lists the model id;
 * 2. the text before the first `/` names a registered provider (`openrouter/anthropic/claude`);
 * 3. the whole id is a provider key.
 */
export function resolveRemoteProvider(
  modelId: string,
  providers: ReadonlyMap<string, RemoteProvider>
): RemoteProvider | undefined {
  for (const config of providers.values()) {
    if (config.models.includes(modelId)) return config
  }
  const slash = modelId.indexOf('/')
  if (slash >= 0) {
    const byPrefix = providers.get(modelId.slice(0, slash))
    if (byPrefix) return byPrefix
  }
  return providers.get(modelId)
}

/** Where a model id the app selected a provider for is served. */
export type SelectedRoute =
  { kind: 'remote'; provider: RemoteProvider } | { kind: 'local'; provider: LocalProvider }

/**
 * The provider the app selected to serve `modelId` (`PUT /atomic/v1/server/selection`), when this
 * core can route to it: a registered remote provider, or a local engine. The id is matched with the
 * proxy's `.`/`_` rule. `undefined` — no selection, or one naming a provider this core does not know
 * (an unregistered cloud provider, Apple Foundation Models) — leaves the id to the rules without one.
 * A selected remote provider is strict. A selected local engine means "local": the caller asks that
 * engine first, then any other local session of the id (the app and the core may name the engine
 * differently), and refuses the request rather than send it to a remote provider that lists it.
 */
export function resolveSelectedRoute(
  modelId: string,
  selection: ReadonlyMap<string, string>,
  providers: ReadonlyMap<string, RemoteProvider>
): SelectedRoute | undefined {
  let selected = selection.get(modelId)
  if (selected === undefined) {
    for (const [id, provider] of selection) {
      if (modelIdsMatch(id, modelId)) {
        selected = provider
        break
      }
    }
  }
  if (selected === undefined) return undefined
  const remote = providers.get(selected)
  if (remote) return { kind: 'remote', provider: remote }
  const local = LOCAL_SEARCH_ORDER.find((provider) => provider === selected)
  return local === undefined ? undefined : { kind: 'local', provider: local }
}

/**
 * The proxy's model-id comparison: `.` and `_` are the same character, because clients and
 * filesystems substitute one for the other (`Qwen3_5-9B` is `Qwen3.5-9B`). Nothing else is folded.
 */
export function modelIdsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x === y) continue
    if ((x === '.' && y === '_') || (x === '_' && y === '.')) continue
    return false
  }
  return true
}

/**
 * The provider that serves the image or video model a client names, among the enabled media models
 * only (chat models never match). Two rules, in order:
 * 1. `<provider>/<model>` where `<provider>` is registered and lists `<model>` (`openrouter/google/veo-3.1`);
 * 2. the first provider, in registration order, that lists the whole id.
 */
export function resolveRemoteMedia(
  modelId: string,
  kind: MediaKind,
  providers: ReadonlyMap<string, RemoteProvider>
): MediaTarget | undefined {
  const lists = (config: RemoteProvider, id: string): boolean =>
    config.media?.models.some((model) => model.kind === kind && model.id === id) ?? false
  const slash = modelId.indexOf('/')
  if (slash > 0) {
    const named = providers.get(modelId.slice(0, slash))
    const rest = modelId.slice(slash + 1)
    if (named && lists(named, rest)) return { provider: named.provider, model: rest }
  }
  for (const config of providers.values())
    if (lists(config, modelId)) return { provider: config.provider, model: modelId }
  return undefined
}
