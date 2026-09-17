/**
 * Growing a local model's context when a request overflows it, then finding where the reloaded
 * model now listens.
 *
 * Ported from: src-tauri/src/core/server/proxy.rs (`maybe_auto_increase_and_retry`),
 * src-tauri/src/core/server/context_expansion.rs (`request_context_increase` leader/follower slots).
 *
 * Concurrent overflows of the same model share one reload: the first caller leads, the rest wait for
 * its outcome. Without that, N parallel requests would each reload the model and ratchet the context
 * N steps at once.
 */

import type { LocalProvider } from '../../router/index.js'
import type { CtxIncreaseOutcome, PublicServerDeps } from './types.js'

export type CtxTrigger = 'error' | 'finish_length' | 'compute_error_recovery'

const inFlight = new WeakMap<PublicServerDeps, Map<string, Promise<CtxIncreaseOutcome>>>()

function requestIncrease(
  deps: PublicServerDeps,
  provider: LocalProvider,
  modelId: string,
  trigger: CtxTrigger
): Promise<CtxIncreaseOutcome> {
  let pending = inFlight.get(deps)
  if (!pending) inFlight.set(deps, (pending = new Map()))
  const key = `${provider}:${modelId}`
  const existing = pending.get(key)
  if (existing) return existing
  const leader = deps
    .increaseCtx(provider, modelId, trigger)
    .catch((e: unknown): CtxIncreaseOutcome => ({ ok: false, reason: (e as Error).message }))
    .finally(() => pending.delete(key))
  pending.set(key, leader)
  return leader
}

/**
 * Ask for a larger context; on success, the session's new port and key, resolved afresh because
 * the model is now a different process. Embedding sessions are never grown: their inputs are
 * batched to a fixed size and have no overflow to fix.
 */
export async function autoIncreaseCtx(
  deps: PublicServerDeps,
  provider: LocalProvider,
  modelId: string,
  trigger: CtxTrigger
): Promise<{ port: number; apiKey: string } | undefined> {
  if (deps.findLocal(provider, modelId)?.isEmbedding) return undefined
  const outcome = await requestIncrease(deps, provider, modelId, trigger)
  if (!outcome.ok) return undefined
  const session = deps.findLocal(provider, modelId)
  return session ? { port: session.port, apiKey: session.apiKey } : undefined
}
