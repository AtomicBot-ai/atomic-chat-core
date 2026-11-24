/**
 * Where a history is cut: which leading turns a summary replaces and which recent ones stay as they
 * are. Pure: the sizes come from the caller, counted by the engine or estimated.
 *
 * The rules, in the order they bind:
 * - a cut is made only before a user message, so every kept turn starts where a turn starts;
 * - an assistant message that calls tools is never parted from the tool results answering it;
 * - every system message is kept (`applyCompaction` keeps the ones ahead of the cut);
 * - the latest user turn is always kept, whatever it costs;
 * - of the cuts that remain, the earliest whose kept part fits `targetRatio × window − reserve −
 *   summary` wins: as many recent turns as fit stay verbatim. When none fits, only the latest turn
 *   is kept.
 */

import type { ContextChatMessage } from '../../contracts/index.js'

export interface PlanInput {
  messages: readonly ContextChatMessage[]
  /** Each message's tokens, as the session counts them (or its best estimate). */
  sizes: readonly number[]
  /** Tokens the request takes besides its messages: tool schemas, the template's own text. */
  fixedTokens: number
  window: number
  /** Tokens kept free for the answer. */
  reserve: number
  /** Share of the window the compacted prompt aims at. */
  targetRatio: number
  /** Room the summary takes in the compacted prompt. */
  summaryTokens: number
}

export interface CompactionPlan {
  /** Index of the first message kept as is; the contract's `keepFrom`. */
  keepFrom: number
  /** Tokens of what is kept: system messages ahead of the cut, everything from it, `fixedTokens`. */
  keptTokens: number
}

function callIds(message: ContextChatMessage | undefined): string[] {
  if (!message || !Array.isArray(message.tool_calls)) return []
  return message.tool_calls.flatMap((call) => {
    const id = typeof call === 'object' && call !== null ? (call as { id?: unknown }).id : undefined
    return typeof id === 'string' ? [id] : []
  })
}

/**
 * The indices a cut may be made at: a user message with at least one non-system message ahead of
 * it, that parts no tool call from its result. A tool result is matched to its call by
 * `tool_call_id`; one right after the user message is taken as answering a call ahead of it.
 */
export function compactionBoundaries(messages: readonly ContextChatMessage[]): number[] {
  const blocked = new Set<number>()
  const calledAt = new Map<string, number>()
  messages.forEach((message, index) => {
    for (const id of callIds(message)) calledAt.set(id, index)
    const answered = message.role === 'tool' ? message.tool_call_id : undefined
    const call = typeof answered === 'string' ? calledAt.get(answered) : undefined
    if (call !== undefined) for (let k = call + 1; k <= index; k++) blocked.add(k)
  })
  const boundaries: number[] = []
  let earlier = false
  messages.forEach((message, index) => {
    if (message.role === 'user' && earlier && !blocked.has(index) && messages[index + 1]?.role !== 'tool') {
      boundaries.push(index)
    }
    if (message.role !== 'system') earlier = true
  })
  return boundaries
}

/** Tokens of what a cut at `keepFrom` keeps: the system messages ahead of it and everything after. */
export function keptTokens(
  input: Pick<PlanInput, 'messages' | 'sizes' | 'fixedTokens'>,
  keepFrom: number
): number {
  let kept = input.fixedTokens
  input.messages.forEach((message, index) => {
    if (index >= keepFrom || message.role === 'system') kept += input.sizes[index] ?? 0
  })
  return kept
}

/** Where to cut, or `undefined` when nothing can be summarized (no turn ahead of the latest one). */
export function planCompaction(input: PlanInput): CompactionPlan | undefined {
  const boundaries = compactionBoundaries(input.messages)
  const last = boundaries.at(-1)
  if (last === undefined) return undefined
  const budget = input.targetRatio * input.window - input.reserve - input.summaryTokens
  for (const keepFrom of boundaries) {
    const kept = keptTokens(input, keepFrom)
    if (kept <= budget) return { keepFrom, keptTokens: kept }
  }
  return { keepFrom: last, keptTokens: keptTokens(input, last) }
}
