/**
 * Touches the heartbeat file the watchdog entrypoint (`watchdog.ts`) polls, on a fixed interval,
 * for as long as the managed session lifecycle (task 2.12, which owns this ticker's lifecycle) keeps
 * it running. This file being written from the host, and the watchdog inside the container reading
 * its mtime, is the whole mechanism the "Watchdog гарантирует освобождение GPU" requirement relies
 * on to notice a dead core: no update within the stale limit means the core stopped ticking,
 * whatever the reason (crash, kill, a slept host).
 *
 * Timer, filesystem and clock are all injected so tests run instantly under fake timers, and so a
 * transient write failure (the mount briefly unavailable, a full disk) never throws out of a tick —
 * it is reported through `onError` and retried on the next tick instead of tearing the ticker down.
 * A dead engine is the watchdog's problem to notice via the *absence* of heartbeats, not this
 * ticker's problem to detect directly.
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
  onError?: (error: unknown) => void
}

export interface HeartbeatTicker {
  stop(): void
}

/** Starts ticking immediately (the first write is issued before this returns) and every `intervalMs` after. */
export function startHeartbeatTicker(options: HeartbeatTickerOptions): HeartbeatTicker {
  const fs = options.fs ?? NODE_FS
  const now = options.now ?? Date.now
  const intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_SECS * 1000
  const setIntervalFn = options.setIntervalFn ?? setInterval
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval

  const tick = (): void => {
    fs.writeFile(options.path, String(now())).catch((error: unknown) => options.onError?.(error))
  }

  tick()
  const handle = setIntervalFn(tick, intervalMs)

  return {
    stop(): void {
      clearIntervalFn(handle)
    },
  }
}
