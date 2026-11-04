/**
 * The context window a local session serves: what `/models` advertises (`context_length`,
 * `meta.n_ctx`) so an agent can compact before it overflows, and what the request log keeps with each
 * request.
 *
 * A session that declares its limits (`LocalTarget.policy`) says so itself. llama.cpp says it in
 * `/props` (`default_generation_settings.n_ctx`, the window of one slot): under fit the core never
 * chose it, so nothing else knows it. `/props` is answered from the server's metadata without a slot,
 * so it is cheap even while a prompt is being processed, and it is read once per loaded session.
 * Any other engine has no window the server can learn: none is advertised rather than a guess.
 */

import type { LocalTarget, PublicServerDeps } from './types.js'
import { isLlamaCppServer } from './thinking.js'

const PROPS_TIMEOUT_MS = 2000
/** Sessions remembered at most; past it the cache starts over (every reload is a new session). */
const MAX_REMEMBERED = 64

/** The window in a llama.cpp `/props` body; `undefined` when it does not say. */
export function windowFromProps(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const props = body as { n_ctx?: unknown; default_generation_settings?: { n_ctx?: unknown } }
  for (const value of [props.default_generation_settings?.n_ctx, props.n_ctx]) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  }
  return undefined
}

/** What the core can learn of each session's window, asked once per session generation. */
export class SessionWindows {
  private readonly known = new Map<string, Promise<number | undefined>>()
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.fetchImpl = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? PROPS_TIMEOUT_MS
  }

  /** The window `target` serves; `undefined` when its engine does not say or cannot be asked. */
  of(target: LocalTarget): Promise<number | undefined> {
    if (!isLlamaCppServer(target.provider)) return Promise.resolve(undefined)
    // A reload gets a new generation (and port and key): the window it was loaded with may differ.
    const key = [target.provider, target.modelId, target.port, target.generation ?? '', target.apiKey].join(
      '\0'
    )
    const cached = this.known.get(key)
    if (cached) return cached
    if (this.known.size >= MAX_REMEMBERED) this.known.clear()
    const read = this.readProps(target)
    this.known.set(key, read)
    // An engine still starting, or one that did not answer, is asked again next time.
    void read.then((window) => {
      if (window === undefined && this.known.get(key) === read) this.known.delete(key)
    })
    return read
  }

  private async readProps(target: LocalTarget): Promise<number | undefined> {
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${target.port}/props`, {
        headers: target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {},
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!response.ok) return undefined
      return windowFromProps(await response.json())
    } catch {
      return undefined
    }
  }
}

/** The window a request to `target` runs with: the one it declares, else what the host can learn. */
export function sessionWindow(deps: PublicServerDeps, target: LocalTarget): Promise<number | undefined> {
  if (target.policy?.contextLength !== undefined) return Promise.resolve(target.policy.contextLength)
  return deps.contextWindow?.(target) ?? Promise.resolve(undefined)
}
