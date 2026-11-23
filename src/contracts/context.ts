/**
 * Context-window contracts shared with the app: the window a model gets by default on this device,
 * what a chat request measures against the window its session serves, and history compaction —
 * summarizing the oldest turns of a chat that no longer fits, so it goes on without reloading the
 * model. Browser-safe: the app imports these from `@atomic-chat/core/contracts`.
 *
 * One rule for every engine: a session that can be reloaded at a larger window (`reload`) and is
 * below its device maximum grows once, straight to that maximum; every other overflow is compacted.
 * Restarting a container or an NPU runtime takes minutes, so `restart` and `fixed` engines are only
 * ever compacted.
 */

import { MANAGED_PROVIDER_IDS } from './session.js'
import type { LocalProviderId } from './session.js'

/**
 * How a session's window can change: `reload` — the core reloads the model with a larger window in
 * seconds (llama.cpp, MLX); `restart` — the engine process or container must be restarted with a new
 * setting (managed engines, Strata, FastFlowLM, GenieX, LiteRT-LM); `fixed` — the window belongs to
 * the model or the platform (Foundry Local, Apple Foundation Models).
 */
export type ContextResizeMode = 'reload' | 'restart' | 'fixed'

const RELOAD_PROVIDERS: ReadonlySet<string> = new Set([
  'llamacpp-upstream',
  'llamacpp',
  'atomic-prism',
  'mlx',
])
const FIXED_PROVIDERS: ReadonlySet<string> = new Set(['foundry-local', 'foundation-models'])
const RESTART_PROVIDERS: ReadonlySet<string> = new Set([
  ...MANAGED_PROVIDER_IDS,
  'strata',
  'fastflowlm',
  'geniex',
  'litert-lm',
])

/** How `provider`'s window can change; `undefined` for a provider that is not a local engine. */
export function contextResizeMode(provider: LocalProviderId | string): ContextResizeMode | undefined {
  if (RELOAD_PROVIDERS.has(provider)) return 'reload'
  if (RESTART_PROVIDERS.has(provider)) return 'restart'
  if (FIXED_PROVIDERS.has(provider)) return 'fixed'
  return undefined
}

/**
 * Where a context plan's numbers come from: the device's memory (`unified` — Apple silicon,
 * `gpu` — a discrete accelerator, `cpu` — system RAM only), the engine's own fit (`engine` — a
 * managed engine's memory rule), or the model alone (`model` — the window the model declares, which
 * the engine runs as is).
 */
export type ContextPlanBasis = 'unified' | 'gpu' | 'cpu' | 'engine' | 'model'

/**
 * The window a model gets on this device when nobody chose one: the largest that fits, never above
 * the window it was trained for. Part of `GET /models/:provider/*modelId/capabilities`.
 */
export interface ContextPlan {
  /** The window a load gets by default. */
  recommendedCtx: number
  /** The largest window the device can hold for this model; a grow never goes past it. */
  maxCtx: number
  /** `{arch}.context_length` or the checkpoint's own maximum, when known. */
  trainedCtx?: number
  /** KV-cache bytes per token of context, when estimated. */
  kvBytesPerToken?: number
  basis: ContextPlanBasis
}

/** The OpenAI error `code` every engine's context overflow is mapped to. */
export const CONTEXT_LENGTH_EXCEEDED = 'context_length_exceeded'

/** Request header: `off` keeps the public server from compacting this request's history. */
export const COMPACTION_REQUEST_HEADER = 'x-atomic-compaction'
/** Response header: how many messages of the request the server replaced with a summary. */
export const COMPACTED_RESPONSE_HEADER = 'x-atomic-compacted'

/** Share of the window a compacted prompt aims at, so compaction stays rare. */
export const COMPACTION_TARGET_RATIO = 0.5

/** An OpenAI chat message as far as context handling needs it. */
export interface ContextChatMessage {
  role: string
  content?: unknown
  tool_calls?: unknown
  tool_call_id?: string
  [key: string]: unknown
}

/** `POST /models/:provider/*modelId/context/measure`. */
export interface ContextMeasureRequest {
  messages: ContextChatMessage[]
  tools?: unknown[]
  chat_template_kwargs?: Record<string, unknown>
}

