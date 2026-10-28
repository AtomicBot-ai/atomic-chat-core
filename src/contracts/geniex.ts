/**
 * GenieX's devices, model metadata and compatibility check (openspec change `add-geniex-runtime`,
 * tasks 5.2, 6.4–6.5): the accelerator routes answer in LiteRT-LM's shape, so the clients reuse their
 * UI; there is nothing to prepare — the NPU and GPU libraries ship inside the SDK build.
 *
 * Browser-safe: types and constants only. snake_case on the wire.
 */

import type { GeniexChip, GeniexDevice, GeniexPlugin } from './model-yml.js'

/** What `geniex-host inspect` reads from a GGUF file without a model: its header, and `mmproj` beside it. */
export interface GeniexGgufMetadata {
  kind: 'gguf'
  /** `general.architecture`; `null` when the header lacks it. */
  architecture: string | null
  /** `<arch>.context_length`; `null` when the header lacks it. */
  max_context_tokens: number | null
  /** `general.file_type` as llama.cpp names it (`Q4_0`, `Q4_K_M`, …); `null` when unknown. */
  quantization: string | null
  /** The header carries `tokenizer.chat_template`. */
  chat_template: boolean
  /** An `mmproj*.gguf` lies beside the file. */
  vision: boolean
}

/**
 * What `geniex-host inspect` reads from an AI Hub bundle folder (spike S4, AI Hub v0.65.0): the context
 * from `genie_config.json`, `precision` from `metadata.json`, the chip from the Hexagon generation in
 * `htp_backend_ext_config.json` (`v73` x-elite, `v81` x2-elite). No bundle names a minimal GenieX.
 */
export interface GeniexBundleMetadata {
  kind: 'qairt'
  /** The chip the bundle is compiled for, as conf spells it; `null` when the bundle does not say. */
  chip: GeniexChip | null
  max_context_tokens: number | null
  precision: string | null
  /** The oldest GenieX that runs it; `null` when the bundle does not say. */
  min_runtime_version: string | null
}

export type GeniexModelMetadata = GeniexGgufMetadata | GeniexBundleMetadata

export interface GeniexAccelerator {
  /** `npu` or `gpu`. */
  name: string
  /** The device, the same word: what a variant names. */
  device: GeniexDevice
  /** The GenieX version of the active build. */
  version: string
  /** Nothing to download: the libraries are in the build. */
  size_bytes: number
  /** Always `true`: found by the library at the build's install. */
  prepared: boolean
  reason?: string
}

/** `GET /runtimes/geniex/accelerators`, in LiteRT-LM's shape (spec "Устройства библиотеки отдаются клиенту"). */
export interface GeniexAccelerators {
  /** `false`: no GenieX build is installed; the list is empty. */
  installed: boolean
  /** The active build, `<version>/<platform>`. */
  build: string | null
  /** This machine's chip. */
  chip: GeniexChip | null
  /** The devices the active build's library found at its install: `npu` for `HTP0`, `gpu` for `GPUOpenCL`. */
  accelerators: GeniexAccelerator[]
  error: string | null
}

export interface GeniexPrepareRequest {
  accelerators?: string[]
}

/** `POST …/accelerators/prepare`: nothing to prepare; every name answers `prepared` with why. */
export interface GeniexPrepareResult {
  accelerators: Array<{ name: string; prepared: boolean; reason?: string }>
}

/**
 * `POST /models/geniex/check`: a variant before it is downloaded (`plugin`, `device`, `chip` for a
 * bundle, `min_runtime_version` when conf knows it), a downloaded file or bundle folder by `path`
 * inside `<data>/geniex/models` with its `plugin` and `device` — and, for a bundle, the `chip` conf
 * named, which stands in when the bundle's files do not say — or an installed model by
 * `model_id`.
 */
export interface GeniexCheckRequest {
  plugin?: string
  device?: string
  chip?: string
  min_runtime_version?: string
  path?: string
  model_id?: string
}

export const GENIEX_CHECK_VERDICTS = [
  'ok',
  'engine-not-installed',
  'platform-unsupported',
  'accelerator-unavailable',
  'requires-newer-engine',
] as const
export type GeniexCheckVerdict = (typeof GENIEX_CHECK_VERDICTS)[number]

export interface GeniexCheckResult {
  verdict: GeniexCheckVerdict
  /** Why, in words a card can show; `null` for `ok`. */
  reason: string | null
  /** The model's facts, for a model on disk: what a client writes into `model.yml`. */
  metadata?: GeniexModelMetadata
}

export type { GeniexPlugin }
