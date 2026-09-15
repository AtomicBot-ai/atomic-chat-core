/**
 * Typed event emitter over the `CoreEvents` catalog with a replay ring, so the SSE bridge can
 * resume a client from a cursor (`id: <instance_id>:<seq>`, PLAN.md §3.5). Listeners that throw
 * never break the emitter.
 */

import { EventEmitter } from 'node:events'
import type { CoreEventName, CoreEventRecord, CoreEvents } from '../contracts/index.js'

export const REPLAY_RING_SIZE = 1000

export type AnyListener = (record: CoreEventRecord) => void

export interface CoreEmitterOptions {
  instanceId: string
  now?: () => number
  ringSize?: number
}

export class CoreEmitter {
  readonly instanceId: string
  private readonly inner = new EventEmitter({ captureRejections: false })
  private readonly anyListeners = new Set<AnyListener>()
  private readonly ring: CoreEventRecord[] = []
  private readonly ringSize: number
  private readonly now: () => number
  private seq = 0

  constructor(options: CoreEmitterOptions) {
    this.instanceId = options.instanceId
    this.now = options.now ?? Date.now
    this.ringSize = options.ringSize ?? REPLAY_RING_SIZE
    this.inner.setMaxListeners(0)
  }

  /** Sequence number of the last emitted event (0 before any). */
  get lastSeq(): number {
    return this.seq
  }

  on<K extends CoreEventName>(name: K, listener: (payload: CoreEvents[K]) => void): () => void {
    const wrapped = (payload: CoreEvents[K]) => listener(payload)
    this.inner.on(name, wrapped)
    return () => this.inner.off(name, wrapped)
  }

  once<K extends CoreEventName>(name: K, listener: (payload: CoreEvents[K]) => void): () => void {
    const wrapped = (payload: CoreEvents[K]) => listener(payload)
    this.inner.once(name, wrapped)
    return () => this.inner.off(name, wrapped)
  }

  /** Receive every event as a serialisable record — used by the SSE and log bridges. */
  onAny(listener: AnyListener): () => void {
    this.anyListeners.add(listener)
    return () => {
      this.anyListeners.delete(listener)
    }
  }

  emit<K extends CoreEventName>(name: K, payload: CoreEvents[K]): CoreEventRecord<K> {
    const record: CoreEventRecord<K> = { seq: ++this.seq, ts: this.now(), name, payload }
    this.ring.push(record)
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize)
    try {
      this.inner.emit(name, payload)
    } catch {
      // A listener threw; the event is still recorded and delivered to the others.
    }
    for (const l of this.anyListeners) {
      try {
        l(record)
      } catch {
        // same: never let a bridge failure poison the emitter
      }
    }
    return record
  }

  /**
   * Records after `afterSeq`, or `undefined` when they have fallen out of the ring (the client must
   * resync from a fresh snapshot). `afterSeq = 0` replays everything still buffered only when the
   * ring has never overflowed.
   */
  replayAfter(afterSeq: number): CoreEventRecord[] | undefined {
    const oldest = this.ring[0]
    if (afterSeq >= this.seq) return []
    if (oldest === undefined) return afterSeq === 0 ? [] : undefined
    if (afterSeq < oldest.seq - 1) return undefined
    return this.ring.filter((r) => r.seq > afterSeq)
  }

  /** Cursor string a client hands back on reconnect. */
  cursor(seq = this.seq): string {
    return `${this.instanceId}:${seq}`
  }

  /** Parse a cursor; `undefined` when it belongs to another instance or is malformed. */
  parseCursor(cursor: string): number | undefined {
    const colon = cursor.lastIndexOf(':')
    if (colon < 0 || cursor.slice(0, colon) !== this.instanceId) return undefined
    const seq = Number(cursor.slice(colon + 1))
    return Number.isInteger(seq) && seq >= 0 ? seq : undefined
  }
}
