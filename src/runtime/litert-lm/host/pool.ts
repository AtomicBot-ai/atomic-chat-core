/**
 * One generation at a time, and conversations kept warm (design D5, task 5.5). The C API offers many
 * conversations on one engine but promises nothing about decoding them in parallel, so requests wait
 * in arrival order rather than fail as busy. Up to four conversations keep their KV cache: a request
 * whose history is exactly what one of them holds sends the library only its new turn.
 *
 * What a conversation is created with — tools, sampling, the constraint provider — the library fixes
 * for its life (spike S2), so it is part of the key: a request with other settings starts a new one.
 */

import { createHash } from 'node:crypto'
import type { LiteRtConversationConfig, LiteRtMessage } from './library.js'

export { FifoLock } from '../../shared/index.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** JSON with sorted keys: two equal values, one string. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** What two copies of one message share, whatever a client changed in repeating it. */
function normalize(message: LiteRtMessage): unknown {
  const parts = Array.isArray(message['content']) ? message['content'] : []
  const text = parts
    .map((part) =>
      isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string' ? part['text'] : ''
    )
    .join('')
    .trim()
  const other = parts
    .filter((part) => !(isRecord(part) && part['type'] === 'text'))
    .map((part) =>
      isRecord(part) && part['type'] === 'image' && typeof part['blob'] === 'string'
        ? { image: digest(part['blob']) }
        : isRecord(part) && part['type'] === 'tool_response'
          ? { tool_response: part['name'], response: canonical(part['response']) }
          : canonical(part)
    )
  const calls = (Array.isArray(message['tool_calls']) ? message['tool_calls'] : []).map((call) => {
    const fn = isRecord(call) && isRecord(call['function']) ? call['function'] : {}
    return { name: fn['name'], arguments: canonical(fn['arguments']) }
  })
  return { role: message['role'], text, other, calls }
}

/** The key of a history: equal for two copies of one conversation. */
export function historyKey(messages: readonly LiteRtMessage[]): string {
  return digest(canonical(messages.map(normalize)))
}

export type ConversationSettings = Omit<LiteRtConversationConfig, 'messages'>

export interface PoolEntry<C> {
  conversation: C
  /** `historyKey` of everything the conversation holds. */
  key: string
  settings: string
  messages: LiteRtMessage[]
}

export class ConversationPool<C extends { close(): void }> {
  /** Least recently used first. */
  private readonly entries: PoolEntry<C>[] = []

  constructor(
    private readonly create: (config: LiteRtConversationConfig) => C,
    private readonly limit = 4
  ) {}

  get size(): number {
    return this.entries.length
  }

  /**
   * The conversation to send the next turn on: one holding exactly `history` with these settings,
   * or a new one started from `history`, evicting the least recently used beyond the limit.
   */
  take(
    history: LiteRtMessage[],
    settings: ConversationSettings
  ): { conversation: C; reused: boolean; entry: PoolEntry<C> } {
    const key = historyKey(history)
    const settingsKey = canonical(settings)
    const at = this.entries.findIndex((entry) => entry.key === key && entry.settings === settingsKey)
    if (at >= 0) {
      const [entry] = this.entries.splice(at, 1) as [PoolEntry<C>]
      this.entries.push(entry)
      return { conversation: entry.conversation, reused: true, entry }
    }
    const conversation = this.create({ messages: history, ...settings })
    const entry: PoolEntry<C> = { conversation, key, settings: settingsKey, messages: [...history] }
    this.entries.push(entry)
    while (this.entries.length > this.limit) this.entries.shift()?.conversation.close()
    return { conversation, reused: false, entry }
  }

  /** The conversation now also holds `messages` (the turn sent and the reply). */
  advance(entry: PoolEntry<C>, messages: LiteRtMessage[]): void {
    entry.messages.push(...messages)
    entry.key = historyKey(entry.messages)
  }

  /** Close and forget a conversation that cannot go on (cancelled, or a failed generation). */
  drop(entry: PoolEntry<C>): void {
    const at = this.entries.indexOf(entry)
    if (at >= 0) this.entries.splice(at, 1)
    entry.conversation.close()
  }

  closeAll(): void {
    for (const entry of this.entries.splice(0)) entry.conversation.close()
  }
}
