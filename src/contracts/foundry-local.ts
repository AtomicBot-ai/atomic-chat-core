/**
 * Foundry Local's accelerators (openspec change `add-foundry-local`, task 6.4, design D3): what the
 * library of the active build finds on this machine, and the explicit, client-ordered step that
 * downloads them (NPU plugins through Windows ML, CUDA and WebGPU from Microsoft's CDN). Nothing
 * downloads an accelerator on its own: not the start, not an install, not a model load.
 *
 * Browser-safe: types and constants only. snake_case on the wire, like `/engine-builds`.
 */

import type { FoundryLocalExecutionProvider } from './model-yml.js'

export interface FoundryLocalAccelerator {
  /** The library's name (`OpenVINOExecutionProvider`, `CUDAExecutionProvider`, …). */
  name: string
  /** The conf/`model.yml` spelling; `null` for one this core runs no variant on (TensorRT-RTX). */
  execution_provider: FoundryLocalExecutionProvider | null
  /** `gpu`, `npu`, `cpu`, or `gpu/npu` for OpenVINO, which Windows ML offers without an NPU too. */
  device: string
  /** Downloaded and registered by a `prepare` on this machine. */
  prepared: boolean
  /** Why the last `prepare` did not prepare it, in the library's words when it had any. */
  reason?: string
}

export interface FoundryLocalAccelerators {
  /** `false`: no Foundry Local build is installed; the list is empty and nothing was probed. */
  installed: boolean
  /** The build probed: `<tag>/<platform>` directory name pair, e.g. `v2.1.0/win-x64`. */
  build: string | null
  /** The library's version string and C API version, from the probe. */
  version: string | null
  c_api_version: number | null
  /** Milliseconds since the epoch of the probe this answer is; `null` when none ran. */
  probed_at: number | null
  accelerators: FoundryLocalAccelerator[]
  /** Why the probe failed (the library does not load, …); the list is then empty. */
  error: string | null
}

export interface FoundryLocalPrepareRequest {
  /** The library names to prepare; absent or empty: every accelerator the library offers here. */
  accelerators?: string[]
}

export interface FoundryLocalPrepareResult {
  accelerators: Array<{ name: string; prepared: boolean; reason?: string }>
}

export const FOUNDRY_LOCAL_PREPARE_STAGES = ['started', 'downloading', 'done', 'failed'] as const
export type FoundryLocalPrepareStage = (typeof FOUNDRY_LOCAL_PREPARE_STAGES)[number]

/**
 * `foundry-local:accelerators`: one accelerator's step of a `prepare`. `fraction` is 0…1 while a CDN
 * download runs; Windows ML accelerators report none, only `started` and `done`/`failed`, and a
 * `failed` step has `fraction: null` (rulings R6 of the change).
 */
export interface FoundryLocalAcceleratorsEvent {
  accelerator: string
  stage: FoundryLocalPrepareStage
  fraction: number | null
  reason?: string
}
