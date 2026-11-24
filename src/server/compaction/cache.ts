/**
 * Summaries already made, so a client that sends its whole history with every turn — what every
 * OpenAI client does — is not summarized again each time, and the next compaction only adds the
 * turns since the last one to the summary it already has.
 *
 * A summary is keyed by the model and the messages it replaced: the sha256 of the model, then of
 * each message's canonical JSON in turn, so the keys of every prefix of a history come out of one
 * pass over it and the longest summarized prefix is a lookup per cut. In memory only, and bounded:
 * the least recently used summary goes first.
 */

import { createHash } from 'node:crypto'
import type { ContextChatMessage } from '../../contracts/index.js'

/** Summaries kept at most. A summary is a few kilobytes: the cache stays within a few megabytes. */
export const SUMMARY_CACHE_ENTRIES = 256

/** JSON with every object's keys sorted: the same message always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item ?? null)).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && typeof v !== 'function')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * The key of every prefix of `messages` for one model: `keys[n]` names the first `n` messages, so
 * `keys[0]` names none and there are `messages.length + 1` keys.
 */
export function prefixKeys(
  provider: string,
  modelId: string,
  messages: readonly ContextChatMessage[]
): string[] {
  let key = sha256(`atomic-compaction\0${provider}\0${modelId}`)
  const keys = [key]
  for (const message of messages) {
    key = sha256(`${key}\0${canonicalJson(message)}`)
    keys.push(key)
  }
  return keys
}

export class SummaryCache {
  private readonly summaries = new Map<string, string>()
  private readonly pending = new Map<string, Promise<unknown>>()

  constructor(private readonly maxEntries = SUMMARY_CACHE_ENTRIES) {}

  get size(): number {
    return this.summaries.size
  }

  /** The summary under `key`, which becomes the most recently used. */
  get(key: string): string | undefined {
    const summary = this.summaries.get(key)
    if (summary === undefined) return undefined
    this.summaries.delete(key)
    this.summaries.set(key, summary)
    return summary
  }

  set(key: string, summary: string): void {
    this.summaries.delete(key)
    while (this.summaries.size >= this.maxEntries) {
      const oldest = this.summaries.keys().next().value
      if (oldest === undefined) break
      this.summaries.delete(oldest)
    }
    this.summaries.set(key, summary)
  }

  /**
   * `produce()` for `key`, or the one already running for it: two requests that compact the same
   * history at once ask the model once.
   */
  once<T>(key: string, produce: () => Promise<T>): Promise<T> {
    const running = this.pending.get(key)
    if (running) return running as Promise<T>
    const started = produce().finally(() => this.pending.delete(key))
    this.pending.set(key, started)
    return started
  }
}
