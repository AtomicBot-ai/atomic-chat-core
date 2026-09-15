/**
 * Browser-safe client of the control API (`/atomic/v1`). Used by the app's extension adapter and
 * by the CLI when it attaches to a running owner. fetch-only; no `node:*` here.
 *
 * Phase 3a fills this in: request helpers per control route, SSE subscription with `Last-Event-ID`
 * replay, `AtomicCoreError` rethrow from `{error:{code,message,details}}`.
 */
export { CONTROL_API_PREFIX, CONTROL_PROTOCOL_VERSION } from '../contracts/index.js'
