/**
 * Resumable chat-completion runs: the numbered, bounded event buffer of one streamed answer, and the
 * registry that keeps runs for a while after their client went away (ADR
 * 2026-11-23-resumable-chat-completion-runs).
 *
 * A run is written by one producer (the relay reading the engine) and read by any number of
 * followers, each with its own cursor: the client that started it, and every client that resumes it.
 * Events are kept in memory only. Every bound here is a constant; the registry takes overrides so
 * tests can make them small.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Buffered bytes per run. One llama.cpp chat chunk is about 250 bytes, so this keeps the last ~16k
 * tokens: a client that dropped mid-answer only needs what came after its cursor, and that is
 * always the newest part. Older events are dropped first; a cursor before them gets a 410.
 */
export const RUN_MAX_BUFFER_BYTES = 4 * 1024 * 1024
/** Runs kept at once, running or finished: with the per-run cap, at most 64 MiB of events. */
export const RUN_MAX_RETAINED = 16
/** How long a finished run can still be read: long enough for a phone to come back from the background. */
export const RUN_TTL_AFTER_FINISH_MS = 10 * 60_000
/**
 * How long a run is kept after it started while no client follows it. A run still generating then
 * is cancelled: nobody has asked for it for that long. A run with a follower is left alone, as a
 * plain stream would be; the check comes back once the follower is gone.
 */
export const RUN_MAX_AGE_MS = 60 * 60_000
/** How often expired runs are looked for while any run is kept. */
export const RUN_SWEEP_INTERVAL_MS = 30_000
/** 192 random bits, 32 base64url characters. */
const RUN_ID_BYTES = 24
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export interface RunLimits {
  maxBufferBytes: number
  maxRuns: number
  ttlAfterFinishMs: number
  maxAgeMs: number
  sweepIntervalMs: number
}

const DEFAULT_LIMITS: RunLimits = {
  maxBufferBytes: RUN_MAX_BUFFER_BYTES,
  maxRuns: RUN_MAX_RETAINED,
  ttlAfterFinishMs: RUN_TTL_AFTER_FINISH_MS,
  maxAgeMs: RUN_MAX_AGE_MS,
  sweepIntervalMs: RUN_SWEEP_INTERVAL_MS,
}

/** A buffered item: a numbered event, or comment lines (keep-alives) that have no number. */
interface RunItem {
  seq: number | undefined
  bytes: Buffer
}

/** What a follower at `cursor` gets next; `gone` when the buffer has already dropped what it needs. */
export type RunRead = { kind: 'gone' } | { kind: 'items'; bytes: Buffer[]; next: number }

/** The sha256 of a credential, or `null` on a listener that takes none. */
function ownerHash(key: string | undefined): Buffer | null {
  return key === undefined ? null : createHash('sha256').update(key, 'utf8').digest()
}

/** One streamed answer: its numbered events, who may read it, and how to stop it. */
export class ChatRun {
  /** Absolute index of `items[0]`: how many items were dropped from the front. */
  private base = 0
  private items: RunItem[] = []
  private bytes = 0
  private lastSeq = 0
  /** The highest seq dropped from the front, 0 when nothing was. */
  private droppedThrough = 0
  private waiters: Array<() => void> = []
  private aborted = false
  private finishedAtMs: number | undefined
  private followerCount = 0

  constructor(
    readonly id: string,
    private readonly owner: Buffer | null,
    readonly createdAt: number,
    private readonly abort: () => void,
    private readonly maxBufferBytes: number,
    private readonly now: () => number
  ) {}

  /** Number and keep one event (its lines and terminator, no `id:`); the seq it got, or 0 once finished. */
  appendEvent(block: Buffer): number {
    if (this.finished) return 0
    const seq = ++this.lastSeq
    this.push({ seq, bytes: Buffer.concat([Buffer.from(`id: ${seq}\n`), block]) })
    return seq
  }

  /** Keep comment lines between events; they carry no number. Ignored once finished. */
  appendComment(bytes: Buffer): void {
    if (!this.finished) this.push({ seq: undefined, bytes })
  }

  private push(item: RunItem): void {
    this.items.push(item)
    this.bytes += item.bytes.length
    // The newest item always stays, even alone over the cap: a follower needs it to go on at all.
    while (this.bytes > this.maxBufferBytes && this.items.length > 1) {
      const dropped = this.items.shift() as RunItem
      this.base++
      this.bytes -= dropped.bytes.length
      if (dropped.seq !== undefined) this.droppedThrough = dropped.seq
    }
    this.wake()
  }

  /** The stream ended, whichever way; idempotent. */
  finish(): void {
    if (this.finished) return
    this.finishedAtMs = this.now()
    this.wake()
  }

