/**
 * A returned failure, for the places where failing is an ordinary outcome rather than an exception:
 * a state machine refusing an event, an admission policy saying the GPU is busy, an adapter
 * rejecting a model. Those callers branch on the answer, and a thrown error would either be caught
 * immediately or escape somewhere that cannot handle it.
 *
 * Code that fails because something is genuinely wrong still throws `AtomicCoreError`. The failure
 * carried here is the same `ErrorBody` shape, so either one serialises identically.
 */

import type { ErrorBody } from '../contracts/index.js'

export type Result<T> = { ok: true; value: T } | { ok: false; error: ErrorBody }

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })

export const err = <T = never>(code: ErrorBody['code'], message: string, details?: string): Result<T> => ({
  ok: false,
  error: details === undefined ? { code, message } : { code, message, details },
})
