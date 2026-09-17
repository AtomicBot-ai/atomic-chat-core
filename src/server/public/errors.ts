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

import { isJsonObject, serdeToString } from '../shims/index.js'
import type { JsonValue } from '../shims/index.js'

/** A request that no longer fits the loaded context window, as llama.cpp and MLX word it. */
export function isContextLimitError(status: number, body: string): boolean {
  if (![400, 413, 500, 503].includes(status)) return false
  const b = body.toLowerCase()
  if (b.includes('the request exceeds the available context size')) return true
  if (b.includes('max_kv_size') || b.includes('max-kv-size') || b.includes('max kv size')) return true
  if (b.includes('kv cache') && (b.includes('exceed') || b.includes('overflow') || b.includes('too')))
    return true
  return (
    b.includes('context') &&
    ['size', 'length', 'limit', 'exceed', 'overflow', 'too long', 'too large'].some((w) => b.includes(w))
  )
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

export function structuredErrorJson(message: string, type: string, code: string): string {
  return serdeToString({ error: { message, type, code } })
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
 * the client capped the output. With no client cap, `length` can only mean the window. With a cap,
 * only a stop clearly short of it counts; an unknown token count is taken as client-driven, so a
 * `max_tokens: 16` health check never grows the context.
 */
export function isContextOverflowFinishLength(response: JsonValue, requestBody: Buffer): boolean {
  const choices = isJsonObject(response) ? response['choices'] : undefined
  const hasLength =
    Array.isArray(choices) && choices.some((c) => isJsonObject(c) && c['finish_reason'] === 'length')
  if (!hasLength) return false
  const cap = clientMaxTokens(requestBody)
  if (cap === undefined) return true
  const usage = isJsonObject(response) ? response['usage'] : undefined
  const done = asU64(isJsonObject(usage) ? usage['completion_tokens'] : undefined)
  return done !== undefined && done + 1 < cap
}
