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

/** `GET /atomic/v1/telemetry`: the app's error-reporting consent as the core holds it. Never the DSN. */
export interface TelemetryState {
  enabled: boolean
  /** Consent is given and this build has a project to report to. */
  reporting: boolean
  has_user: boolean
  tags: Record<string, string>
}

/**
 * `PUT /atomic/v1/telemetry`: what the app's `set_telemetry_*` commands learned. An omitted field
 * keeps its value; `user_id: null` forgets the user; `tags` replaces the whole set (allow-listed).
 */
export interface TelemetryUpdateRequest {
  enabled?: boolean
  user_id?: string | null
  tags?: Record<string, string>
}
