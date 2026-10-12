/**
 * One readiness probe against a managed engine, through its internal `BackendTarget` (task 2.12).
 *
 * The probe never follows a redirect (task 2.7 review carry-forward): the target is the loopback
 * address core published and validated itself, while a `Location` header is whatever the process
 * behind that port chose to say — following it would let that process point core's own request at
 * another host. A redirect is therefore reported as its own outcome, and never counts as ready.
 */
import type { ManagedGenerationProbe, ManagedReadinessProbe } from './adapter.js'
import type { BackendTarget } from './types.js'

export type ReadinessOutcome = 'ready' | 'not-ready' | 'redirect'

/** GET `<target><probe.path>` once, giving up after `timeoutMs`. A refused or hung connection is `not-ready`. */
export async function probeReadiness(
  fetchFn: typeof fetch,
  target: BackendTarget,
  probe: ManagedReadinessProbe,
  timeoutMs: number
): Promise<ReadinessOutcome> {
  const url = new URL(probe.path, target.base_url).toString()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchFn(url, { method: 'GET', redirect: 'manual', signal: controller.signal })
    // The body is never needed; dropping it frees the connection instead of leaving it half-read.
    await response.body?.cancel().catch(() => {})
    if (response.status >= 300 && response.status < 400) return 'redirect'
    // `redirect: 'manual'` in a browser-shaped fetch reports an opaque redirect as status 0.
    if (response.type === 'opaqueredirect') return 'redirect'
    return response.status === probe.expectedStatus ? 'ready' : 'not-ready'
  } catch {
    return 'not-ready'
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `ok`: the engine generated. `refused`: it answered the request with an error — proof it cannot
 * serve. `unanswered`: no answer in time, no model name to ask with, or no connection — not proof
 * either way, so a load is not refused on it.
 */
export type GenerationProbeOutcome =
  { kind: 'ok' } | { kind: 'refused'; status: number; body: string } | { kind: 'unanswered'; reason: string }

/** How much of a refused answer's body the outcome keeps. */
const REFUSED_BODY_MAX_CHARS = 2_000

/** The engine's own name for the model it serves: `data[0].id` of an OpenAI model list. */
function firstModelId(list: unknown): string | undefined {
  if (typeof list !== 'object' || list === null) return undefined
  const data = (list as { data?: unknown }).data
  if (!Array.isArray(data)) return undefined
  const id = (data[0] as { id?: unknown } | undefined)?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** An error object in a 2xx JSON body, the way an OpenAI-shaped server can report a failed request. */
function carriesError(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && 'error' in parsed
  } catch {
    return false
  }
}

/**
 * Asks the engine for its model's name, then for one generation (`ManagedGenerationProbe`), both
 * within `timeoutMs`, never following a redirect (file header).
 */
export async function probeGeneration(
  fetchFn: typeof fetch,
  target: BackendTarget,
  probe: ManagedGenerationProbe,
  timeoutMs: number
): Promise<GenerationProbeOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const models = await fetchFn(new URL(probe.modelsPath, target.base_url).toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    })
    const model = models.ok ? firstModelId(await models.json().catch(() => null)) : undefined
    if (!models.ok) await models.body?.cancel().catch(() => {})
    if (model === undefined) {
      return { kind: 'unanswered', reason: `${probe.modelsPath} named no model (HTTP ${models.status})` }
    }
    const response = await fetchFn(new URL(probe.path, target.base_url).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...probe.body, model }),
      redirect: 'manual',
      signal: controller.signal,
    })
    if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
      await response.body?.cancel().catch(() => {})
      return { kind: 'unanswered', reason: `${probe.path} answered a redirect` }
    }
    const text = await response.text()
    if (response.status >= 200 && response.status < 300 && !carriesError(text)) return { kind: 'ok' }
    return { kind: 'refused', status: response.status, body: text.slice(0, REFUSED_BODY_MAX_CHARS) }
  } catch (error) {
    return { kind: 'unanswered', reason: String(error) }
  } finally {
    clearTimeout(timer)
  }
}
