/**
 * One layer over the three ways the core installs engines (openspec change `unify-engine-lifecycle`,
 * spec `engine-lifecycle`, design D1, D2, D10): llama.cpp packs (`/backends`), sd.cpp and MLX builds
 * (`/engine-builds`) and the managed engines' environments (`/environments`). The same four commands
 * for every engine: what is installed and what is newer, update, make a build active, remove a build.
 *
 * The core still never installs on its own (ADR 2026-09-27): the versions answer only reads, and an
 * update runs when a client calls it. snake_case on the wire, like the routes underneath.
 *
 * Browser-safe: types and constant lists only.
 */

import type { ProxyConfig } from './backend-advisor.js'
import type { ErrorBody } from './errors.js'

/** Every engine the layer answers for, in the order the desktop lists them. */
export const ENGINE_IDS = [
  'llamacpp-upstream',
  'llamacpp',
  'atomic-prism',
  'sd-cpp',
  'mlx',
  'tensorrt-llm',
  'vllm',
] as const
export type EngineId = (typeof ENGINE_IDS)[number]

/** Which system underneath installs the engine. */
export type EngineKind = 'llamacpp' | 'engine-build' | 'managed'

/**
 * Who picks the build the next load runs: `client` — any installed build can be made active
 * (llama.cpp, `version_backend`); `core` — the core's own rule (sd.cpp and MLX: the newest; a
 * managed engine: its one installation).
 */
export type EngineActiveChoice = 'client' | 'core'

/**
 * `downloaded` — the core put it there; `bundled` — it came with the desktop installer and is never
 * removed; `managed` — a managed engine's installation.
 */
export type EngineOrigin = 'downloaded' | 'bundled' | 'managed'

export const ENGINE_NOT_REMOVABLE_REASONS = ['active', 'bundled', 'in-use'] as const
/** A build both active and in use reports `active`. */
export type EngineNotRemovableReason = (typeof ENGINE_NOT_REMOVABLE_REASONS)[number]

/**
 * What names a build in every command. `version` is the llama.cpp tag, the sd.cpp/MLX tag or the
 * managed `descriptor_id`; `variant` is the build for the hardware (`win-cuda12-x64`), for a managed
 * engine the image platform.
 */
export interface EngineBuildKey {
  version: string
  variant: string
}

export interface EngineBuild extends EngineBuildKey {
  origin: EngineOrigin
  active: boolean
  /** A session, the decision model or the embedding model runs from it right now. */
  in_use: boolean
  removable: boolean
  /** Present exactly when `removable` is `false`. */
  not_removable_reason?: EngineNotRemovableReason
}

/** A build the engine's source offers. */
export interface EngineAvailableBuild extends EngineBuildKey {
  /** Every archive or image layer the install would download, when the source says. */
  download_bytes?: number
  published_at?: string
}

export type EngineUpdateApply = 'swap' | 'reinstall'

export const ENGINE_UPDATE_BLOCKED_REASONS = [
  'family-change',
  'unstable',
  'requires-newer-app',
  'source-unavailable',
] as const
/** Why a newer build exists but is not offered; `needed` is then `false`. */
export type EngineUpdateBlockedReason = (typeof ENGINE_UPDATE_BLOCKED_REASONS)[number]

export interface EngineUpdateOffer {
  /** `true` only for a `target` strictly newer than the active build; never without an active build. */
  needed: boolean
  target: EngineAvailableBuild | null
  /** `swap` — installed beside, the engine's sessions unloaded; `reinstall` — removed and set up again. */
  apply: EngineUpdateApply
  blocked_reason?: EngineUpdateBlockedReason
}

/** `remote` — fetched this time; `cache` — what was accepted before; `null` — neither. */
export type EngineVersionsSource = 'remote' | 'cache' | null

