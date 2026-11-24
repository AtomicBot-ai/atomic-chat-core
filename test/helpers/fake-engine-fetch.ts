/**
 * An injected `fetch` that answers like a local engine, for the history compaction tests
 * (`src/server/compaction/`): routes by path, records every call, and counts words as tokens so a
 * test can reason about sizes. Nothing listens on a port.
 *
 * - `/apply-template` (llama.cpp): the prompt is the messages' text joined by spaces;
 * - `/tokenize`: llama.cpp's `{content}` answers `{tokens}`, a chat body answers `{count}` (vLLM);
 * - `/v1/chat/completions`: a summary request (its prompt holds `<conversation>`) answers `summary`.
 */

export interface FakeEngineCall {
  path: string
  body: Record<string, unknown>
  authorization: string | undefined
}

export type FakeReply = { status?: number; json?: unknown; text?: string } | 'throw'

export interface FakeEngineOptions {
  /** The summary a summary request answers; a function sees the prompt and the call number. */
  summary?: string | ((prompt: string, call: number) => string)
  /** Replace the answer of a path entirely. */
  replies?: Record<string, (body: Record<string, unknown>) => FakeReply | Promise<FakeReply>>
}

/** Words in `text`: the fake's whole tokenizer. */
export function wordCount(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content.map((p) => (typeof p?.text === 'string' ? (p.text as string) : '')).join(' ')
  return ''
}

/** The prompt a chat body renders to in the fake: its messages' text, space-joined. */
export function renderedPrompt(body: Record<string, unknown>): string {
  const messages = Array.isArray(body['messages']) ? (body['messages'] as unknown[]) : []
  return messages.map(textOf).join(' ')
}

export function fakeEngineFetch(options: FakeEngineOptions = {}): {
  fetch: typeof fetch
  calls: FakeEngineCall[]
  summaryPrompts: string[]
} {
  const calls: FakeEngineCall[] = []
  const summaryPrompts: string[] = []
  const answer = (reply: FakeReply): Response => {
    if (reply === 'throw') throw new TypeError('fetch failed')
    const body = reply.text ?? JSON.stringify(reply.json ?? {})
    return new Response(body, {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    const headers = new Headers(init?.headers)
    calls.push({ path: url.pathname, body, authorization: headers.get('authorization') ?? undefined })
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const custom = options.replies?.[url.pathname]
    if (custom) return answer(await custom(body))
    if (url.pathname === '/apply-template') return answer({ json: { prompt: renderedPrompt(body) } })
    if (url.pathname === '/tokenize') {
      if (typeof body['content'] === 'string') {
        return answer({ json: { tokens: Array.from({ length: wordCount(body['content']) }, (_, i) => i) } })
      }
      return answer({ json: { count: wordCount(renderedPrompt(body)), max_model_len: 4096 } })
    }
    if (url.pathname === '/v1/chat/completions') {
      const prompt = renderedPrompt(body)
      if (prompt.includes('<conversation>')) {
        summaryPrompts.push(prompt)
        const summary =
          typeof options.summary === 'function'
            ? options.summary(prompt, summaryPrompts.length)
            : (options.summary ?? `summary ${summaryPrompts.length}`)
        return answer({
          json: { choices: [{ message: { role: 'assistant', content: summary }, finish_reason: 'stop' }] },
        })
      }
      return answer({ json: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } })
    }
    return answer({ status: 404, json: { error: { message: `no route ${url.pathname}` } } })
  }) as typeof fetch
  return { fetch: fetchImpl, calls, summaryPrompts }
}

/** `n` words of filler, distinct per `seed` so messages differ. */
export function words(n: number, seed = 'w'): string {
  return Array.from({ length: n }, (_, i) => `${seed}${i}`).join(' ')
}
