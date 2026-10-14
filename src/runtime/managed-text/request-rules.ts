/**
 * The request and response rules every managed engine's session gateway applies the same way (change
 * `add-vllm-runtime`): what counts as asking for tools or for structured output (the same rule `:1337`
 * applies, `server/public/policy.ts`), whether a chat request turned thinking on, and moving a
 * no-thinking reply a reasoning parser filed as reasoning back into `content`, what counts as media in
 * a message, and capping the output a request asks for. The adapters decide when to apply them; the
 * rules themselves live here once.
 */
import { AtomicCoreError } from '../../contracts/index.js'

/** A non-empty `tools` list, or a `tool_choice` other than `"none"`. */
export function asksForTools(body: Record<string, unknown>): boolean {
  const tools = body['tools']
  const choice = body['tool_choice']
  return (
    (Array.isArray(tools) && tools.length > 0) ||
    (choice !== undefined && choice !== null && choice !== 'none')
  )
}

/** `response_format` asking for constrained output: anything but `{"type": "text"}`. */
export function asksForStructuredOutput(body: Record<string, unknown>): boolean {
  const format = body['response_format']
  if (format === null || typeof format !== 'object' || Array.isArray(format)) return false
  return (format as { type?: unknown }).type !== 'text'
}

/** Any message part that is not text: an image, a video, audio — none of which a managed engine accepts. */
const MEDIA_PART = new Set([
  'image_url',
  'input_image',
  'image',
  'video_url',
  'video',
  'input_audio',
  'audio_url',
])

/** A chat message carrying an image, a video or audio. */
export function carriesMedia(body: Record<string, unknown>): boolean {
  const messages = body['messages']
  if (!Array.isArray(messages)) return false
  return messages.some((message) => {
    const content =
      message !== null && typeof message === 'object' ? (message as { content?: unknown }).content : null
    return (
      Array.isArray(content) &&
      content.some(
        (part) =>
          part !== null &&
          typeof part === 'object' &&
          MEDIA_PART.has(String((part as { type?: unknown }).type))
      )
    )
  })
}

function positive(body: Record<string, unknown>, key: string): { present: boolean; value: number } {
  if (!(key in body) || body[key] === null) return { present: false, value: 0 }
  const value = body[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new AtomicCoreError('INVALID_ARGUMENT', `${key} must be a positive integer.`)
  }
  return { present: true, value }
}

/**
 * The output a request asks for, capped at `cap` (one key, as the client sent it: `max_tokens` on
 * completions, `max_tokens` or `max_completion_tokens` on chat). A request that asks for none is left
 * as it is: an engine that refuses input + cap over the context caps it through its own launch
 * default, within the room left. `INVALID_ARGUMENT` for a value that is not a positive integer.
 */
export function capRequestedOutput(
  route: string,
  client: Record<string, unknown>,
  cap: number
): Record<string, unknown> {
  if (route === '/v1/completions') {
    const field = positive(client, 'max_tokens')
    return field.present ? { ...client, max_tokens: Math.min(field.value, cap) } : client
  }
  const legacy = positive(client, 'max_tokens')
  const modern = positive(client, 'max_completion_tokens')
  const asked = [legacy, modern].filter((field) => field.present).map((field) => field.value)
  if (asked.length === 0) return client
  const rest: Record<string, unknown> = { ...client }
  delete rest['max_tokens']
  delete rest['max_completion_tokens']
  rest[modern.present ? 'max_completion_tokens' : 'max_tokens'] = Math.min(cap, ...asked)
  return rest
}

/** Whether a chat request turned thinking on (`chat_template_kwargs.enable_thinking`, or top level). */
export function thinkingRequested(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false
  const record = body as Record<string, unknown>
  const kwargs = record['chat_template_kwargs']
  if (
    kwargs !== null &&
    typeof kwargs === 'object' &&
    (kwargs as Record<string, unknown>)['enable_thinking'] === true
  )
    return true
  return record['enable_thinking'] === true
}

/**
 * Moves reasoning into `content` on every choice's `message` and stream `delta` — both spellings an
 * engine uses (`reasoning_content`, `reasoning`) — leaving the reasoning field `null`.
 */
export function reasoningIntoContent(json: Record<string, unknown>): Record<string, unknown> {
  const choices = json['choices']
  if (!Array.isArray(choices)) return json
  for (const choice of choices) {
    if (choice === null || typeof choice !== 'object') continue
    for (const key of ['message', 'delta']) {
      const part = (choice as Record<string, unknown>)[key]
      if (part === null || typeof part !== 'object') continue
      const record = part as Record<string, unknown>
      for (const field of ['reasoning_content', 'reasoning']) {
        const reasoning = record[field]
        if (typeof reasoning !== 'string' || reasoning === '') continue
        const content = typeof record['content'] === 'string' ? (record['content'] as string) : ''
        record['content'] = content + reasoning
        record[field] = null
      }
    }
  }
  return json
}
