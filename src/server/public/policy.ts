/**
 * The checks the public server makes before it forwards a request to a session whose engine declares
 * its routes (`LocalTarget.policy`; `tensorrt-llm`, spec `tensorrt-llm-runtime`): a route the session
 * does not serve, tool calls to a model with no tool-call parser, or JSON output to a family without
 * structured output, is answered here with an
 * OpenAI-shaped `400` that says what is missing — never forwarded, and never silently degraded
 * ("Публичный сервер MUST отвечать понятной ошибкой на маршрут, который провайдер не объявил"; "запрос
 * с `tools` к этой модели получает ошибку о неподдерживаемой возможности, а не молча игнорируется").
 */
import { isJsonObject } from '../shims/index.js'
import type { JsonValue } from '../shims/index.js'
import { structuredErrorJson } from './errors.js'
import type { LocalTargetPolicy } from './types.js'

/**
 * The engine route each public path needs, and how an error names it. `/messages` needs chat
 * completions: the forwarder translates an Anthropic request into one when the engine has no
 * `/v1/messages` of its own.
 */
const NEEDS: Record<string, { route: string; what: string }> = {
  '/chat/completions': { route: '/v1/chat/completions', what: 'chat completions' },
  '/completions': { route: '/v1/completions', what: 'text completions' },
  '/embeddings': { route: '/v1/embeddings', what: 'embeddings' },
  '/messages': { route: '/v1/chat/completions', what: 'the Anthropic Messages API' },
  '/messages/count_tokens': { route: '/v1/messages/count_tokens', what: 'token counting' },
  '/responses': { route: '/v1/responses', what: 'the Responses API' },
}

export interface PolicyRefusal {
  status: number
  /** A serialized OpenAI error envelope. */
  body: string
}

function refusal(message: string, code: string): PolicyRefusal {
  return { status: 400, body: structuredErrorJson(message, 'invalid_request_error', code) }
}

/** Why this POST must not reach the session, or `undefined` when it may. */
export function policyRefusal(
  policy: LocalTargetPolicy,
  path: string,
  modelId: string,
  json: JsonValue
): PolicyRefusal | undefined {
  const needed = NEEDS[path]
  const declared =
    needed !== undefined && policy.routes.some((r) => r.method === 'POST' && r.path === needed.route)
  if (!declared) {
    const what = needed?.what ?? path
    return refusal(`The model '${modelId}' does not support ${what}.`, 'unsupported_endpoint')
  }
  if (!isJsonObject(json)) return undefined
  if (!policy.tools && asksForTools(json)) {
    return refusal(`The model '${modelId}' does not support tool calling.`, 'unsupported_capability')
  }
  if (!policy.structuredOutput && asksForStructuredOutput(json)) {
    return refusal(`The model '${modelId}' does not support structured output.`, 'unsupported_capability')
  }
  return undefined
}

/**
 * A non-empty `tools` list, or a `tool_choice` other than `"none"` — the same rule the session
 * gateway's own rewriter applies (`runtime/tensorrt-llm/adapter.ts`), so both ports agree.
 */
function asksForTools(json: { [key: string]: JsonValue }): boolean {
  const tools = json['tools']
  const choice = json['tool_choice']
  return (
    (Array.isArray(tools) && tools.length > 0) ||
    (choice !== undefined && choice !== null && choice !== 'none')
  )
}

/** `response_format` asking for JSON: a schema or any object. `{"type": "text"}` asks for nothing. */
function asksForStructuredOutput(json: { [key: string]: JsonValue }): boolean {
  const format = json['response_format']
  if (!isJsonObject(format)) return false
  return format['type'] === 'json_schema' || format['type'] === 'json_object'
}
