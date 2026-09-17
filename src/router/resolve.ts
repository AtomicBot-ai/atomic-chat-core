/**
 * Which backend serves a model (PLAN.md §3.2).
 *
 * Ported from: src-tauri/src/core/server/proxy.rs (the provider lookup shared by `/chat/completions`,
 * `/messages` and `/responses`) and `core/sessions/resolver.rs`.
 * See PLAN.md §3.2. Public API of this module is exported from this file only.
 */

/** A cloud provider the app registered: where to send its models and with which credentials. */
export interface RemoteProvider {
  /** Registry key, e.g. `openai`, `openrouter`. */
  provider: string
  apiKey?: string | null
  baseUrl?: string | null
  customHeaders: Array<{ header: string; value: string }>
  /** Model ids the user has enabled for this provider. */
  models: string[]
}

export type LocalProvider = 'llamacpp' | 'llamacpp-upstream' | 'mlx'

/**
 * The order local providers are searched in when a request names only a model. The same model id
 * loaded under two engines resolves to the first; changing the order would silently move traffic.
 */
export const LOCAL_SEARCH_ORDER: readonly LocalProvider[] = ['llamacpp', 'llamacpp-upstream', 'mlx']

/**
 * The remote provider that owns `modelId`, if any. Remote wins over local — a model id the user
 * enabled for a cloud provider is never served by a local session of the same name.
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
