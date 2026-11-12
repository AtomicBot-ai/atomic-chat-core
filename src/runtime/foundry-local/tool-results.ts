function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function parallelCallIds(message: Record<string, unknown> | undefined): Set<string> | undefined {
  const calls = message?.['tool_calls']
  if (message?.['role'] !== 'assistant' || !Array.isArray(calls) || calls.length < 2) return undefined

  const ids = new Set<string>()
  for (const call of calls) {
    const id = record(call)?.['id']
    if (typeof id !== 'string' || id === '' || ids.has(id)) return undefined
    ids.add(id)
  }
  return ids
}

/**
 * Foundry's positional templates require every result immediately after its assistant turn.
 * A client can replay one user turn as several messages, with text between tool results.
 * Move the results ahead of that text only when every call in the turn has exactly one result.
 */
export function groupFoundryToolResults(messages: readonly unknown[]): readonly unknown[] {
  let grouped: unknown[] | undefined
  for (let i = 0; i < messages.length; i++) {
    const pending = parallelCallIds(record(messages[i]))
    if (!pending) continue

    const userMessages: unknown[] = []
    const results: unknown[] = []
    let resultAfterUser = false
    let end = i + 1
    for (; end < messages.length; end++) {
      const message = record(messages[end])
      if (message?.['role'] === 'user') {
        userMessages.push(message)
      } else if (message?.['role'] === 'tool') {
        const id = message['tool_call_id']
        if (typeof id !== 'string' || !pending.delete(id)) break
        results.push(message)
        if (userMessages.length > 0) resultAfterUser = true
      } else {
        break
      }
    }

    // Reject the candidate if it ended on a duplicate or unrelated result.
    if (record(messages[end])?.['role'] === 'tool' || pending.size > 0 || !resultAfterUser) continue
    grouped ??= [...messages]
    let target = i + 1
    for (const result of results) grouped[target++] = result
    for (const userMessage of userMessages) grouped[target++] = userMessage
    i = end - 1
  }
  return grouped ?? messages
}
