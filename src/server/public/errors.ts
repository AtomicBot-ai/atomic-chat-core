/**
 * Reading upstream failures: is this a context overflow, a poisoned compute backend, an OOM — and
 * what the client is told in each case.
 *
 * Ported from: src-tauri/src/core/server/proxy.rs (`is_compute_backend_error`,
 * `compute_error_envelope`, `structure_backend_error_body`, `is_context_overflow_finish_length_json`,
 * `body_indicates_oom`), src-tauri/src/core/server/context_expansion.rs (`is_context_limit_error`).
 *
 * The wording of every message is part of the contract: the app's UI and external agents match on
 * it to decide whether to offer a larger context or a smaller model.
 */

import { CONTEXT_LENGTH_EXCEEDED } from '../../contracts/index.js'
import { DEFAULT_N_PREDICT } from '../../runtime/llamacpp/generation-limits.js'
import { isJsonObject, serdeToString } from '../shims/index.js'
import type { JsonValue } from '../shims/index.js'

/**
 * How llama.cpp says a prompt does not fit (upstream, TurboQuant and Prism alike): a 400 with
 * `request (N tokens) exceeds the available context size (M tokens), try increasing it` and this
 * error type, which it also sends for `input (N tokens) is larger than the max context size`.
 * Pinned by the engine contract (test/fixtures/llamacpp/engine-contract.json).
 */
const LLAMA_CONTEXT_OVERFLOW = /request \(\d+ tokens\) exceeds the available context size/i
export const LLAMA_CONTEXT_OVERFLOW_TYPE = 'exceed_context_size_error'

/** A specific engine refusal suitable for excluding an oversized prompt from error reporting. */
export function isLlamaContextOverflow(body: string): boolean {
  return LLAMA_CONTEXT_OVERFLOW.test(body) || errorTypeOf(body) === LLAMA_CONTEXT_OVERFLOW_TYPE
}

type Sizes = { prompt: number; window: number }
const int = (match: RegExpExecArray, group: number) => Math.round(Number(match[group] ?? 0))
const NUM = '(\\d+(?:\\.\\d+)?)'

/**
 * Overflow wordings that state both sizes, read as the request's tokens and the window's. Each is an
 * engine's own message or the OpenAI body a managed engine's adapter maps it to, so a body is read the
 * same whether or not the session gateway mapped it first.
 */
const OVERFLOW_SIZES: readonly { pattern: RegExp; sizes: (match: RegExpExecArray) => Sizes }[] = [
  // llama.cpp (upstream, TurboQuant, Prism): the engine contract's two wordings.
  {
    pattern: /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/i,
    sizes: (m) => ({ prompt: int(m, 1), window: int(m, 2) }),
  },
  {
    pattern: /input \((\d+) tokens\) is larger than the max context size \((\d+) tokens\)/i,
    sizes: (m) => ({ prompt: int(m, 1), window: int(m, 2) }),
  },
  // vLLM, current and older (`runtime/vllm/adapter.ts`).
  {
    pattern: /maximum context length is (\d+) tokens\. However, your request has (\d+) input tokens/i,
    sizes: (m) => ({ prompt: int(m, 2), window: int(m, 1) }),
  },
  {
    pattern: /maximum context length is (\d+) tokens\. However, you requested (\d+) tokens/i,
    sizes: (m) => ({ prompt: int(m, 2), window: int(m, 1) }),
  },
  // A `max_tokens` the room left cannot hold: the request is the input and that output.
  {
    pattern:
      /(?:is too large: (\d+)\. This model's )?maximum context length is (\d+) tokens and your request has (\d+) input tokens/i,
    sizes: (m) => ({ prompt: int(m, 3) + int(m, 1), window: int(m, 2) }),
  },
  // OpenAI's own wording, which the TensorRT-LLM adapter maps to.
  {
    pattern: /maximum context length is (\d+) tokens\. However, your messages resulted in (\d+) tokens/i,
    sizes: (m) => ({ prompt: int(m, 2), window: int(m, 1) }),
  },
  // What the vLLM and SGLang adapters map to.
  {
    pattern: /maximum context length is (\d+) tokens, but the request has (\d+) tokens/i,
    sizes: (m) => ({ prompt: int(m, 2), window: int(m, 1) }),
  },
  // SGLang `managers/tokenizer_manager.py` (`runtime/sglang/adapter.ts`).
  {
    pattern: /The input \((\d+) tokens\) is longer than the model's context length \((\d+) tokens\)/i,
    sizes: (m) => ({ prompt: int(m, 1), window: int(m, 2) }),
  },
  {
    pattern: /maximum context length of (\d+) tokens\. You requested a total of (\d+) tokens/i,
    sizes: (m) => ({ prompt: int(m, 2), window: int(m, 1) }),
  },
  // TensorRT-LLM 1.2.1 and 1.3.0rc29 `_check_arguments` (`runtime/tensorrt-llm/adapter.ts`).
  {
    pattern: new RegExp(
      `sum of prompt length \\(${NUM}\\), query length \\(${NUM}\\) should not exceed max_num_tokens \\(${NUM}\\)`,
      'i'
    ),
    sizes: (m) => ({ prompt: int(m, 1) + int(m, 2), window: int(m, 3) }),
  },
  {
    pattern: new RegExp(`The prompt length \\(${NUM}\\) should not exceed max_num_tokens \\(${NUM}\\)`, 'i'),
    sizes: (m) => ({ prompt: int(m, 1), window: int(m, 2) }),
  },
  // FastFlowLM at the pinned f37cdd29 (`AutoModel::_shared_validate_capacity`): a 400 `model_error`.
  {
    pattern:
      /Request exceeds the (\d+)-token limit of backend '[^']*': rendered prompt has (\d+) tokens(?: and requested output has (\d+) tokens)?/i,
    sizes: (m) => ({ prompt: int(m, 2) + int(m, 3), window: int(m, 1) }),
  },
]

