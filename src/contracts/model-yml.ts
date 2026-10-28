/**
 * `<data>/llamacpp/models/<id>/model.yml` — the file that defines a model. Shared with the app;
 * see PLAN.md §8.1. Canonical shape: guest-js/types.ts:142-171 (+ `capabilities` from cli/mod.rs).
 */

export type ImportedModelSource =
  | 'ollama'
  | 'lmstudio'
  | 'unsloth'
  | 'local'
  | 'huggingface-cache'
  | 'gpt4all'
  | 'jan'
  | 'msty'
  | 'llamacpp-cache'

export interface ModelYml {
  /** Relative to the data folder, or absolute. Required. */
  model_path: string
  mmproj_path?: string
  name: string
  size_bytes: number
  /** Non-sharded models only. */
  model_sha256?: string
  model_size_bytes?: number
  mmproj_sha256?: string
  mmproj_size_bytes?: number
  embedding?: boolean
  projector_vision?: boolean
  projector_audio?: boolean
  /** Data-folder-relative Gemma 4 MTP head. */
  mtp_draft_path?: string
  /** Data-folder-relative DFlash draft. */
  dflash_draft_path?: string
  source?: ImportedModelSource
  capabilities?: string[]
  /**
   * Written by a model setup for a file only one engine runs (PrismML Bonsai). Absent means any
   * llama.cpp provider; the load gate still reads the header either way.
   */
  atomic_runtime?: ModelYmlAtomicRuntime
  /** A Foundry Local variant (`<data>/foundry-local/models/<variant_id>/`), written by the app's installer. */
  foundry_local?: ModelYmlFoundryLocal
  /** A LiteRT-LM variant (`<data>/litert-lm/models/<variant_id>/`), written by the app or `atc`. */
  litert_lm?: ModelYmlLiteRtLm
  /** A GenieX model (`<data>/geniex/models/<model_id or variant_id>/`), written by the app or `atc`. */
  geniex?: ModelYmlGeniex
}

export interface ModelYmlAtomicRuntime {
  provider: 'atomic-prism'
  /** Engine capabilities the file needs (`pq2_0`, `hadamard`, …). */
  requires?: string[]
  /** Oldest PrismML build that runs it. */
  min_build?: number
  /** Conf model-rules family id. */
  family?: string
}

/** The accelerators a Foundry Local variant may name, as conf's model list spells them. */
export const FOUNDRY_LOCAL_EXECUTION_PROVIDERS = [
  'cpu',
  'cuda',
  'webgpu',
  'openvino',
  'qnn',
  'vitisai',
] as const
export type FoundryLocalExecutionProvider = (typeof FOUNDRY_LOCAL_EXECUTION_PROVIDERS)[number]

export const FOUNDRY_LOCAL_DEVICES = ['cpu', 'gpu', 'npu'] as const
export type FoundryLocalDevice = (typeof FOUNDRY_LOCAL_DEVICES)[number]

/**
 * The `foundry_local` block (openspec change `add-foundry-local`, design D4): which variant the folder
 * holds and what the host registers it with. The accelerator is passed to the library explicitly.
 */
export interface ModelYmlFoundryLocal {
  /** The model the variant belongs to (conf list id, or the catalog's parent model). */
  model_id: string
  variant_id: string
  execution_provider: FoundryLocalExecutionProvider
  device: FoundryLocalDevice
  /** `azureml://registries/<r>/models/<name>/versions/<v>`. */
  asset_id?: string
  asset_version?: string
  /** The variant's context, when it is smaller than the model's (NPU builds). */
  context_length?: number
  tools: boolean
  reasoning: boolean
  /** The markers the library splits reasoning on; without them `<think>` lands in the text (operator decision Q1). */
  reasoning_start?: string
  reasoning_end?: string
}

/** The backends a LiteRT-LM variant runs on (change `add-litert-lm-runtime`). */
export const LITERT_LM_BACKENDS = ['cpu', 'gpu', 'npu'] as const
export type LiteRtLmBackendId = (typeof LITERT_LM_BACKENDS)[number]

