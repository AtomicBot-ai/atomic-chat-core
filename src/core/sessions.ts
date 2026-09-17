/**
 * Local model sessions as `AtomicCore` owns them: the cross-process model claim taken before a load,
 * per-model serialization of load/unload, and how the public server finds a session — one this
 * core runs or one the desktop app registered as external.
 */

import { AtomicCoreError } from '../contracts/index.js'
import type { LocalProviderId, SessionInfo, UnloadResult } from '../contracts/index.js'
import type { DataLayout } from '../config/index.js'
import { assertNotLoadedByLegacy, acquireModelClaim } from '../lock/index.js'
import type { ModelClaimHandle } from '../lock/index.js'
import type { CtxIncreaseResult, ExternalSessions, LocalRuntime, RecreateResult } from '../runtime/index.js'
import type { CtxIncreaseOutcome, LocalTarget, SessionSummary } from '../server/index.js'
import { LOCAL_SEARCH_ORDER, modelIdsMatch } from '../router/index.js'
import type { LocalProvider } from '../router/index.js'
import type { CoreLoadOptions } from './types.js'

export interface LocalSessionsDeps {
  layout: DataLayout
  instanceId: string
  runtimes: Map<LocalProviderId, LocalRuntime>
  externalSessions: ExternalSessions
  /** The runtime for a provider; throws `PROVIDER_NOT_FOUND` for one this core does not offer. */
  runtime: (provider: LocalProviderId) => LocalRuntime
  /** Throws once the owning core is stopping; checked again inside the serialized transition. */
  assertRunning: () => void
  increaseCtx: (provider: LocalProviderId, modelId: string, reason?: string) => Promise<CtxIncreaseResult>
  recreateSession: (provider: LocalProviderId, modelId: string) => Promise<RecreateResult>
}

/** Model claims and per-model transitions for the sessions this core loads. */
export class LocalSessions {
  private readonly modelClaims = new Map<string, ModelClaimHandle>()
  private readonly claimingModels = new Map<string, Promise<ModelClaimHandle>>()
  private readonly modelTransitions = new Map<string, Promise<void>>()

  constructor(private readonly deps: LocalSessionsDeps) {}

  /** Load or attach without making an attaching client accidentally own the shared session. */
  acquire(
    provider: LocalProviderId,
    modelId: string,
    options: CoreLoadOptions
  ): Promise<{ session: SessionInfo; created: boolean }> {
    const key = `${provider}\0${modelId}`
    return this.withModelTransition(key, () => this.acquireNow(provider, modelId, options))
  }

  private async acquireNow(
    provider: LocalProviderId,
    modelId: string,
    options: CoreLoadOptions
  ): Promise<{ session: SessionInfo; created: boolean }> {
    this.deps.assertRunning()
    // The desktop app can still own this data folder until it becomes a core client. A second copy
    // of a model it already holds would double the VRAM and race for the GPU, so refuse before
    // anything is spawned, and say where the app is already serving it.
    const runtime = this.deps.runtime(provider)
    const key = `${provider}\0${modelId}`
    let claim = this.modelClaims.get(key)
    if (!claim) {
      let pending = this.claimingModels.get(key)
      if (!pending) {
        pending = acquireModelClaim(this.deps.layout, provider, modelId, this.deps.instanceId)
        this.claimingModels.set(key, pending)
      }
      try {
        claim = await pending
        this.modelClaims.set(key, claim)
      } finally {
        if (this.claimingModels.get(key) === pending) this.claimingModels.delete(key)
      }
    }
    const created = !runtime.findSession(modelId) && !runtime.isLoading(modelId)
    try {
      await assertNotLoadedByLegacy(this.deps.layout, modelId)
      const session = await runtime.load(modelId, options)
      await claim.update('ready')
      return { session, created }
    } catch (e) {
      if (created) {
        await claim.release().catch(() => {})
        this.modelClaims.delete(key)
      }
      throw e
    }
  }

