/**
 * Control API (`/atomic/v1/*`) shapes and the sidecar handshake. PLAN.md §3.6.
 */

import type { ErrorBody } from './errors.js'

export const CONTROL_API_PREFIX = '/atomic/v1'
export const CONTROL_PROTOCOL_VERSION = 1

/** First stdout line of `serve --sidecar`. */
export interface ReadyLine {
  event: 'core:ready'
  protocol: typeof CONTROL_PROTOCOL_VERSION
  version: string
  pid: number
  host: string
  port: number
  prefix: string
  control_port: number
}

export interface ControlErrorResponse {
  error: ErrorBody
}

export interface HealthResponse {
  ok: true
  pid: number
  version: string
  dataFolder: string
  uptime_ms: number
}

/** `<data>/local-api-server.json` — byte-identical with the app's state_file.rs; the API key is never written. */
export interface LocalApiServerState {
  running: boolean
  host: string
  port: number
  prefix: string
  requires_api_key: boolean
  pid: number | null
}

export const LOCAL_API_SERVER_STATE_FILE = 'local-api-server.json'
