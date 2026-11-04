/**
 * What the hosts' own OpenAI servers share (openspec change `add-geniex-runtime`, task 5.4; lifted
 * from `litert-lm/host/openai.ts` and `server.ts` without a change of behaviour): the OpenAI error
 * shape, the fields of a chat completions request that mean the same for every engine — sampling,
 * limits, stop strings, usage, the response format, thinking, the tool choice — the SSE frames of a
 * streamed answer, the non-stream reply and the body plumbing of `node:http`. Each host keeps to
 * itself what its library makes of the messages.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export interface OpenAiErrorBody {
  error: { message: string; type: string; param: string | null; code: string | null }
}

/** A request this server answers with an OpenAI-shaped error instead of a completion. */
export class OpenAiRequestError extends Error {
  readonly body: OpenAiErrorBody
  constructor(
    readonly status: number,
    message: string,
    param: string | null = null,
    type = status >= 500 ? 'server_error' : 'invalid_request_error',
    code: string | null = null
  ) {
    super(message)
    this.name = 'OpenAiRequestError'
    this.body = { error: { message, type, param, code } }
  }
}

export const invalidRequest = (message: string, param: string | null = null): OpenAiRequestError =>
  new OpenAiRequestError(400, message, param)

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export interface ModelCaps {
  /** The model takes image input. */
  vision: boolean
  /** Think unless the request says not to (`model.yml` `reasoning`). */
  reasoning: boolean
}

/** The sampling a request names; absent fields keep the engine's defaults. */
export interface SamplingRequest {
  temperature?: number
  topP?: number
  topK?: number
  seed?: number
}

export type ResponseFormat = { kind: 'json_schema' | 'regex'; value: string } | null

/** The request fields every host reads alike. */
export interface CommonChatRequest {
  stream: boolean
  includeUsage: boolean
  sampler: SamplingRequest
  maxTokens?: number
  stop: string[]
  responseFormat: ResponseFormat
  thinking: boolean
  /** `null` with no tools or `tool_choice: "none"`. */
  tools: unknown[] | null
}

export const DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/i

/** The text of a `content` that may be a string or text parts; anything else is a 400. */
export function textOf(content: unknown, param: string): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) throw invalidRequest(`${param} must be a string or an array of parts`, param)
  return content
    .map((part) => {
      if (isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string') return part['text']
      throw invalidRequest(`${param} may hold text parts only`, param)
    })
    .join('')
}

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw invalidRequest(`${key} must be a number`, key)
  return value
}

export function parseResponseFormat(raw: unknown): ResponseFormat {
  if (raw === undefined || raw === null) return null
  if (!isRecord(raw)) throw invalidRequest('response_format must be an object', 'response_format')
  if (raw['type'] === 'text') return null
  if (raw['type'] === 'json_object') return { kind: 'json_schema', value: '{"type":"object"}' }
  if (raw['type'] === 'json_schema') {
    const schema = isRecord(raw['json_schema']) ? raw['json_schema']['schema'] : undefined
    if (!isRecord(schema))
      throw invalidRequest('response_format.json_schema.schema must be a JSON schema', 'response_format')
    return { kind: 'json_schema', value: JSON.stringify(schema) }
  }
  throw invalidRequest(
    `response_format type ${JSON.stringify(raw['type'])} is not supported`,
    'response_format'
  )
}

export function parseThinking(body: Record<string, unknown>, caps: ModelCaps): boolean {
  const kwargs = body['chat_template_kwargs']
  if (isRecord(kwargs) && typeof kwargs['enable_thinking'] === 'boolean') return kwargs['enable_thinking']
  const effort = body['reasoning_effort']
  if (typeof effort === 'string') return effort !== 'none'
  return caps.reasoning
}

/**
 * The common fields of a chat completions body, or `OpenAiRequestError` (400) naming the field it
 * cannot serve: `n` other than 1, a named or `required` tool choice, a response format no engine
 * speaks, a sampling value that is not a number. `messages` is only checked to be a non-empty
 * array: what they mean is each host's.
 */
