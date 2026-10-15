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
]