/** One engine of this host. */
export interface EngineVersions {
  engine: EngineId
  kind: EngineKind
  active_choice: EngineActiveChoice
  builds: EngineBuild[]
  /** The build the next model load uses, or `null`. */
  active: EngineBuildKey | null
  /** The newest build for this host by the engine's source, or `null`. */
  latest: EngineAvailableBuild | null
  update: EngineUpdateOffer
  source: EngineVersionsSource
  /** Why the source was not read from the network this time (with `cache` or `null`); `null` otherwise. */
  source_error: string | null
  /** Set when this engine's answer could not be built; the other engines are answered as usual. */
  error: ErrorBody | null
}

// ---------------------------------------------------------------------------------------------
// POST /atomic/v1/engines/versions
// ---------------------------------------------------------------------------------------------

export interface EngineVersionsRequest {
  /** Re-read every engine's source from the network. */
  force?: boolean
  proxy?: ProxyConfig | null
  /** The client's version, for `minimum_app_version` and the TurboQuant `min_app_version` gate. */
  app_version?: string | null
}

export interface EngineVersionsResponse {
  /** One entry per engine registered on this host; an engine this platform lacks is absent. */
  engines: EngineVersions[]
}

// ---------------------------------------------------------------------------------------------
// POST /atomic/v1/engines/:engine/update
// ---------------------------------------------------------------------------------------------

/** llama.cpp, sd.cpp and MLX: answers once applied, which can take as long as the download. */
export interface EngineSwapUpdateRequest {
  /** The download task progress and cancellation run under (`POST /downloads/:task_id/cancel`). */
  task_id: string
  /**
   * llama.cpp only: the build to move to. Without `version` — the newest of that `variant` in the
   * catalog. With a target the family check does not apply: the client chose. sd.cpp and MLX refuse it.
   */
  target?: { version?: string; variant: string }
  force?: boolean
  proxy?: ProxyConfig | null
  app_version?: string | null
}

/** A managed engine: answers `202` with the removal that starts the reinstall. */
export interface EngineReinstallRequest {
  /** Makes a retried call the same operation; the setup that follows runs under `<request_id>:setup`. */
  request_id: string
  app_version?: string | null
}

export type EngineUpdateRequest = EngineSwapUpdateRequest | EngineReinstallRequest

export type EngineUpdateNotAppliedReason = 'already-active' | 'no-update'

export interface EngineUpdateResult {
  /** `false` when nothing changed; `reason` says why. */
  updated: boolean
  reason?: EngineUpdateNotAppliedReason
  active: EngineBuildKey | null
  /** Builds removed after the new one became active. */
  retired: EngineBuildKey[]
  /** Builds left on disk because something still runs from them. */
  kept_in_use: EngineBuildKey[]
}

/** `202`: a managed engine's reinstall began; follow it on `environment:operation`. */
export interface EngineOperationStarted {
  operation_id: string
}

// ---------------------------------------------------------------------------------------------
// DELETE /atomic/v1/engines/:engine/builds/:version/:variant
// ---------------------------------------------------------------------------------------------

/** `removed: false` for a build that was not there. A managed engine answers `202` `EngineOperationStarted`. */
export interface EngineBuildDeleteResult {
  removed: boolean
}

// ---------------------------------------------------------------------------------------------
// POST /atomic/v1/engines/:engine/builds/:version/:variant/activate
// ---------------------------------------------------------------------------------------------

export interface EngineActivateResult {
  activated: boolean
  reason?: 'already-active'
  active: EngineBuildKey
}

// ---------------------------------------------------------------------------------------------
// The event
// ---------------------------------------------------------------------------------------------

export const ENGINE_CHANGED_REASONS = [
  'update',
  'activate',
  'install',
  'uninstall',
  'startup-cleanup',
  'reinstall',
] as const
export type EngineChangedReason = (typeof ENGINE_CHANGED_REASONS)[number]

/** The set or the active build of an engine changed, by any route: re-read `POST /engines/versions`. */
export interface EngineChangedEvent {
  engine: EngineId
  reason: EngineChangedReason
}
