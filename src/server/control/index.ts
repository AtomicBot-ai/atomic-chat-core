/**
 * The control API (`/atomic/v1/*`, PLAN.md §3.6): how the app and the CLI drive a core they did not
 * start. It is deliberately not the inference API — it binds loopback only, always requires the
 * control token, refuses non-loopback `Host` headers (the DNS-rebinding guard that lets a browser
 * page talk to a local port), and sends no CORS headers at all.
 *
 * Stopping the public listener never touches this one: that separation is what keeps a core
 * manageable while its `/v1` surface is down.
 */

export { ControlServer } from './server.js'
export { SSE_HEARTBEAT_MS } from './types.js'
export type {
  BackendControl,
  ChatGptControl,
  CloudControl,
  ControlServerDeps,
  ControlSnapshot,
  DiffusionControl,
  DiskControl,
  ExternalSessionControl,
  ModelControl,
  PublicServerControl,
  RemoteAccessControl,
  SessionSummary,
  SettingsControl,
} from './types.js'