  unload(provider: LocalProviderId, modelId: string): Promise<UnloadResult> {
    const key = `${provider}\0${modelId}`
    return this.withModelTransition(key, async () => {
      this.deps.assertRunning()
      const result = await this.deps.runtime(provider).unload(modelId)
      if (result.success) {
        await this.modelClaims
          .get(key)
          ?.release()
          .catch(() => {})
        this.modelClaims.delete(key)
      }
      return result
    })
  }

  /** Wait for every model transition in flight, then release every claim this core still holds. */
  async releaseAll(): Promise<void> {
    await Promise.all([...this.modelTransitions.values()])
    await Promise.all([...this.modelClaims.values()].map((claim) => claim.release().catch(() => {})))
    this.modelClaims.clear()
  }

  localTarget(provider: LocalProvider, modelId: string): LocalTarget | undefined {
    const session =
      this.deps.runtimes
        .get(provider)
        ?.list()
        .find((s) => modelIdsMatch(s.model_id, modelId)) ??
      this.deps.externalSessions.find(provider, (id) => modelIdsMatch(id, modelId))
    return session ? toLocalTarget(provider, session) : undefined
  }

  /** Every session the public server can route to, owned here or registered as external. */
  listLocalTargets(): LocalTarget[] {
    return LOCAL_SEARCH_ORDER.flatMap((provider) => [
      ...(this.deps.runtimes.get(provider)?.list() ?? []).map((s) => toLocalTarget(provider, s)),
      ...this.deps.externalSessions
        .list()
        .filter((s) => s.provider === provider)
        .map((s) => toLocalTarget(provider, s)),
    ])
  }

  /**
   * What the public server asks of a runtime when a request fails for lack of context or on a
   * poisoned engine. Recovery reloads at the same context; everything else grows it one step.
   */
  async serverCtxRequest(
    provider: LocalProvider,
    modelId: string,
    trigger: string
  ): Promise<CtxIncreaseOutcome> {
    // A session another process owns is grown by that process; the core only asks.
    const ownedHere = this.deps.runtimes
      .get(provider)
      ?.list()
      .some((s) => modelIdsMatch(s.model_id, modelId))
    const external = ownedHere
      ? undefined
      : this.deps.externalSessions.find(provider, (id) => modelIdsMatch(id, modelId))
    if (external)
      return this.deps.externalSessions.requestCtxIncrease(
        external.owner,
        provider,
        external.model_id,
        trigger
      )
    if (trigger === 'compute_error_recovery') {
      const result = await this.deps.recreateSession(provider, modelId)
      return result.ok ? { ok: true } : { ok: false, reason: result.reason }
    }
    const result = await this.deps.increaseCtx(provider, modelId, trigger)
    return result.ok ? { ok: true, new_ctx_len: result.new_ctx_len } : { ok: false, reason: result.reason }
  }

  private withModelTransition<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.modelTransitions.get(key) ?? Promise.resolve()
    const result = previous.then(operation)
    const settled = result.then(
      () => {},
      () => {}
    )
    this.modelTransitions.set(key, settled)
    void settled.then(() => {
      if (this.modelTransitions.get(key) === settled) this.modelTransitions.delete(key)
    })
    return result
  }
}

function toLocalTarget(
  provider: LocalProvider,
  session: Pick<SessionInfo, 'model_id' | 'port' | 'api_key' | 'is_embedding'>
): LocalTarget {
  return {
    provider,
    modelId: session.model_id,
    port: session.port,
    apiKey: session.api_key,
    isEmbedding: session.is_embedding,
  }
}

export function sessionsOf(runtimes: Map<LocalProviderId, LocalRuntime>): SessionSummary[] {
  const out: SessionSummary[] = []
  for (const [provider, runtime] of runtimes)
    for (const info of runtime.list()) out.push({ ...info, provider })
  return out
}

export function unknownProvider(provider: string, available: Iterable<string>): AtomicCoreError {
  return new AtomicCoreError(
    'PROVIDER_NOT_FOUND',
    `Unknown provider "${provider}".`,
    `available: ${[...available].join(', ')}`
  )
}