/** The Intel NPU generations LiteRT-LM files are compiled for: Lunar Lake and Panther Lake (design D3). */
export const LITERT_LM_NPUS = ['intel-lnl', 'intel-ptl'] as const
export type LiteRtLmNpu = (typeof LITERT_LM_NPUS)[number]

/**
 * The `litert_lm` block (spec `litert-lm-models`, task 6.2): which variant the folder holds and what it
 * can do. `tools`, `reasoning` and `vision` come from conf's list, or for a Hugging Face model from
 * core's check of the downloaded file.
 */
export interface ModelYmlLiteRtLm {
  model_id: string
  variant_id: string
  backend: LiteRtLmBackendId
  /** Present exactly when `backend` is `npu`. */
  npu?: LiteRtLmNpu
  /** `<org>/<name>` on Hugging Face. */
  repo: string
  revision: string
  /** The file's path in the repository; its name in the variant folder. */
  file: string
  /** Absent when neither conf nor the file declares one. */
  context_length?: number
  tools: boolean
  reasoning: boolean
  vision: boolean
  source: 'curated' | 'huggingface'
}

/** The devices a GenieX model runs on: GenieX's own aliases (`geniex_resolve_device`), change `add-geniex-runtime`. */
export const GENIEX_DEVICES = ['npu', 'gpu', 'cpu', 'hybrid'] as const
export type GeniexDevice = (typeof GENIEX_DEVICES)[number]

/** The GenieX plugins: `llama_cpp` runs a GGUF file, `qairt` an AI Hub bundle (design D4). */
export const GENIEX_PLUGINS = ['llama_cpp', 'qairt'] as const
export type GeniexPlugin = (typeof GENIEX_PLUGINS)[number]

/** The Snapdragon chips AI Hub bundles are compiled for, as conf's model list spells them (design D3). */
export const GENIEX_CHIPS = ['x-elite', 'x2-elite'] as const
export type GeniexChip = (typeof GENIEX_CHIPS)[number]

/**
 * The `geniex` block (spec `geniex-models`, "Скачанная модель лежит в папке провайдера с model.yml";
 * task 6.2, design D4): what the folder holds and how the host runs it. A GGUF file (`llama_cpp`)
 * is one record whose device is a launch parameter (`backend` is the default, the settings may
 * change it); an AI Hub bundle (`qairt`) is one variant per chip and runs on the NPU only.
 */
export interface ModelYmlGeniex {
  model_id: string
  variant_id: string
  plugin: GeniexPlugin
  /** The default device; `npu` for a bundle. */
  backend: GeniexDevice
  /** `qairt`: the chip the bundle is compiled for. */
  chip?: GeniexChip
  /** `llama_cpp`: `<org>/<name>` on Hugging Face and the commit the file came from. */
  repo?: string
  revision?: string
  /** `llama_cpp`: the file's path in the repository; its name in the model folder. */
  file?: string
  mmproj?: string
  /** `qairt`: the zip the bundle was unpacked from. */
  bundle_url?: string
  precision?: string
  context_length: number
  tools: boolean
  reasoning: boolean
  vision: boolean
  source: 'curated' | 'huggingface'
}

/** Key order the app's serde_yaml writer produces; `writeModelYml` must emit keys in this order. */
export const MODEL_YML_KEY_ORDER: readonly (keyof ModelYml)[] = [
  'model_path',
  'mmproj_path',
  'name',
  'size_bytes',
  'model_sha256',
  'model_size_bytes',
  'mmproj_sha256',
  'mmproj_size_bytes',
  'embedding',
  'projector_vision',
  'projector_audio',
  'mtp_draft_path',
  'dflash_draft_path',
  'source',
  'capabilities',
  'atomic_runtime',
  'foundry_local',
  'litert_lm',
  'geniex',
]
