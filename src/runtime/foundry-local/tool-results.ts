type Message = Record<string, unknown>

interface ToolTurn {
  end: number
  calls: Set<string>
  results: Map<string, number>
}

const MISSING_RESULT = 'No tool result was provided for this call in the conversation history.'

function record(value: unknown): Message | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Message) : undefined
}

/** Foundry joins consecutive assistant messages unless they name different speakers. */
function assistantTurn(messages: readonly unknown[], start: number): ToolTurn | undefined {
  let name: unknown
  const calls = new Set<string>()
  let end = start
  for (; end < messages.length; end++) {
    const message = record(messages[end])
    if (message?.['role'] !== 'assistant') break
    const speaker = message['name']
    if (name && speaker && name !== speaker) break
    name ||= speaker

    const toolCalls = message['tool_calls']
    if (!Array.isArray(toolCalls)) continue
    for (const call of toolCalls) {
      const id = record(call)?.['id']
      if (typeof id !== 'string' || id === '' || calls.has(id)) return undefined
      calls.add(id)
    }
  }
  return { end, calls, results: new Map() }
}

/** Associate every result with a unique, previously issued call before moving anything. */
function collectToolTurns(messages: readonly unknown[]): ToolTurn[] | undefined {
  const turns: ToolTurn[] = []
  const owners = new Map<string, ToolTurn>()
  for (let index = 0; index < messages.length; index++) {
    const message = record(messages[index])
    if (message?.['role'] === 'assistant') {
      const turn = assistantTurn(messages, index)
      if (!turn) return undefined
      index = turn.end - 1
      if (turn.calls.size === 0) continue
      for (const id of turn.calls) {
        if (owners.has(id)) return undefined
        owners.set(id, turn)
      }
      turns.push(turn)
    } else if (message?.['role'] === 'tool') {
      const id = message['tool_call_id']
      if (typeof id !== 'string') return undefined
      const turn = owners.get(id)
      if (!turn || turn.results.has(id)) return undefined
      turn.results.set(id, index)
    }
  }
  return turns
}

function needsProjection(turn: ToolTurn, messages: readonly unknown[]): boolean {
  if (turn.calls.size < 2) return false
  const { end, results, calls } = turn
  if (record(messages[end + results.size])?.['role'] === 'tool') return true
  if (results.size === 0) return false
  return (
    results.size !== calls.size || [...results.values()].some((position, offset) => position !== end + offset)
  )
}

function losesAssistantBoundary(turn: ToolTurn, messages: readonly unknown[]): boolean {
  let next = turn.end
  while (record(messages[next])?.['role'] === 'tool') next++
  return next > turn.end && record(messages[next])?.['role'] === 'assistant'
}

/**
 * Foundry's positional templates need each parallel result beside its issuing turn. If a history
 * needs repair, rebuild its result groups by call ID, retaining the order of non-tool messages.
 */
export function groupFoundryToolResults(messages: readonly unknown[]): readonly unknown[] {
  const turns = collectToolTurns(messages)
  if (!turns?.some((turn) => needsProjection(turn, messages))) return messages

  const groups = new Map<number, unknown[]>()
  for (const turn of turns) {
    // Moving a foreign result can remove the only boundary between two assistant turns. Close an
    // unanswered turn explicitly in that case, so Foundry does not merge it with a later call.
    if (turn.results.size === 0 && !losesAssistantBoundary(turn, messages)) continue
    const results = [...turn.results.values()].map((position) => messages[position])
    for (const id of turn.calls) {
      if (!turn.results.has(id)) results.push({ role: 'tool', tool_call_id: id, content: MISSING_RESULT })
    }
    groups.set(turn.end, results)
  }

  const grouped: unknown[] = []
  for (let index = 0; index <= messages.length; index++) {
    for (const result of groups.get(index) ?? []) grouped.push(result)
    if (index < messages.length && record(messages[index])?.['role'] !== 'tool') grouped.push(messages[index])
  }
  return grouped
}
