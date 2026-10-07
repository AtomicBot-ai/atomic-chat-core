/**
 * The request and response rules every managed engine's session gateway applies the same way (change
 * `add-vllm-runtime`): what counts as asking for tools or for structured output (the same rule `:1337`
 * applies, `server/public/policy.ts`), whether a chat request turned thinking on, and moving a
 * no-thinking reply a reasoning parser filed as reasoning back into `content`. The adapters decide
 * when to apply them; the rules themselves live here once.
 */

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
