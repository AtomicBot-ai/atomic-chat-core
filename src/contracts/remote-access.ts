/**
 * Remote access: the status of the Cloudflare quick tunnel in front of the Local API Server.
 *
 * camelCase on the wire, verbatim from the app (`web-app/src/types/remoteAccess.ts`, and the Rust
 * `RemoteAccessStatus` of `src-tauri/src/core/server/remote_access/mod.rs` on the image-generation
 * line), because the settings page renders this payload as it arrives.
 *
 * PRIVACY: the tunnel URL identifies the user's machine. It lives in memory only and is never
 * logged or persisted; it is new on every start anyway.
 */

export type RemoteAccessState = 'off' | 'starting' | 'online' | 'stopping' | 'error'

/** Machine-readable failure codes; the frontend owns the wording. */
export type RemoteAccessFailure =
  /** The bundled binary is missing or could not be started. */
  | 'cloudflared_unavailable'
  /** cloudflared never printed a tunnel URL (no route to Cloudflare's API). */
  | 'no_url'
  /** A URL was minted but no edge connection registered, on either transport. */
  | 'not_registered'
  /** The tunnel registered, but its URL never answered as this server. */
  | 'not_reachable'
  /** A tunnel that was online ended by itself. */
  | 'exited'
  /** The process could not be confirmed dead. Only Stop is offered until it is. */
  | 'stop_failed'

/** A tunnel needs something to point at. */
export type RemoteAccessBlockReason = 'server_stopped'

export interface RemoteAccessStatus {
  state: RemoteAccessState
  /** Origin only (`https://<words>.trycloudflare.com`), and only while online. */
  url: string | null
  error: RemoteAccessFailure | null
  blockReason: RemoteAccessBlockReason | null
  canStart: boolean
  canStop: boolean
  /**
   * Whether the *running* server was started with an API key. The frontend compares it with the
   * key in its settings to offer "restart to apply".
   */
  serverHasApiKey: boolean
}

/** Why a start was refused; travels as `details` of the 409, which is what the app's parser reads. */
export type RemoteAccessRefusal = 'server_stopped' | 'operation_in_progress' | 'stop_failed'
