/**
 * LiteRT-LM's accelerator and compatibility check (openspec change `add-litert-lm-runtime`, tasks
 * 6.4–6.5): the same routes, event and answer shapes as Foundry Local's, so the clients reuse their UI.
 * The one accelerator is `openvino` — Intel's libraries an NPU variant needs on Windows (design D3);
 * nothing downloads it on its own: not the start, not an install, not a load.
 *
 * Browser-safe: types and constants only. snake_case on the wire.
 */

import type { ProxyConfig } from './backend-advisor.js'
import type { FoundryLocalPrepareStage } from './foundry-local.js'
import type { LiteRtLmBackendId, LiteRtLmNpu } from './model-yml.js'

export interface LiteRtLmAccelerator {
  /** `openvino`. */
  name: string
  /** `npu`: the only device it serves. */
  device: string
  /** The OpenVINO version the active release pins. */
  version: string
  /** What a prepare downloads. */
  size_bytes: number
  /** Downloaded, checked and unpacked on this machine. */
  prepared: boolean
  /** Why the last prepare failed. */
  reason?: string
}

export interface LiteRtLmAccelerators {
  /** `false`: no LiteRT-LM build is installed; the list is empty. */
  installed: boolean
  /** The active build, `<version>/<platform>`. */
  build: string | null
  /** This machine's Intel NPU generation LiteRT-LM files target; `null` without one (the list is empty). */
  npu: LiteRtLmNpu | null
  accelerators: LiteRtLmAccelerator[]
  /** Why the list could not be made (no manifest for the active release, …). */
  error: string | null
}

export interface LiteRtLmPrepareRequest {
  /** Names to prepare; absent or empty: every accelerator offered here. */
  accelerators?: string[]
  /** The proxy the wheel downloads through, as an engine install takes it. */
  proxy?: ProxyConfig | null
}

export interface LiteRtLmPrepareResult {
  accelerators: Array<{ name: string; prepared: boolean; reason?: string }>
}

/** `litert-lm:accelerators`: one step of a prepare; `fraction` 0…1 while it downloads, `null` when failed. */
export interface LiteRtLmAcceleratorsEvent {
  accelerator: string
  stage: FoundryLocalPrepareStage
  fraction: number | null
  reason?: string
}

/** What `litert-host inspect` reads from a `.litertlm` file without an engine (spec "Сведения о файле"). */
export interface LiteRtLmFileMetadata {
  model_type: 'llm' | 'embedding' | 'unknown'
  /** `null` when the file does not declare one. */
  max_context_tokens: number | null
  dynamic_context: boolean
  /** As the file declares it; Gemma 4 files say `false` and call tools anyway. */
  function_calling: boolean
  thinking: boolean
  modalities: Array<'text' | 'vision' | 'audio' | 'video'>
  /** Backends of the text modality, the default first. */
  backends: LiteRtLmBackendId[]
  vision_backends: LiteRtLmBackendId[]
  npu: {
    brand: 'unknown' | 'qualcomm' | 'google-tensor' | 'mediatek' | 'intel' | 'samsung'
    soc: string | null
  } | null
  speculative_decoding: boolean
  min_runtime_version: string | null
}

/**
 * `POST /models/litert-lm/check`: a variant before it is downloaded (`backend`, `npu`,
 * `min_runtime_version` from conf), a downloaded file by `path` inside `<data>/litert-lm/models` with
 * the variant's `backend`/`npu`, or an installed model by `model_id`.
 */
export interface LiteRtLmCheckRequest {
  backend?: string
  npu?: string
  min_runtime_version?: string
  path?: string
  model_id?: string
}

export const LITERT_LM_CHECK_VERDICTS = [
  'ok',
  'engine-not-installed',
  'platform-unsupported',
  'accelerator-unavailable',
  'accelerator-not-prepared',
  'requires-newer-engine',
] as const
export type LiteRtLmCheckVerdict = (typeof LITERT_LM_CHECK_VERDICTS)[number]

export interface LiteRtLmCheckResult {
  verdict: LiteRtLmCheckVerdict
  /** Why, in words a card can show; `null` for `ok`. */
  reason: string | null
  /** The file's facts, for a file on disk: what a client writes into `model.yml`. */
  metadata?: LiteRtLmFileMetadata
}
