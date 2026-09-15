/**
 * Provider settings as the core stores them (canonical keys). The app's extension `settings.json`
 * descriptors are copied into `src/settings/schema/*.json`; this file only carries the value types.
 * Source: guest-js/types.ts:151-222 (LlamacppConfig), extensions/<ext>/settings.json.
 */

import type { LocalProviderId } from './session.js'

export type FlashAttn = 'auto' | 'on' | 'off'
export type SplitMode = 'none' | 'layer' | 'row'
export type CacheType =
  | 'f32'
  | 'f16'
  | 'bf16'
  | 'q8_0'
  | 'q4_0'
  | 'q4_1'
  | 'iq4_nl'
  | 'q5_0'
  | 'q5_1'
  | 'turbo2'
  | 'turbo3'
  | 'turbo4'

/**
 * Full llama-server load configuration: engine settings merged with per-model overrides.
 * Mirrors Rust `LlamacppConfig` field-for-field (`dflash_block_size` is an engine setting that the
 * load plan turns into `dflash_n_max`; it is not part of this struct).
 */
export interface LlamacppConfig {
  /** `<version>/<backend>`, e.g. `b10405/macos-arm64`. */
  version_backend: string
  auto_unload: boolean
  timeout: number
  llamacpp_env: string
  extra_args: string
  reasoning_preserve: boolean
  mtp: boolean
  mtp_draft_path: string
  dflash: boolean
  dflash_draft_path: string
  dflash_spec_supported: boolean
  dflash_n_max: number
  concurrent_mode: boolean
  concurrent_slots: number
  expose_metrics: boolean
  parallel: number
  cont_batching: boolean
  fit: boolean
  fit_target: string
  fit_ctx: string
  threads: number
  threads_batch: number
  ctx_shift: boolean
  ctx_size: number
  n_gpu_layers: number
  n_predict: number
  batch_size: number
  ubatch_size: number
  device: string
  /** Free-form in Rust; `SplitMode` documents the known values. */
  split_mode: SplitMode | string
  main_gpu: number
  /** Free-form in Rust; unknown values are not emitted. */
  flash_attn: FlashAttn | string
  no_mmap: boolean
  mlock: boolean
  no_kv_offload: boolean
  cache_type_k: CacheType | string
  cache_type_v: CacheType | string
  defrag_thold: number
  rope_scaling: string
  rope_scale: number
  rope_freq_base: number
  rope_freq_scale: number
  chat_template: string
  offload_mmproj: boolean
  cpu_moe: boolean
  n_cpu_moe: number
  override_tensor_buffer_t: string
}

export type MlxDraftKind = 'dflash' | 'mtp' | 'eagle3'
export type MlxKvQuantScheme = 'off' | 'uniform' | 'turboquant'

export interface MlxConfig {
  version_backend: string
  ctx_size: number
  auto_unload: boolean
  timeout: number
  draft_model_path: string
  draft_kind: MlxDraftKind | ''
  block_size: number
  kv_quant_scheme: MlxKvQuantScheme
  kv_bits: number
}

export interface FoundationModelsConfig {
  timeout: number
}

export type ProviderSettings<P extends LocalProviderId> = P extends 'mlx'
  ? MlxConfig
  : P extends 'foundation-models'
    ? FoundationModelsConfig
    : LlamacppConfig

/** UI descriptor of one setting (mirrors the app's SettingComponentProps). */
export interface SettingDescriptor {
  key: string
  title: string
  description: string
  controllerType: 'checkbox' | 'input' | 'dropdown' | 'slider'
  controllerProps: Record<string, unknown> & { value: unknown }
  recommended?: unknown
}

export interface ServerSettings {
  host: string
  port: number
  prefix: string
  api_key: string
  trusted_hosts: string[]
  cors_enabled: boolean
  proxy_timeout_ms: number
  enable_on_startup: boolean
  verbose_logs: boolean
}

export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  host: '127.0.0.1',
  port: 1337,
  prefix: '/v1',
  api_key: '',
  trusted_hosts: [],
  cors_enabled: true,
  proxy_timeout_ms: 600_000,
  enable_on_startup: false,
  verbose_logs: false,
}
