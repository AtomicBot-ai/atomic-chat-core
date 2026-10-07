/**
 * Engine builds the core installs itself: stable-diffusion.cpp (`sd-server`) and MLX (`mlx-server`),
 * from conf's `backends/sdcpp-manifest.json` and `backends/mlx-manifest.json` (openspec change
 * `move-sdcpp-mlx-install-to-core`, spec `engine-builds`). snake_case on the wire, like `/backends`
 * and `/environments`.
 *
 * The core advises and the client decides (ADR 2026-09-27): nothing here installs on a schedule.
 * `POST /engine-builds/:engine/catalog` and `/updates` only read; `/install` acts when called.
 */

import type { ProxyConfig } from './backend-advisor.js'

export const ENGINE_BUILD_IDS = ['sd-cpp', 'mlx'] as const
export type EngineBuildId = (typeof ENGINE_BUILD_IDS)[number]

/**
 * `downloaded` — installed by the core under `<data>`, removable; `bundled` — `mlx-server` shipped in
 * the desktop installer (`--resources-dir`), read-only, never removed by the core.
 */
export type EngineBuildOrigin = 'downloaded' | 'bundled'

/** One build, by what identifies it on disk. */
export interface EngineBuildRef {
  tag: string
  backend_id: string
  origin: EngineBuildOrigin
}

export interface InstalledEngineBuild extends EngineBuildRef {
  /** `null` for a bundled build: the installer, not the core, put it there. */
  installed_at_ms: number | null
  /** MLX: the release date the build is ordered by; `null` when unknown (oldest of all). */
  published_at?: string | null
  removable: boolean
  /** A loaded session runs from this build right now. */
  in_use: boolean
  /** The build the next model load uses. */
  active: boolean
}

/** The accepted manifest a catalog was built from. */
export interface EngineBuildManifestInfo {
  tag: string
  /** MLX only. */
  published_at?: string
  /** `cache` — the network gave nothing acceptable this time; `error` says why. */
  source: 'remote' | 'cache'
  /** Milliseconds since the epoch. */
  fetched_at: number
  error: string | null
}

export interface EngineBuildCatalog {
  engine: EngineBuildId
  /** `null` when there is neither a network answer nor a cached copy; `manifest_error` says why. */
  manifest: EngineBuildManifestInfo | null
  manifest_error: string | null
  /** The build this host would install from the manifest; `null` with `host_reason` when none fits. */
  host_backend_id: string | null
  host_reason: string | null
  installed: InstalledEngineBuild[]
  active: InstalledEngineBuild | null
}

export interface EngineBuildCatalogRequest {
  /** Re-read the manifest from the network. */
  force?: boolean
  proxy?: ProxyConfig | null
}

export type EngineBuildUpdateCheckRequest = EngineBuildCatalogRequest

export interface EngineBuildTarget {
  tag: string
  backend_id: string
  published_at?: string
  /** Every archive the install would download (the cudart companion included). */
  download_bytes: number
}

export interface EngineBuildUpdateCheck {
  /** `true` only for a build strictly newer than the active one; never without an active build. */
  update_needed: boolean
  current: EngineBuildRef | null
  target: EngineBuildTarget | null
}

export interface EngineBuildInstallRequest {
  /** The download task progress and cancellation run under (`POST /downloads/:task_id/cancel`). */
  task_id: string
  /** Reinstall the same build. Never installs one older than the active build. */
  force?: boolean
  proxy?: ProxyConfig | null
}

export interface EngineBuildInstallResult {
  /** `false` when nothing was downloaded; `reason` says why. */
  installed: boolean
  reason?: 'already-installed' | 'active-is-newer'
  build: EngineBuildRef
  /** Other downloaded builds removed after the new one became active. */
  retired: EngineBuildRef[]
  /** Builds left because a session still runs from them; removed on a later install or start. */
  kept_in_use: EngineBuildRef[]
  /**
   * sd.cpp: builds higher on this host's ladder that unpacked but failed their probe on the way down
   * (design D7); they are skipped for this tag from now on.
   */
  failed_backend_ids?: string[]
}

export interface EngineBuildRemoveResult {
  removed: boolean
}

export interface EngineBuildChangedEvent {
  engine: EngineBuildId
  reason: 'install' | 'uninstall' | 'startup-cleanup'
}
