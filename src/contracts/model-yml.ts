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
]
