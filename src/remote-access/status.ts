/**
 * What the tunnel's state machine knows, and what the frontend is told about it. Pure.
 *
 * Ported from: src-tauri/src/core/server/remote_access/mod.rs (`Phase`, `derive_status`) on the
 * image-generation line (`767ff6350`).
 */

import type { RemoteAccessFailure, RemoteAccessStatus } from '../contracts/index.js'

export type Phase =
  | { kind: 'off' }
  | { kind: 'starting' }
  | { kind: 'online' }
  | { kind: 'stopping' }
  | { kind: 'failed'; error: RemoteAccessFailure }

export const OFF: Phase = { kind: 'off' }
export const failed = (error: RemoteAccessFailure): Phase => ({ kind: 'failed', error })

export interface TunnelSnapshot {
  phase: Phase
  url: string | undefined
}

/** The running public server as the tunnel needs it; `undefined` while it is stopped. */
export interface ServerEndpoint {
  /** Where cloudflared dials: the bound port, and a host that actually listens (see `dialOrigin`). */
  origin: string
  hasApiKey: boolean
}

export function deriveStatus(
  snapshot: TunnelSnapshot,
  server: ServerEndpoint | undefined
): RemoteAccessStatus {
  const phase = snapshot.phase
  const state = phase.kind === 'failed' ? 'error' : phase.kind
  const error = phase.kind === 'failed' ? phase.error : null
  const blockReason = server === undefined ? 'server_stopped' : null
  // A process that may still be alive must be dealt with before another one is started next to it.
  const stopFailed = error === 'stop_failed'
  const idle = state === 'off' || state === 'error'
  return {
    state,
    url: state === 'online' ? (snapshot.url ?? null) : null,
    error,
    blockReason,
    canStart: blockReason === null && idle && !stopFailed,
    canStop: state === 'starting' || state === 'online' || stopFailed,
    serverHasApiKey: server?.hasApiKey === true,
  }
}

/**
 * The origin a local client dials to reach a listener bound to `host`. A wildcard bind listens on
 * loopback too; a server bound to one specific address does not listen on loopback at all.
 */
export function dialOrigin(host: string, port: number): string {
  const bare = host.trim().replace(/^\[|\]$/g, '')
  if (bare === '' || bare === '0.0.0.0') return `http://127.0.0.1:${port}`
  if (bare === '::' || bare === '0:0:0:0:0:0:0:0') return `http://[::1]:${port}`
  return bare.includes(':') ? `http://[${bare}]:${port}` : `http://${bare}:${port}`
}

/** The host of a tunnel URL, or `undefined` for something that is not one. */
export function hostOf(url: string): string | undefined {
  try {
    const host = new URL(url).hostname
    return host === '' ? undefined : host
  } catch {
    return undefined
  }
}
