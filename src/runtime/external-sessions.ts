/**
 * Sessions another process owns — the desktop app's TurboQuant, MLX and Foundation Models engines,
 * and its llama.cpp upstream engine while that runtime is still the app's — registered with the core
 * so the Local API Server it serves can route to them (PLAN.md §4, stage 4d).
 *
 * The owner publishes its whole list as a snapshot with a generation, and keeps it alive with
 * heartbeats. A snapshot from an older generation is refused, so a restarted app cannot be
 * overwritten by a request its previous run left in flight. A registration that stops beating
 * expires and its sessions vanish from routing: the core never kills a process it does not own, it
 * only stops sending traffic to it.
 *
 * Growing a registered session's context is the owner's job — it holds the process and its settings.
 * The core asks with an event carrying a request id and waits for the owner's answer, with the same
 * 60-second limit the app's own proxy gives its extension.
 */

import { randomUUID } from 'node:crypto'
import { AtomicCoreError } from '../contracts/index.js'
import type { CoreEvents, LocalProviderId } from '../contracts/index.js'

export const EXTERNAL_SESSION_TTL_MS = 30_000
export const EXTERNAL_CTX_TIMEOUT_MS = 60_000

export interface ExternalSession {
  provider: LocalProviderId
  model_id: string
  port: number
  api_key: string
  is_embedding: boolean
  pid: number | null
}

export interface ExternalCtxOutcome {
  ok: boolean
  new_ctx_len?: number
  reason?: string
}

interface Registration {
  generation: number
  sessions: ExternalSession[]
  expiresAt: number
}

const PROVIDERS: ReadonlySet<string> = new Set(['llamacpp', 'llamacpp-upstream', 'mlx', 'foundation-models'])

export interface ExternalSessionsOptions {
  emit: <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) => void
  now?: () => number
  ttlMs?: number
  ctxTimeoutMs?: number
}

export class ExternalSessions {
  private readonly owners = new Map<string, Registration>()
  private readonly pendingCtx = new Map<
    string,
    { owner: string; resolve: (outcome: ExternalCtxOutcome) => void }
  >()

  constructor(private readonly options: ExternalSessionsOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private live(): Array<[string, Registration]> {
    const now = this.now()
    for (const [owner, registration] of this.owners) {
      if (registration.expiresAt <= now) this.drop(owner, 'expired')
    }
    return [...this.owners]
  }

  private drop(owner: string, reason: 'expired' | 'unregistered'): void {
    if (!this.owners.delete(owner)) return
    // Anyone waiting for this owner's answer will not get one.
    for (const [id, pending] of this.pendingCtx) {
      if (pending.owner === owner) {
        this.pendingCtx.delete(id)
        pending.resolve({ ok: false, reason: 'owner_gone' })
      }
    }
    this.options.emit('external-sessions:changed', { owner, sessions: 0, reason })
  }

  /** Replace an owner's snapshot. An older generation than the one held is a stale request: refused. */
  publish(owner: string, generation: number, sessions: unknown): { generation: number; sessions: number } {
    if (!owner)
      throw new AtomicCoreError('INVALID_ARGUMENT', 'an external session registration needs an owner')
    if (!Number.isSafeInteger(generation) || generation < 0)
      throw new AtomicCoreError('INVALID_ARGUMENT', 'generation must be a non-negative integer')
    const current = this.owners.get(owner)
    if (current && generation < current.generation)
      throw new AtomicCoreError(
        'CORE_ALREADY_RUNNING',
        `stale registration for ${owner}: generation ${generation} is older than ${current.generation}`
      )
    const parsed = parseSessions(sessions)
    this.owners.set(owner, {
      generation,
      sessions: parsed,
      expiresAt: this.now() + (this.options.ttlMs ?? EXTERNAL_SESSION_TTL_MS),
    })
    this.options.emit('external-sessions:changed', { owner, sessions: parsed.length, reason: 'published' })
    return { generation, sessions: parsed.length }
  }

  /** Keep a registration alive. A heartbeat for a generation that is no longer held says so. */
  heartbeat(owner: string, generation: number): { alive: boolean } {
    this.live()
    const current = this.owners.get(owner)
    if (!current || current.generation !== generation) return { alive: false }
    current.expiresAt = this.now() + (this.options.ttlMs ?? EXTERNAL_SESSION_TTL_MS)
    return { alive: true }
  }

  unregister(owner: string, generation?: number): boolean {
    const current = this.owners.get(owner)
    if (!current || (generation !== undefined && current.generation !== generation)) return false
    this.drop(owner, 'unregistered')
    return true
  }

  /** Every live registered session, owner attached. */
  list(): Array<ExternalSession & { owner: string }> {
    return this.live().flatMap(([owner, registration]) => registration.sessions.map((s) => ({ ...s, owner })))
  }

  find(
    provider: string,
    matches: (modelId: string) => boolean
  ): (ExternalSession & { owner: string }) | undefined {
    return this.list().find((s) => s.provider === provider && matches(s.model_id))
  }

  /** Ask the owner to grow a session's context, and wait for its answer or the timeout. */
  requestCtxIncrease(
    owner: string,
    provider: string,
    modelId: string,
    trigger: string
  ): Promise<ExternalCtxOutcome> {
    const requestId = randomUUID()
    return new Promise<ExternalCtxOutcome>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingCtx.delete(requestId)) resolve({ ok: false, reason: 'timeout' })
      }, this.options.ctxTimeoutMs ?? EXTERNAL_CTX_TIMEOUT_MS)
      timer.unref?.()
      this.pendingCtx.set(requestId, {
        owner,
        resolve: (outcome) => {
          clearTimeout(timer)
          resolve(outcome)
        },
      })
      this.options.emit('external-sessions:ctx-requested', {
        request_id: requestId,
        owner,
        provider,
        model_id: modelId,
        trigger,
      })
    })
  }

  /** The owner's answer. An unknown or already-answered request is not an error, only `false`. */
  answerCtxIncrease(owner: string, requestId: string, outcome: unknown): boolean {
    const pending = this.pendingCtx.get(requestId)
    if (!pending || pending.owner !== owner) return false
    this.pendingCtx.delete(requestId)
    const o = (outcome ?? {}) as Record<string, unknown>
    pending.resolve({
      ok: o['ok'] === true,
      ...(typeof o['new_ctx_len'] === 'number' ? { new_ctx_len: o['new_ctx_len'] } : {}),
      ...(typeof o['reason'] === 'string' ? { reason: o['reason'] } : {}),
    })
    return true
  }
}

function parseSessions(raw: unknown): ExternalSession[] {
  if (!Array.isArray(raw)) throw new AtomicCoreError('INVALID_ARGUMENT', 'sessions must be a list')
  return raw.map((entry, index) => {
    const s = (entry ?? {}) as Record<string, unknown>
    const provider = s['provider']
    const port = s['port']
    if (typeof provider !== 'string' || !PROVIDERS.has(provider))
      throw new AtomicCoreError('INVALID_ARGUMENT', `sessions[${index}].provider is not a local provider`)
    if (typeof s['model_id'] !== 'string' || s['model_id'] === '')
      throw new AtomicCoreError('INVALID_ARGUMENT', `sessions[${index}].model_id is missing`)
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535)
      throw new AtomicCoreError('INVALID_ARGUMENT', `sessions[${index}].port is not a port`)
    return {
      provider: provider as LocalProviderId,
      model_id: s['model_id'],
      port,
      api_key: typeof s['api_key'] === 'string' ? s['api_key'] : '',
      is_embedding: s['is_embedding'] === true,
      pid: typeof s['pid'] === 'number' ? s['pid'] : null,
    }
  })
}