  /** Stop the generation upstream and end the run with what it has. */
  cancel(): void {
    if (!this.aborted && !this.finished) {
      this.aborted = true
      try {
        this.abort()
      } catch {
        // The upstream is already gone.
      }
    }
    this.finish()
  }

  get finished(): boolean {
    return this.finishedAtMs !== undefined
  }

  get finishedAt(): number | undefined {
    return this.finishedAtMs
  }

  /** The seq of the newest event, 0 before the first. */
  get seq(): number {
    return this.lastSeq
  }

  /** Absolute index one past the newest item. */
  get end(): number {
    return this.base + this.items.length
  }

  get followers(): number {
    return this.followerCount
  }

  attach(): void {
    this.followerCount++
  }

  detach(): void {
    this.followerCount = Math.max(0, this.followerCount - 1)
  }

  /** Whether a request presenting `key` may read and cancel this run. */
  ownedBy(key: string | undefined): boolean {
    // Started on a keyless listener: the unguessable id is the only guard.
    if (this.owner === null) return true
    const presented = ownerHash(key)
    return presented !== null && timingSafeEqual(this.owner, presented)
  }

  /**
   * Where a follower that has seen every event up to `after` starts, or `gone` when an event it has
   * not seen was dropped. Comment lines after its last event come with the rest.
   */
  startIndex(after: number): number | 'gone' {
    if (after < this.droppedThrough) return 'gone'
    let start = this.base
    this.items.forEach((item, i) => {
      if (item.seq !== undefined && item.seq <= after) start = this.base + i + 1
    })
    return start
  }

  /**
   * The items from absolute index `cursor` on, minus events up to `after` (a cursor past the newest
   * event skips the ones still to come up to it), and the index to read from next.
   */
  read(cursor: number, after: number): RunRead {
    if (cursor < this.base) return { kind: 'gone' }
    const fresh = this.items.slice(cursor - this.base)
    const bytes = fresh.filter((item) => item.seq === undefined || item.seq > after).map((item) => item.bytes)
    return { kind: 'items', bytes, next: this.end }
  }

  /** Settles on the next append or on the end of the run. */
  changed(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private wake(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }
}

/** Every resumable run of one listener, with its bounds. */
export class ChatRunRegistry {
  private readonly runs = new Map<string, ChatRun>()
  private readonly limits: RunLimits
  private readonly now: () => number
  private sweeper: NodeJS.Timeout | undefined

  constructor(options: Partial<RunLimits> & { now?: () => number } = {}) {
    const { now, ...limits } = options
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    this.now = now ?? (() => performance.now())
  }

  get size(): number {
    return this.runs.size
  }

  /**
   * A new run owned by `key` (`undefined` on a keyless listener), which `abort` stops upstream;
   * `undefined` when every slot holds a run that is still generating — the request then streams
   * as a plain one. A full registry first lets go of its oldest finished run.
   */
  create(key: string | undefined, abort: () => void): ChatRun | undefined {
    this.sweep()
    if (this.runs.size >= this.limits.maxRuns) {
      let oldest: ChatRun | undefined
      for (const run of this.runs.values()) {
        if (
          run.finishedAt !== undefined &&
          (oldest === undefined || run.finishedAt < (oldest.finishedAt ?? 0))
        )
          oldest = run
      }
      if (!oldest) return undefined
      this.runs.delete(oldest.id)
    }
    const id = randomBytes(RUN_ID_BYTES).toString('base64url')
    const run = new ChatRun(id, ownerHash(key), this.now(), abort, this.limits.maxBufferBytes, this.now)
    this.runs.set(id, run)
    this.startSweeper()
    return run
  }

  /** The run `id` names, if `key` may read it; unknown, expired and foreign runs alike are `undefined`. */
  find(id: string, key: string | undefined): ChatRun | undefined {
    this.sweep()
    if (!RUN_ID_PATTERN.test(id)) return undefined
    const run = this.runs.get(id)
    return run?.ownedBy(key) ? run : undefined
  }

  /** Forget finished runs past their TTL, and unfollowed runs past the max age (cancelling them). */
  sweep(): void {
    const now = this.now()
    for (const run of this.runs.values()) {
      const expired = run.finishedAt !== undefined && now - run.finishedAt >= this.limits.ttlAfterFinishMs
      const stale = run.followers === 0 && now - run.createdAt >= this.limits.maxAgeMs
      if (!expired && !stale) continue
      if (stale) run.cancel()
      this.runs.delete(run.id)
    }
    if (this.runs.size === 0) this.stopSweeper()
  }

  /** The listener is closing: every run stops, and none can be found any more. */
  close(): void {
    for (const run of this.runs.values()) run.cancel()
    this.runs.clear()
    this.stopSweeper()
  }

  private startSweeper(): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => this.sweep(), this.limits.sweepIntervalMs)
    this.sweeper.unref()
  }

  private stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = undefined
  }
}
