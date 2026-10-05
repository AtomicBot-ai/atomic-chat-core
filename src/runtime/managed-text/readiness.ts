/**
 * One readiness probe against a managed engine, through its internal `BackendTarget` (task 2.12).
 *
 * The probe never follows a redirect (task 2.7 review carry-forward): the target is the loopback
 * address core published and validated itself, while a `Location` header is whatever the process
 * behind that port chose to say — following it would let that process point core's own request at
 * another host. A redirect is therefore reported as its own outcome, and never counts as ready.
 */
import type { ManagedReadinessProbe } from './adapter.js'
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
