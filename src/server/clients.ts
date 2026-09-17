/**
 * Who is attached to this core. The app and the CLI register, heartbeat while they are up, and
 * unregister on exit; the core keeps running either way (PLAN.md §3.6, "Client exit": "detach and heartbeat stop").
 *
 * The registry exists for one decision: `shutdown` must tell "nobody is using this core" from
 * "somebody else is using it", and a client that vanished without unregistering must age out rather
 * than block shutdown forever.
 */

import { randomUUID } from 'node:crypto'
import { AtomicCoreError } from '../contracts/index.js'

export const CLIENT_HEARTBEAT_INTERVAL_MS = 15_000
/** Three missed heartbeats: a client that stops reporting is gone, not merely busy. */
export const CLIENT_EXPIRY_MS = 3 * CLIENT_HEARTBEAT_INTERVAL_MS

export interface ClientRecord {
  id: string
  name: string
  pid: number | null
  registered_at: number
  last_seen: number
}

export interface RegisterClientInput {
  name?: string
  pid?: number | null
}

export class ClientRegistry {
  private readonly clients = new Map<string, ClientRecord>()
  private stopping = false

  constructor(
    private readonly now: () => number = Date.now,
    private readonly expiryMs: number = CLIENT_EXPIRY_MS
  ) {}

  register(input: RegisterClientInput = {}): ClientRecord {
    if (this.stopping)
      throw new AtomicCoreError('CORE_NOT_RUNNING', 'This core is stopping; new clients cannot attach.')
    const ts = this.now()
    const record: ClientRecord = {
      id: randomUUID(),
      name: (input.name ?? 'unnamed').slice(0, 200),
      pid: typeof input.pid === 'number' ? input.pid : null,
      registered_at: ts,
      last_seen: ts,
    }
    this.clients.set(record.id, record)
    return { ...record }
  }

  /** `false` when the id is unknown or already expired: the client must register again. */
  heartbeat(id: string): boolean {
    this.sweep()
    const record = this.clients.get(id)
    if (!record) return false
    record.last_seen = this.now()
    return true
  }

  unregister(id: string): boolean {
    return this.clients.delete(id)
  }

  list(): ClientRecord[] {
    this.sweep()
    return [...this.clients.values()].map((c) => ({ ...c }))
  }

  count(): number {
    return this.list().length
  }

  /** Everyone but the caller — what `shutdown` checks before stopping a core someone else is using. */
  others(exceptId: string | undefined): ClientRecord[] {
    return this.list().filter((c) => c.id !== exceptId)
  }

  /** Check leases and close admission in one synchronous step. */
  acceptShutdown(exceptId: string | undefined, force: boolean): ClientRecord[] {
    const others = this.others(exceptId)
    if (others.length === 0 || force) this.stopping = true
    return others
  }

  private sweep(): void {
    const cutoff = this.now() - this.expiryMs
    for (const [id, record] of this.clients) if (record.last_seen < cutoff) this.clients.delete(id)
  }
}
