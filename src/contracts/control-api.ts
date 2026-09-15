/**
 * Control API (`/atomic/v1/*`) shapes and the sidecar handshake. PLAN.md §3.6.
 */

import type { ErrorBody } from './errors.js'

export const CONTROL_API_PREFIX = '/atomic/v1'
export const CONTROL_PROTOCOL_VERSION = 1

/**
 * The core's first and only stdout line, printed by `daemon` once the control listener is bound
 * (PLAN.md §3.6). It describes *control* readiness only: the public `/v1` listener is separate and
 * its address comes from the snapshot, never from here.
 */
export interface ReadyLine {
  event: 'core:ready'
  pid: number
  instance_id: string
  protocol: typeof CONTROL_PROTOCOL_VERSION
  version: string
  control_host: string
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
