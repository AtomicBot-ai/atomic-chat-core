/**
 * When to bring a crashed decision process back, and when to stop trying. Pure.
 *
 * Only a process that was ready and then died is restarted. A start that fails (a bad model file, an
 * engine that refuses the spec) fails the same way the next time, so it goes straight to `failed`
 * and waits for the user: a new setting or an explicit load.
 */

export const RESTART_BASE_DELAY_MS = 1_000
export const RESTART_MAX_DELAY_MS = 30_000
/**
 * Restarts in a row the module attempts. The crash after the last of them (the sixth in a row) gives
 * up and reports `failed`, with `restarts: MAX_RESTARTS + 1`.
 */
export const MAX_RESTARTS = 5
/** A process that stayed up this long wipes the crash count: the next crash is a first one again. */
export const STABLE_RUN_MS = 60_000

/** 1 s, 2 s, 4 s, … capped at 30 s, for the `attempt`-th restart (1-based). */
export function restartDelayMs(
  attempt: number,
  base = RESTART_BASE_DELAY_MS,
  max = RESTART_MAX_DELAY_MS
): number {
  const n = Math.max(1, Math.floor(attempt))
  return Math.min(max, base * 2 ** Math.min(n - 1, 30))
}

/**
 * The crash count after one more crash: reset first when the process had run long enough to count
 * as healthy.
 */
export function nextRestartCount(previous: number, ranForMs: number, stableMs = STABLE_RUN_MS): number {
  return (ranForMs >= stableMs ? 0 : previous) + 1
}

/** Whether the `restarts`-th crash in a row is one too many: `restarts > max`. */
export function shouldGiveUp(restarts: number, max = MAX_RESTARTS): boolean {
  return restarts > max
}
