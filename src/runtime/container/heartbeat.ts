/**
 * Touches the heartbeat file the watchdog entrypoint (`watchdog.ts`) polls, on a fixed interval,
 * for as long as the managed session lifecycle (task 2.12, which owns this ticker's lifecycle) keeps
 * it running. This file being written from the host, and the watchdog inside the container reading
 * its mtime, is the whole mechanism the "Watchdog гарантирует освобождение GPU" requirement relies
 * on to notice a dead core: no update within the stale limit means the core stopped ticking,
 * whatever the reason (crash, kill, a slept host).
 *
 * Timer, filesystem and clock are all injected so tests run instantly under fake timers. `onError`
 * is required, not optional: a write failure here is a silent gap in the one signal the watchdog
 * trusts, and swallowing it by default is exactly the kind of thing that only gets noticed once the
 * GPU is stuck — the caller must say what happens to it, even if that is just logging. A failed
 * write never throws out of a tick either way; it is retried on the next tick, not treated as fatal
 * to the ticker itself. A dead engine is the watchdog's problem to notice via the *absence* of
 * heartbeats, not this ticker's problem to detect directly.
 *
 * `ready` always settles: it resolves on the first successful write, or rejects if `stop()` is
 * called before that ever happens (findings-2.9-r2 item 5 — a ticker whose writes keep failing, or
 * that is stopped before its first attempt lands, used to leave a caller `await`ing `ready` hanging
 * forever). It can still take arbitrarily long to settle if the ticker is neither stopped nor ever
 * manages a successful write, so a caller awaiting it should race it against its own timeout rather
 * than await it unconditionally.
 */

import { writeFile } from 'node:fs/promises'
import { DEFAULT_HEARTBEAT_INTERVAL_SECS } from './watchdog.js'

/** The slice of `node:fs/promises` the ticker needs; tests pass an in-memory fake. */
export interface HeartbeatFs {
  writeFile(path: string, data: string): Promise<void>
}

const NODE_FS: HeartbeatFs = { writeFile }

export interface HeartbeatTickerOptions {
  /** Path to the heartbeat file. The lifecycle owns its location; this module never derives one. */
  path: string
  /** Defaults to `DEFAULT_HEARTBEAT_INTERVAL_SECS` (see watchdog.ts for why it is a placeholder). */
  intervalMs?: number
  fs?: HeartbeatFs
  /** Clock used for the heartbeat's own content (an epoch-millis string); defaults to `Date.now`. */
  now?: () => number
  setIntervalFn?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void
  /** Called instead of throwing when a tick's write fails; the ticker keeps running either way. */
  onError: (error: unknown) => void
}

export interface HeartbeatTicker {
  /** Resolves on the first successful write; rejects if `stop()` is called before that happens. */
  ready: Promise<void>
  stop(): void
}

/** Starts ticking immediately (the first write is issued before this returns) and every `intervalMs` after. */
export function startHeartbeatTicker(options: HeartbeatTickerOptions): HeartbeatTicker {
  const fs = options.fs ?? NODE_FS
  const now = options.now ?? Date.now
  const intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_SECS * 1000
  const setIntervalFn = options.setIntervalFn ?? setInterval
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval

  let inFlight = false
  let readySettled = false
  let resolveReady!: () => void
  let rejectReady!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  // A caller that never touches `ready` (most callers just want the ticker running) must not turn a
  // stop-before-success into an unhandled rejection; a caller that does await/catch it separately
  // still observes the same rejection, since a promise can have more than one listener.
  ready.catch(() => {})

  // A tick that fires while the previous write is still pending is skipped outright rather than
  // queued: the ticker's only job is to keep the mtime moving, and a queue of stale writes racing
  // a slow filesystem would just reorder themselves for no benefit, or pile up behind it.
  const tick = (): void => {
    if (inFlight) return
    inFlight = true
    fs.writeFile(options.path, String(now()))
      .then(() => {
        if (!readySettled) {
          readySettled = true
          resolveReady()
        }
      })
      .catch((error: unknown) => options.onError(error))
      .finally(() => {
        inFlight = false
      })
  }

  tick()
  const handle = setIntervalFn(tick, intervalMs)

  return {
    ready,
    stop(): void {
      clearIntervalFn(handle)
      if (!readySettled) {
        readySettled = true
        rejectReady(new Error('Heartbeat ticker stopped before its first write succeeded.'))
      }
    },
  }
}