export function parseCommonChatRequest(raw: Record<string, unknown>, caps: ModelCaps): CommonChatRequest {
  const n = raw['n']
  if (n !== undefined && n !== null && n !== 1) throw invalidRequest('Only n: 1 is supported.', 'n')
  if (!Array.isArray(raw['messages']) || raw['messages'].length === 0)
    throw invalidRequest('messages must be a non-empty array', 'messages')
  const toolChoice = raw['tool_choice']
  if (toolChoice !== undefined && toolChoice !== null && toolChoice !== 'auto' && toolChoice !== 'none')
    throw invalidRequest('Only tool_choice "auto" and "none" are supported.', 'tool_choice')
  const tools =
    Array.isArray(raw['tools']) && raw['tools'].length > 0 && toolChoice !== 'none' ? raw['tools'] : null
  const streamOptions = raw['stream_options']
  const stop = raw['stop']
  const maxTokens = optionalNumber(raw, 'max_completion_tokens') ?? optionalNumber(raw, 'max_tokens')
  const temperature = optionalNumber(raw, 'temperature')
  const topP = optionalNumber(raw, 'top_p')
  const topK = optionalNumber(raw, 'top_k')
  const seed = optionalNumber(raw, 'seed')
  return {
    stream: raw['stream'] === true,
    includeUsage: isRecord(streamOptions) && streamOptions['include_usage'] === true,
    sampler: {
      ...(temperature !== undefined ? { temperature } : {}),
      ...(topP !== undefined ? { topP } : {}),
      ...(topK !== undefined ? { topK: Math.round(topK) } : {}),
      ...(seed !== undefined ? { seed: Math.round(seed) } : {}),
    },
    ...(maxTokens !== undefined ? { maxTokens: Math.max(1, Math.round(maxTokens)) } : {}),
    stop:
      typeof stop === 'string'
        ? [stop]
        : Array.isArray(stop)
          ? stop.filter((s) => typeof s === 'string' && s)
          : [],
    responseFormat: parseResponseFormat(raw['response_format']),
    thinking: parseThinking(raw, caps),
    tools,
  }
}

/** One OpenAI delta (`choices[0].delta`) without the role. */
export type Delta =
  | { content: string }
  | { reasoning_content: string }
  | {
      tool_calls: Array<{
        index: number
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }

export type FinishReason = 'stop' | 'length' | 'tool_calls'

export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

/** The frames of one streamed completion, all under its id. */
export interface SseFramer {
  /** `data: {…chunk…}\n\n` with the given body merged in. */
  frame(body: Record<string, unknown>): string
  delta(delta: Record<string, unknown>, finish?: FinishReason | null): string
  readonly id: string
  readonly created: number
}

export function sseFramer(id: string, created: number, model: string): SseFramer {
  const frame = (body: Record<string, unknown>) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, ...body })}\n\n`
  return {
    id,
    created,
    frame,
    delta: (delta, finish = null) => frame({ choices: [{ index: 0, delta, finish_reason: finish }] }),
  }
}

/** The `[DONE]` sentinel. */
export const SSE_DONE = 'data: [DONE]\n\n'

/** A non-stream `chat.completion` body. */
export function completionBody(
  framer: Pick<SseFramer, 'id' | 'created'>,
  model: string,
  message: Record<string, unknown>,
  finish: FinishReason | null,
  usage: Usage
): Record<string, unknown> {
  return {
    id: framer.id,
    object: 'chat.completion',
    created: framer.created,
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage,
  }
}

/** Images arrive inline as base64. */
export const BODY_LIMIT = 64 * 1024 * 1024

export class BodyTooLarge extends Error {}

export function readBody(req: IncomingMessage, limit = BODY_LIMIT): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new BodyTooLarge())
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

export const sendOpenAiError = (res: ServerResponse, error: OpenAiRequestError): void =>
  sendJson(res, error.status, error.body)

/** The JSON body of a chat request, or the 400 / 413 it earns. */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse(await readBody(req)) as unknown
  } catch (error) {
    throw error instanceof BodyTooLarge
      ? new OpenAiRequestError(413, 'The request body is too large.')
      : new OpenAiRequestError(400, 'The request body is not valid JSON.')
  }
}

/** A `404` for a route the host does not serve. */
export const notServed = (method: string, path: string, engine: string): OpenAiRequestError =>
  new OpenAiRequestError(
    404,
    `${method} ${path} is not served by ${engine}.`,
    null,
    'invalid_request_error',
    'not_found'
  )
