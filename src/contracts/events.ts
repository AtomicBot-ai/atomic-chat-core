/**
 * Event catalog. Every event the core emits is listed here with its payload. The app's
 * `CoreEventBridge` maps these onto the legacy `@janhq/core` names (PLAN.md §3.5).
 * Adding an event = add it here + add the relay mapping in the app, in the same PR pair.
 */

import type { LocalProviderId, RuntimeDeviceInfo, SessionInfo } from './session.js'

export type DownloadKind = 'model' | 'backend' | 'draft' | 'cudart'

export interface CoreEvents {
  'download:started': { taskId: string; modelId?: string; kind: DownloadKind }
  'download:progress': {
    taskId: string
    modelId?: string
    transferred: number
    total: number
    percent: number
  }
  'download:error': { taskId: string; modelId?: string; error: string }
  'download:stopped': { taskId: string; modelId?: string }
  'download:verified': { taskId: string; modelId?: string }

  'model:validation-started': { modelId: string }
  'model:validation-failed': { modelId: string; error: string }
  'model:imported': { provider: LocalProviderId; modelId: string; modelPath: string; mmprojPath?: string }

  'backend:download-started': { provider: LocalProviderId; backend: string; version: string }
  'backend:download-finished': {
    provider: LocalProviderId
    backend: string
    version?: string
    success: boolean
    error?: string
  }
  'backend:manual-downloading': { provider: LocalProviderId; selection: string }
  'backend:manual-failed': { provider: LocalProviderId; selection: string; error: string }
  'backend:better-detected': {
    provider: LocalProviderId
    currentBackend: string
    recommendedBackend: string
    recommendedCategory: string
    version: string
    backendId: string
  }
  'backend:runtime-reported': {
    provider: LocalProviderId
    modelId: string
    configuredVersionBackend: string
    effectiveVersionBackend: string
    runtimeDevice: RuntimeDeviceInfo | null
    mismatch: boolean
  }
  'backend:optimal-changed': {
    provider: LocalProviderId
    revision: number
    optimal: unknown | null
  }

  'settings:changed': { provider: LocalProviderId | 'server' | 'cloud'; key: string; value: unknown }

  'session:started': SessionInfo & { provider: LocalProviderId }
  'session:died': {
    provider: LocalProviderId
    pid: number
    model_id: string
    exit_code: number | null
    signal: string | null
    message: string
  }
  'session:ctx-increased': {
    provider: LocalProviderId
    modelId: string
    oldCtx: number
    newCtx: number
    reason: string
  }
  'session:unloaded': { provider: LocalProviderId; model_id: string; pid: number }

  'server:started': { host: string; port: number }
  'server:stopped': Record<string, never>
  'server:bind-failed': { port: number; error: string }

  'api:request': {
    id: string
    phase: 'started' | 'finished'
    endpoint: string
    model: string
    backend: string
    status?: number
    ttft_ms?: number
    duration_ms?: number
  }

  'core:log': { level: 'debug' | 'info' | 'warn' | 'error'; msg: string }
}

export type CoreEventName = keyof CoreEvents

/** One serialised event record as it crosses the process boundary (SSE and stdout NDJSON). */
export interface CoreEventRecord<K extends CoreEventName = CoreEventName> {
  seq: number
  ts: number
  name: K
  payload: CoreEvents[K]
}
