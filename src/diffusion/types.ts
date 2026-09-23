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

/** The engine's generation modes, as `supported_modes` names them. */
export type SdMode = 'img_gen' | 'vid_gen'

/** What `GET /sdcpp/v1/capabilities` said after the server came up. */
export interface ServerCapabilities {
  /** `features_by_mode.img_gen.cancel_generating`. */
  cancelGenerating: boolean
  imgGenDefaults?: unknown
  /** `supported_modes`; absent on builds that predate the field (image only). */
  supportedModes?: SdMode[]
  /** The `vid_gen` sections, present when the build reports that mode. */
  vidGen?: {
    cancelGenerating: boolean
    /** `output_formats_by_mode.vid_gen`; absent when the build does not list formats. */
    outputFormats?: string[]
    defaults?: unknown
  }
}

/** The mode a model of `modality` is served in. */
export const modeOf = (modality: DiffusionModality): SdMode => (modality === 'video' ? 'vid_gen' : 'img_gen')

/** A request's images, already base64, so the argument builders stay free of I/O. */
export interface ResolvedInputs {
  init?: string
  mask?: string
  /** For the reference workflows: the source first, then the extras. */
  refs: string[]
  /** Video: the last frame of an image-to-video request. */
  end?: string
}

export const DEFAULT_STARTUP_TIMEOUT_SECS = 600
export const DEFAULT_IDLE_UNLOAD_SECS = 600
export const MAX_BATCH = 4