/** What the session's engine counts for a request, and the windows it is measured against. */
export interface ContextMeasureResult {
  promptTokens: number
  /** Counted by the engine's tokenizer; `false` for an estimate (calibrated when the session has answered before). */
  exact: boolean
  /** The window the session serves, when known. */
  windowTokens?: number
  /** The largest window this device can hold for the model (`ContextPlan.maxCtx`), when known. */
  maxWindowTokens?: number
  resize: ContextResizeMode
  /** The engine streams `prompt_progress` when asked with `return_progress`. */
  supportsPromptProgress: boolean
}

/** `POST /models/:provider/*modelId/compact`. */
export interface CompactRequest {
  messages: ContextChatMessage[]
  tools?: unknown[]
  /** Tokens kept free for the answer; the server's default answer reserve when absent. */
  reserveTokens?: number
  /** Share of the window the compacted prompt aims at; {@link COMPACTION_TARGET_RATIO} when absent. */
  targetRatio?: number
}

/** A compaction of a request's history. Apply it with {@link applyCompaction}. */
export interface CompactResult {
  /** The summary of the replaced messages, in the conversation's language. */
  summary: string
  /**
   * Index into the request's `messages` of the first message kept as is. Every non-system message
   * before it is replaced by the summary; system messages before it are kept.
   */
  keepFrom: number
  /** How many messages the summary replaces. */
  summarizedCount: number
  tokensBefore: number
  tokensAfter: number
  /** Answered from the summary cache, without asking the model. */
  cached: boolean
}

/** Payload of `session:history-compacted`. */
export interface HistoryCompactedEvent {
  provider: LocalProviderId
  modelId: string
  summarizedMessages: number
  tokensBefore: number
  tokensAfter: number
  cached: boolean
  /** `api` — the public server compacted a client's request; `control` — a client asked for it. */
  source: 'api' | 'control'
}

const SUMMARY_OPEN = '<conversation_summary>'
const SUMMARY_CLOSE = '</conversation_summary>'
const SUMMARY_PREAMBLE = 'The earlier part of this conversation was summarized to fit the context window:'
/** A summary block and the blank line in front of it, wherever it sits in a text. */
const SUMMARY_BLOCK_PATTERN = /(?:\n\n)?<conversation_summary>\n?([\s\S]*?)\n?<\/conversation_summary>/

/** The block a summary is placed in, inside the system prompt. */
export function summaryBlock(summary: string): string {
  return `${SUMMARY_OPEN}\n${SUMMARY_PREAMBLE}\n${summary.trim()}\n${SUMMARY_CLOSE}`
}

/** A text without its summary block, and the summary that block held. */
function splitSummary(text: string): { text: string; summary?: string } {
  const match = SUMMARY_BLOCK_PATTERN.exec(text)
  if (!match) return { text }
  const inner = (match[1] ?? '').trim()
  const summary = (inner.startsWith(SUMMARY_PREAMBLE) ? inner.slice(SUMMARY_PREAMBLE.length) : inner).trim()
  return { text: text.replace(match[0], ''), ...(summary ? { summary } : {}) }
}

/** Message content without its summary block, and the summary it held. */
function contentWithoutSummary(content: unknown): { content: unknown; summary?: string } {
  if (typeof content === 'string') {
    const split = splitSummary(content)
    return { content: split.text, ...(split.summary !== undefined ? { summary: split.summary } : {}) }
  }
  if (!Array.isArray(content)) return { content }
  let summary: string | undefined
  const parts = content.flatMap((part: unknown) => {
    if (typeof part !== 'object' || part === null) return [part]
    const text = (part as { text?: unknown }).text
    if (typeof text !== 'string') return [part]
    const split = splitSummary(text)
    if (split.summary === undefined && split.text === text) return [part]
    summary ??= split.summary
    return split.text.trim() ? [{ ...(part as object), text: split.text }] : []
  })
  return { content: parts, ...(summary !== undefined ? { summary } : {}) }
}

/**
 * The summary a request already carries in its system prompt (the block {@link applyCompaction}
 * put there on an earlier compaction), and the messages without that block — so the next
 * compaction can summarize the summary so far together with the turns it replaces, and nothing an
 * earlier summary held is lost. Messages keep their positions — a system message that held nothing
 * but the block stays, empty — so an index into the result is an index into `messages`.
 */
