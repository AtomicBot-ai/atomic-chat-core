/**
 * State the diffusion module keeps for itself; nothing here crosses the wire. `state.rs` in
 * `tauri-plugin-atomic-diffusion` (app commit `767ff6350`).
 */

import type {
  DiffusionBackend,
  DiffusionEngineId,
  DiffusionFamilyDefaults,
  DiffusionFamilyRanges,
  DiffusionModality,
  DiffusionModelFiles,
  DiffusionOffloadPolicy,
} from '../contracts/index.js'

/**
 * Everything needed to (re)spawn the server. Kept after a cancel or a crash took the process down,
 * so the next job brings it back without the app repeating the load; cleared only by an unload.
 */
export interface ServerSpec {
  /** Directory holding `sd-server`. */
  binaryDir: string
  engine: DiffusionEngineId
  backend: DiffusionBackend
  backendId: string
  tag: string
  modelId: string
  family: string
  modality: DiffusionModality
  displayName: string
  files: DiffusionModelFiles
  defaults: DiffusionFamilyDefaults
  ranges: DiffusionFamilyRanges
  offload: DiffusionOffloadPolicy
  threads?: number
  /** Appended last: sd.cpp's argument parser is last-wins. */
  extraArgs: string[]
  startupTimeoutMs: number
  /** True once the ggml-abort recovery moved everything to the CPU backend. */
  cpuFallback: boolean
}

/** What `GET /sdcpp/v1/capabilities` said after the server came up. */
export interface ServerCapabilities {
  cancelGenerating: boolean
  imgGenDefaults?: unknown
}

/** A request's images, already base64, so the argument builders stay free of I/O. */
export interface ResolvedInputs {
  init?: string
  mask?: string
  /** For the reference workflows: the source first, then the extras. */
  refs: string[]
}

export const DEFAULT_STARTUP_TIMEOUT_SECS = 600
export const DEFAULT_IDLE_UNLOAD_SECS = 600
export const MAX_BATCH = 4
