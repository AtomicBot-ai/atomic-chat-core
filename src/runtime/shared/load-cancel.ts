/**
 * Cancelling a model load before its engine reports ready.
 *
 * A load only becomes a session — something `unload` can find — once the server says it is ready,
 * which can be minutes for a large model over a cold page cache. Until then the child belongs to the
 * load alone, so "stop this model" had nothing to act on.
 *
 * Ported from the app's `src-tauri/utils/src/load_cancel.rs` (image-generation line, `767ff6350`),
 * with one deliberate difference. The Rust registry replaced a model's token on every new load. In
 * the core, acquires of one model are serialized, so the newest registration is always a queued
 * follower and a cancel aimed at it would miss the load that is actually spawning. Here every
 * pending load of a key shares one entry, and a fresh one starts only after an abort — which keeps
 * the Rust guarantees: a finished load never unregisters a newer one, and a new load never inherits
 * an earlier cancel (ADR 2026-09-17-cancel-a-model-load-through-a-shared-registry).
 */

import { AtomicCoreError } from '../../contracts/index.js'

/** The app's wording, verbatim: its UI treats this code as a user stop, not a failure. */
export const MODEL_LOAD_CANCELLED_MESSAGE = 'The model load was cancelled.'

export function loadCancelledError(): AtomicCoreError {
  return new AtomicCoreError('MODEL_LOAD_CANCELLED', MODEL_LOAD_CANCELLED_MESSAGE)
}

/** Whether the load was cancelled. A caller with no way to cancel (the CLI, a reload) never is. */
export function isLoadCancelled(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

export function throwIfLoadCancelled(signal?: AbortSignal): void {
  if (isLoadCancelled(signal)) throw loadCancelledError()
}

/**
 * Settle with `work`, or reject with `MODEL_LOAD_CANCELLED` as soon as `signal` aborts — the
 * `select!` arm of the Rust loads. The abandoned work keeps running; its outcome is swallowed so a
 * later rejection is not an unhandled one.
 */
export function raceLoadCancel<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  if (signal.aborted) {
    work.catch(() => {})
    return Promise.reject(loadCancelledError())
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      work.catch(() => {})
      reject(loadCancelledError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

/** A pending load's hold on its key: the signal to watch, and the release that ends the hold. */
export interface LoadCancelHandle {
  signal: AbortSignal
  /** Idempotent. The entry goes once its last holder releases, unless a newer one replaced it. */
  release: () => void
}

interface LoadCancelEntry {
  controller: AbortController
  holders: number
}

export class LoadCancelRegistry {
  private readonly loads = new Map<string, LoadCancelEntry>()

  /**
   * Hold `key` for one pending load. Loads waiting on the same key share an entry, so one cancel
   * reaches whichever of them is running; an entry that was already cancelled is replaced rather
   * than joined, so the new load starts clean.
   */
  register(key: string): LoadCancelHandle {
    let entry = this.loads.get(key)
    if (!entry || entry.controller.signal.aborted) {
      entry = { controller: new AbortController(), holders: 0 }
      this.loads.set(key, entry)
    }
    entry.holders++
    const held = entry
    let released = false
    return {
      signal: held.controller.signal,
      release: () => {
        if (released) return
        released = true
        held.holders--
        // A newer load of the same key may have registered meanwhile; its entry is not ours to remove.
        if (held.holders === 0 && this.loads.get(key) === held) this.loads.delete(key)
      },
    }
  }

  /** Cancel the loads pending for `key`. `false` means nothing is in flight there. */
  cancel(key: string): boolean {
    const entry = this.loads.get(key)
    if (!entry) return false
    entry.controller.abort()
    return true
  }
}
