/**
 * How many tokens a chat request takes in its session, counted by the engine when it can.
 *
 * Ported from: web-app/src/lib/model-factory.ts (`countLocalPromptTokens`: `/apply-template` with the
 * tool schemas, then `/tokenize` on the session port) for llama.cpp. A session that declares the chat
 * `/tokenize` (vLLM, SGLang, the GenieX and LiteRT-LM hosts) answers `{count}` for the same body.
 * Every other engine, and any count that fails, gets the text estimate scaled by what the session
 * taught {@link PromptCalibration}. Media parts are counted apart: a template or tokenizer that only
 * sees text would refuse them or count their URLs.
 */

import type { ChatTokenizeRequest, ContextChatMessage } from '../../contracts/index.js'
import { UNCALIBRATED_MARGIN } from './calibration.js'
import type { PromptCalibration } from './calibration.js'
import { countMethod, sessionHeaders } from './engine.js'
import type { CompactionTarget } from './engine.js'
import { MEDIA_PART_TOKENS, estimatePromptTokens, mediaPartCount, textOnlyMessages } from './estimate.js'

/** Each call of a count is bounded; a busy engine still answers these without a slot. */
export const COUNT_TIMEOUT_MS = 5000

export interface CountRequest {
  messages: readonly ContextChatMessage[]
  tools?: readonly unknown[] | undefined
  chat_template_kwargs?: Record<string, unknown> | undefined
}

export interface PromptCount {
  tokens: number
  /** Counted by the engine's tokenizer, media aside; `false` for an estimate. */
  exact: boolean
}

export interface CountDeps {
  fetch?: typeof fetch
  calibration?: PromptCalibration
  timeoutMs?: number
  signal?: AbortSignal
}

async function postJson(
  target: CompactionTarget,
  path: string,
  body: unknown,
  deps: CountDeps
): Promise<unknown> {
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? COUNT_TIMEOUT_MS)
  const response = await (deps.fetch ?? fetch)(`http://127.0.0.1:${target.port}${path}`, {
    method: 'POST',
    headers: sessionHeaders(target),
    body: JSON.stringify(body),
    signal: deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout,
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`${path} answered ${response.status}`)
  }
  return response.json()
}

/** llama.cpp: the prompt its template renders, tokenized by its own vocabulary. */
async function llamaCppCount(
  target: CompactionTarget,
  request: CountRequest,
  deps: CountDeps
): Promise<number | undefined> {
  const applied = (await postJson(
    target,
    '/apply-template',
    {
      messages: textOnlyMessages(request.messages),
      ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
      ...(request.chat_template_kwargs ? { chat_template_kwargs: request.chat_template_kwargs } : {}),
    },
    deps
  )) as { prompt?: unknown }
  if (typeof applied?.prompt !== 'string') return undefined
  const tokenized = (await postJson(target, '/tokenize', { content: applied.prompt }, deps)) as {
    tokens?: unknown
  }
  return Array.isArray(tokenized?.tokens) ? tokenized.tokens.length : undefined
}

/** A session that declares `POST /tokenize`: the chat body in, `{count}` out. */
async function chatTokenizeCount(
  target: CompactionTarget,
  request: CountRequest,
  deps: CountDeps
): Promise<number | undefined> {
  const body: ChatTokenizeRequest = {
    model: target.modelId,
    messages: textOnlyMessages(request.messages),
    ...(request.tools && request.tools.length > 0 ? { tools: [...request.tools] } : {}),
    add_generation_prompt: true,
  }
  const answer = (await postJson(target, '/tokenize', body, deps)) as { count?: unknown }
  const count = answer?.count
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : undefined
}

/** The prompt `request` makes in `target`'s session; never throws (a failed count is an estimate). */
export async function countPromptTokens(
  target: CompactionTarget,
  request: CountRequest,
  deps: CountDeps = {}
): Promise<PromptCount> {
  const method = countMethod(target)
  if (method !== 'estimate') {
    const media = request.messages.reduce((sum, message) => sum + mediaPartCount(message), 0)
    try {
      const counted =
        method === 'llamacpp'
          ? await llamaCppCount(target, request, deps)
          : await chatTokenizeCount(target, request, deps)
      if (counted !== undefined) return { tokens: counted + media * MEDIA_PART_TOKENS, exact: media === 0 }
    } catch {
      // Not counted (a template without tool support, an engine still starting): estimated below.
    }
  }
  const estimate = estimatePromptTokens(request)
  return {
    tokens: deps.calibration
      ? deps.calibration.scale(target, estimate)
      : Math.ceil(estimate * UNCALIBRATED_MARGIN),
    exact: false,
  }
}