/**
 * Overflow wordings that state no sizes. FastFlowLM at the pinned f37cdd29 answers a prompt its window
 * cannot hold with a 400 `{"error":{"message":"Max length reached!","type":"model_error","code":400}}`
 * (`rest_handler.cpp`, after `insert` refuses it in `AutoModel::_shared_insert`).
 */
const OVERFLOW_WORDS: readonly RegExp[] = [/^max length reached!?$/i]

/** Statuses an engine answers a context overflow with. */
const OVERFLOW_STATUSES: readonly number[] = [400, 413, 500, 503]

/**
 * How sure a body is a context overflow: `known` — an engine's own wording, llama.cpp's error type or
 * a `context_length_exceeded` code; `strong` — shared words that say something ran over (MLX's KV
 * cache, "context … exceeded"); `weak` — "context" with a size, a length or a limit, which a failure
 * to set the context up says too (`failed to initialize context size`).
 */
function overflowEvidence(status: number, body: string): 'known' | 'strong' | 'weak' | undefined {
  if (!OVERFLOW_STATUSES.includes(status)) return undefined
  if (isLlamaContextOverflow(body) || errorCodeOf(body) === CONTEXT_LENGTH_EXCEEDED) return 'known'
  const message = errorMessageOf(body)
  if (OVERFLOW_WORDS.some((words) => words.test(message.trim()))) return 'known'
  if (OVERFLOW_SIZES.some(({ pattern }) => pattern.test(message) || pattern.test(body))) return 'known'
  const b = body.toLowerCase()
  // Older builds' wording.
  if (b.includes('the request exceeds the available context size')) return 'strong'
  if (b.includes('max_kv_size') || b.includes('max-kv-size') || b.includes('max kv size')) return 'strong'
  if (b.includes('kv cache') && (b.includes('exceed') || b.includes('overflow') || b.includes('too')))
    return 'strong'
  if (!b.includes('context')) return undefined
  if (['exceed', 'overflow', 'too long', 'too large'].some((w) => b.includes(w))) return 'strong'
  return ['size', 'length', 'limit'].some((w) => b.includes(w)) ? 'weak' : undefined
}

/**
 * A request that no longer fits the loaded context window: llama.cpp's and MLX's words, every routed
 * engine's own overflow wording, and a body some layer already mapped to `context_length_exceeded`.
 */
export function isContextLimitError(status: number, body: string): boolean {
  return overflowEvidence(status, body) !== undefined
}

/**
 * A context overflow worth telling the client as one: any known wording; the shared words in a body
 * that does not also say the engine ran out of memory, the weak ones only on a client error (a `5xx`
 * that names the context's size is as likely a failure to set it up).
 */
function isReportableOverflow(status: number, body: string): boolean {
  const evidence = overflowEvidence(status, body)
  if (evidence === 'known') return true
  if (evidence === undefined || bodyIndicatesOom(body)) return false
  return evidence === 'strong' || status < 500
}

export function bodyIndicatesOom(body: string): boolean {
  const b = body.toLowerCase()
  return [
    'out of memory',
    'outofmemory',
    'cuda_error_out_of_memory',
    'failed to allocate',
    'insufficient memory',
    'erroroutofdevicememory',
  ].some((p) => b.includes(p))
}

/**
 * A fatal compute failure that leaves the ggml backend unusable until it is recreated (a Metal OOM
 * during prompt processing answers 500 "Compute error" and every later request fails the same way).
 */
export function isComputeBackendError(status: number, body: string): boolean {
  if (status !== 500) return false
  const b = body.toLowerCase()
  return [
    'compute error',
    'failed to decode',
    'failed to compute graph',
    'backend is in error state',
    'ggml_backend_sched_graph_compute',
  ].some((p) => b.includes(p))
}

