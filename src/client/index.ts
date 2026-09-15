/**
 * Browser-safe client of the control API (`/atomic/v1`). Used by the CLI when it attaches to a
 * running owner, and later by the app's extension adapter through an injected transport.
 * fetch-only; no `node:*` here.
 */
export { CONTROL_API_PREFIX, CONTROL_PROTOCOL_VERSION } from '../contracts/index.js'
export * from './control-client.js'