export function carriedSummary<M extends ContextChatMessage>(
  messages: readonly M[]
): { messages: M[]; summary?: string } {
  let summary: string | undefined
  const out = messages.map((message) => {
    if (message.role !== 'system' || summary !== undefined) return message
    const split = contentWithoutSummary(message.content)
    if (split.summary === undefined) return message
    summary = split.summary
    return { ...message, content: split.content }
  })
  return { messages: out, ...(summary !== undefined ? { summary } : {}) }
}

function withSummary(content: unknown, block: string): unknown {
  const { content: base } = contentWithoutSummary(content)
  if (typeof base === 'string') return base.trim() ? `${base}\n\n${block}` : block
  if (Array.isArray(base)) return [...base, { type: 'text', text: `\n\n${block}` }]
  return block
}

/**
 * `messages` with the compaction applied: system messages ahead of `keepFrom` are kept, the summary
 * is appended to the first of them (or becomes a leading system message when there is none),
 * replacing a summary block an earlier compaction left there, the other messages ahead of
 * `keepFrom` are dropped, and the rest follow unchanged. Merging the summary into the system prompt
 * keeps strict chat templates — the ones that require user and assistant turns to alternate — valid.
 */
export function applyCompaction<M extends ContextChatMessage>(
  messages: readonly M[],
  compaction: Pick<CompactResult, 'summary' | 'keepFrom'>
): M[] {
  const keepFrom = Math.max(0, Math.min(compaction.keepFrom, messages.length))
  const block = summaryBlock(compaction.summary)
  const leadingSystems = messages.slice(0, keepFrom).filter((m) => m.role === 'system')
  const rest = messages.slice(keepFrom)
  if (leadingSystems.length === 0) {
    return [{ role: 'system', content: block } as unknown as M, ...rest]
  }
  const [first, ...others] = leadingSystems
  return [{ ...first, content: withSummary(first?.content, block) } as M, ...others, ...rest]
}

/**
 * `POST /tokenize` with a chat body, as vLLM answers it and as the GenieX and LiteRT-LM hosts answer
 * it: the prompt the chat template renders for `messages` (and `tools`), counted by the engine's own
 * tokenizer. A session offers it when its route policy declares `POST /tokenize`.
 */
export interface ChatTokenizeRequest {
  model?: string
  messages: ContextChatMessage[]
  tools?: unknown[]
  add_generation_prompt?: boolean
}

/** The answer to {@link ChatTokenizeRequest}; extra fields (vLLM's `tokens`, `max_model_len`) are ignored. */
export interface ChatTokenizeResponse {
  count: number
}

/** Share of the window a request may fill (prompt plus the answer reserve) before it counts as overflowing. */
export const CONTEXT_FIT_RATIO = 0.9

/** What to do about a request: send it as is, grow the window first, or compact the history. */
export type OverflowAction = 'none' | 'expand' | 'compact'

/**
 * The one overflow rule, shared by the app's chat and the public server. A request fits when its
 * prompt plus answer reserve stays within {@link CONTEXT_FIT_RATIO} of the window. One that does not
 * grows the window only on an engine that reloads in seconds (`reload`), only while the window is
 * below the device maximum, and only when the maximum would hold it; every other overflow is
 * compacted. An unknown window is never acted on: the engine's own overflow error is the safety net.
 */
export function decideOverflowAction(input: {
  resize: ContextResizeMode | undefined
  neededTokens: number
  windowTokens: number | undefined
  maxWindowTokens?: number | undefined
}): OverflowAction {
  const { resize, neededTokens, windowTokens, maxWindowTokens } = input
  if (windowTokens === undefined || !(windowTokens > 0)) return 'none'
  if (neededTokens <= windowTokens * CONTEXT_FIT_RATIO) return 'none'
  if (
    resize === 'reload' &&
    maxWindowTokens !== undefined &&
    maxWindowTokens > windowTokens &&
    neededTokens <= maxWindowTokens * CONTEXT_FIT_RATIO
  ) {
    return 'expand'
  }
  return 'compact'
}