/** The OpenAI error envelope; `param` names the request field at fault, when there is one. */
export function structuredErrorJson(message: string, type: string, code: string, param?: string): string {
  return serdeToString({
    error: param === undefined ? { message, type, code } : { message, type, param, code },
  })
}

/**
 * A model nothing serves: OpenAI's `model_not_found` envelope. The message keeps the proxy's wording,
 * which the app's agent client matches (in `error.message`) to tell a missing session from other failures.
 */
export function modelNotFoundJson(modelId: string): string {
  return structuredErrorJson(
    `No running session found for model '${modelId}'`,
    'invalid_request_error',
    'model_not_found',
    'model'
  )
}

/**
 * The 503 for a model id the app selected a local engine to serve while no local engine has a session
 * of it. It names the model and the selected engine; the request never goes to a remote provider that
 * lists the same id. The message opens with the not-found wording the app's agent client matches.
 */
export function selectedProviderUnavailableJson(modelId: string, provider: string): string {
  return structuredErrorJson(
    `No running session found for model '${modelId}' in any local engine. It is selected to be served ` +
      `by ${provider} in Atomic Chat, so it is not sent to a remote provider. Load the model, or select ` +
      'another provider for it on the Local API Server page.',
    'server_error',
    'selected_provider_unavailable',
    'model'
  )
}

/**
 * The 400 for a chat request whose `messages` is an empty array, in OpenAI's own wording; `undefined`
 * for any other body. A local engine would otherwise answer an empty conversation with a completion
 * of its own.
 */
export function emptyMessagesRefusal(json: JsonValue): string | undefined {
  const messages = isJsonObject(json) ? json['messages'] : undefined
  if (!Array.isArray(messages) || messages.length > 0) return undefined
  return structuredErrorJson(
    "Invalid 'messages': empty array. Expected an array with minimum length 1, but got an empty array instead.",
    'invalid_request_error',
    'empty_array',
    'messages'
  )
}

export function computeErrorEnvelope(oom: boolean): string {
  const message = oom
    ? 'The model ran out of memory while processing this request. Try a smaller or lighter model, reduce the context size, or remove attached images. On Apple Silicon, memory is shared with the system, so closing other memory-heavy apps can free up headroom.'
    : 'The model failed during computation — most often because it ran out of memory. Try a smaller or lighter model, reduce the context size, or remove attached images. On Apple Silicon, memory is shared with the system, so closing other memory-heavy apps can free up headroom.'
  return structuredErrorJson(message, 'server_error', 'insufficient_memory')
}

function parseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue
  } catch {
    return undefined
  }
}

/** `error.type` of an OpenAI-style error envelope, if the body is one. */
function errorTypeOf(body: string): string | undefined {
  const parsed = parseJson(body)
  const error = isJsonObject(parsed) ? parsed['error'] : undefined
  const type = isJsonObject(error) ? error['type'] : undefined
  return typeof type === 'string' ? type : undefined
}

/** `error.code`, or a top-level `code`, when it is a string. */
function errorCodeOf(body: string): string | undefined {
  const parsed = parseJson(body)
  if (!isJsonObject(parsed)) return undefined
  const error = parsed['error']
  const code = isJsonObject(error) ? error['code'] : parsed['code']
  return typeof code === 'string' ? code : undefined
}

/**
 * The message of an error body: `error.message` (OpenAI), a top-level `message` (vLLM's and
 * trtllm-serve's `ErrorResponse`, FastFlowLM's error string), or the body itself.
 */
function errorMessageOf(body: string): string {
  const parsed = parseJson(body)
  if (!isJsonObject(parsed)) return body
  const error = parsed['error']
  if (isJsonObject(error) && typeof error['message'] === 'string') return error['message']
  if (typeof parsed['message'] === 'string') return parsed['message']
  return body
}

/**
 * The request's tokens and the window of a context overflow, from llama.cpp's size fields or from
 * any wording that states both; `undefined` when the body says neither.
 */
export function contextOverflowSizes(body: string): Sizes | undefined {
  const parsed = parseJson(body)
  const error = isJsonObject(parsed) ? parsed['error'] : undefined
  if (isJsonObject(error)) {
    const prompt = asU64(error['n_prompt_tokens'])
    const window = asU64(error['n_ctx'])
    if (prompt !== undefined && window !== undefined && window > 0) return { prompt, window }
  }
  const message = errorMessageOf(body)
  for (const { pattern, sizes } of OVERFLOW_SIZES) {
    const match = pattern.exec(message) ?? pattern.exec(body)
    if (match === null) continue
    const found = sizes(match)
    if (found.window > 0) return found
  }
  return undefined
}

