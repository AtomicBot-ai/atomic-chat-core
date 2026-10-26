/**
 * When an app-owned core retires itself. An app that crashes cannot detach, so once its client
 * registration has expired (`CLIENT_EXPIRY_MS`, three missed heartbeats) the app owner unloads its
 * models and releases its lock (ADR 2026-09-17-isolate-app-and-cli-owners). An expired registration
 * is only evidence that the app is gone, though, and two things make it false evidence (ADR
 * 2026-10-26-an-app-core-does-not-retire-while-it-works):
 *  - the core itself was not running: a machine swapping an image model, or asleep, runs neither
 *    the heartbeats waiting in the socket nor this check, and when it resumes the check comes first;
 *  - the core is in the middle of work a retirement would throw away (an image job, a model load).
 * The first is measured here as the lateness of the check and handed back to every lease; the second
 * postpones the retirement until the work is over. An app that really crashed still loses its core,
 * only later; an app that is back registers again and the question never comes up.
 *
 * Pure: the clock, the clients and the work come in, the decision goes out. `create.ts` runs it.
 */

import type { GpuOccupant } from './gpu/index.js'

/** How often the app owner looks at its clients. */
export const APP_LEASE_CHECK_MS = 5_000

export interface AppLeaseCheck {
  /** Registered clients, after expiry. */
  clients: number
  /** Whether any client has ever registered with this core. */
  everRegistered: boolean
  now: number
  /** Until when a core nobody has registered with yet waits for its app. */
  startupDeadline: number
  /** Work a retirement would throw away, said for the log; empty when idle (`workInProgress`). */
  work: readonly string[]
}

export type AppLeaseDecision =
  /** A client is attached, or the app that started this core has not had time to register. */
  | { action: 'keep' }
  /** Nobody is attached and nothing is running: unload, release the lock, exit. */
  | { action: 'retire' }
  /** Nobody is attached, but retiring now would throw `work` away: look again at the next check. */
  | { action: 'wait'; work: readonly string[] }

export function appLeaseDecision(check: AppLeaseCheck): AppLeaseDecision {
  if (check.clients > 0) return { action: 'keep' }
  if (!check.everRegistered && check.now <= check.startupDeadline) return { action: 'keep' }
  if (check.work.length > 0) return { action: 'wait', work: check.work }
  return { action: 'retire' }
}

/**
 * How long this process was not running between two checks, beyond the interval it asked for: the
 * time no client could have reached it. Zero for a check on time, or for a clock that went back.
 */
export function stalledMs(previousCheckAt: number, now: number, intervalMs = APP_LEASE_CHECK_MS): number {
  return Math.max(0, now - previousCheckAt - intervalMs)
}

/**
 * The work a retirement would throw away, from what every engine reports it holds: a session that
 * says it is busy (an image or video job), and a model being loaded. Embedding and transcription
 * sessions are not work worth keeping a core alive for; a loaded model that answers chat is not
 * either, since nothing tells an idle one from a busy one without a proxy in front of every request.
 */
export function workInProgress(occupants: readonly GpuOccupant[]): string[] {
  const work: string[] = []
  for (const occupant of occupants) {
    if (occupant.busy !== undefined) work.push(occupant.busy)
    else if (occupant.state === 'loading' && !occupant.auxiliary)
      work.push(`${occupant.provider}/${occupant.model_id} is loading`)
  }
  return work
}