/**
 * Any engine's context overflow as the Anthropic API words one: a 400 `invalid_request_error` whose
 * message is `prompt is too long: N tokens > M maximum`, or `prompt is too long` and the reason when
 * the body states no sizes. Claude Code matches that wording to compact the conversation and retry;
 * any other text it shows as a failed turn. Reads llama.cpp's shape, a body already mapped to
 * `context_length_exceeded` (a managed engine's adapter, a host's own 400), every engine wording of
 * `OVERFLOW_SIZES`/`OVERFLOW_WORDS`, and the shared words of `isContextLimitError` as
 * `isReportableOverflow` weighs them; `undefined` for any other error.
 */
export function anthropicPromptTooLong(status: number, body: string): string | undefined {
  if (!isReportableOverflow(status, body)) return undefined
  const sizes = contextOverflowSizes(body)
  return serdeToString({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: sizes
        ? `prompt is too long: ${sizes.prompt} tokens > ${sizes.window} maximum`
        : "prompt is too long: the request does not fit the model's context window",
    },
  })
}

/**
 * A route policy's `mapError` for an engine that words its own overflow: the OpenAI
 * `context_length_exceeded` envelope (in OpenAI's own wording when the body states both sizes, with
 * the engine's message otherwise) for a body `anthropicPromptTooLong` would also report, `null` for
 * any other error, which the public server wraps as before.
 */
export function contextLengthExceededError(
  status: number,
  body: string
): { error: { message: string; type: string; param: string; code: string } } | null {
  if (!isReportableOverflow(status, body)) return null
  const sizes = contextOverflowSizes(body)
  return {
    error: {
      message: sizes
        ? `This model's maximum context length is ${sizes.window} tokens. However, your messages resulted ` +
          `in ${sizes.prompt} tokens. Please reduce the length of the messages.`
        : errorMessageOf(body),
      type: 'invalid_request_error',
      param: 'messages',
      code: CONTEXT_LENGTH_EXCEEDED,
    },
  }
}

function isStructuredErrorBody(body: string): boolean {
  const parsed = parseJson(body)
  return isJsonObject(parsed) && isJsonObject(parsed['error'])
}

/**
 * A local engine's error as the client receives it: an existing `{"error": {...}}` envelope passes
 * unchanged, anything else (plain stderr text, mlx-vlm's `{"detail": ...}`) is wrapped with a typed
 * `code`, keeping the original text as the message so the overflow and OOM matchers still see it.
 */
export function structureBackendErrorBody(body: string, oom: boolean, ctxOverflow: boolean): string {
  if (isStructuredErrorBody(body)) return body
  const code = ctxOverflow ? 'context_length_exceeded' : oom ? 'insufficient_memory' : 'server_error'
  const type = ctxOverflow ? 'invalid_request_error' : 'server_error'
  return structuredErrorJson(body, type, code)
}

/** serde_json `as_u64`: non-negative integers only. */
function asU64(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

export function clientMaxTokens(requestBody: Buffer): number | undefined {
  const json = parseJson(requestBody.toString('utf8'))
  if (!isJsonObject(json)) return undefined
  for (const key of ['max_tokens', 'max_completion_tokens']) {
    const v = asU64(json[key])
    if (v !== undefined && v > 0) return v
  }
  return undefined
}

/**
 * A 200 whose `finish_reason` is `length` because the context window ran out rather than because
 * an output cap was reached. The cap is the client's `max_tokens` or, without one, the engine's own:
 * core starts llama.cpp with `--n-predict` (DEFAULT_N_PREDICT unless the user set another,
 * `engineCap`), so a `length` with no client cap is no longer always the window. Either way only a
 * stop clearly short of the cap counts. An unknown token count is taken as client-driven under a
 * client cap, so a `max_tokens: 16` health check never grows the context, and as the window under
 * the engine's alone, as before. `engineCap` `null` (an engine started without a cap) keeps the
 * old rule: with no client cap, `length` can only mean the window.
 */
export function isContextOverflowFinishLength(
  response: JsonValue,
  requestBody: Buffer,
  engineCap: number | null = DEFAULT_N_PREDICT
): boolean {
  const choices = isJsonObject(response) ? response['choices'] : undefined
  const hasLength =
    Array.isArray(choices) && choices.some((c) => isJsonObject(c) && c['finish_reason'] === 'length')
  if (!hasLength) return false
  const clientCap = clientMaxTokens(requestBody)
  const cap = clientCap ?? engineCap
  if (cap === null) return true
  const usage = isJsonObject(response) ? response['usage'] : undefined
  const done = asU64(isJsonObject(usage) ? usage['completion_tokens'] : undefined)
  // Without a count, only the client's own cap is a known reason; the engine's is not proven.
  if (done === undefined) return clientCap === undefined
  return done + 1 < cap
}
