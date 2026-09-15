/**
 * Provider setting schemas: the app's four extension `settings.json` descriptor arrays embedded verbatim
 * as JSON (`schema/*.json`), the per-key defaults, and the canonical value types the runtime expects.
 *
 * Ported from: core/src/browser/extension.ts:150-240 (`registerSettings` / `getSettings` / `getSetting` /
 * `updateSettings` — the array lives in `localStorage[<extension name>]`, values are whatever the UI
 * stored), extensions/llamacpp-upstream-extension/src/index.ts:697-745 (`onLoad`: for every descriptor
 * `config[key] = await getSetting(key, descriptor.controllerProps.value)` — so `this.config` is typed by
 * the descriptor defaults), extensions/mlx-extension/src/buildMlxConfig.ts (`asNumber`: number inputs
 * ship string defaults and the UI hands back strings).
 *
 * The wire types are an explicit table, not derived from `controllerProps.type`, because the descriptors
 * disagree with Rust `LlamacppConfig`: `timeout` ships "1800" (a string) but is `i32`; `fit_ctx` ships
 * 4096 (a number) but is `String`; `fit_target` is a string on both sides. Keys missing from the table
 * pass through untouched, so unknown keys survive (PLAN.md §5.1).
 */

import type { LocalProviderId, SettingDescriptor } from '../contracts/index.js'
import foundationModelsSchema from './schema/foundation-models.json' with { type: 'json' }
import llamacppUpstreamSchema from './schema/llamacpp-upstream.json' with { type: 'json' }
import llamacppSchema from './schema/llamacpp.json' with { type: 'json' }
import mlxSchema from './schema/mlx.json' with { type: 'json' }

export const LOCAL_PROVIDER_IDS: readonly LocalProviderId[] = [
  'llamacpp-upstream',
  'llamacpp',
  'mlx',
  'foundation-models',
]

const CONTROLLER_TYPES = new Set(['checkbox', 'input', 'dropdown', 'slider'])

/** Validate the embedded JSON once at load time; a bad descriptor is a packaging bug, not user input. */
function toDescriptors(provider: LocalProviderId, raw: unknown): SettingDescriptor[] {
  if (!Array.isArray(raw)) throw new Error(`settings schema for ${provider} is not an array`)
  return raw.map((entry, i) => {
    const d = entry as Partial<SettingDescriptor> | null
    if (
      !d ||
      typeof d.key !== 'string' ||
      typeof d.controllerType !== 'string' ||
      !CONTROLLER_TYPES.has(d.controllerType) ||
      typeof d.controllerProps !== 'object' ||
      d.controllerProps === null ||
      !('value' in d.controllerProps)
    ) {
      throw new Error(`settings schema for ${provider}: invalid descriptor at index ${i}`)
    }
    return d as SettingDescriptor
  })
}

const SCHEMAS: Record<LocalProviderId, readonly SettingDescriptor[]> = {
  'llamacpp-upstream': toDescriptors('llamacpp-upstream', llamacppUpstreamSchema),
  'llamacpp': toDescriptors('llamacpp', llamacppSchema),
  'mlx': toDescriptors('mlx', mlxSchema),
  'foundation-models': toDescriptors('foundation-models', foundationModelsSchema),
}

/** The descriptor array as the app registers it (deep copy — callers may mutate `options`/`value`). */
export function settingsSchema(provider: LocalProviderId): SettingDescriptor[] {
  return structuredClone(SCHEMAS[provider]) as SettingDescriptor[]
}

/** `key → controllerProps.value`, exactly as the descriptors ship (`timeout` is the string "1800" here). */
export function defaultSettingValues(provider: LocalProviderId): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const d of SCHEMAS[provider]) out[d.key] = structuredClone(d.controllerProps.value)
  return out
}

export type CanonicalValueType = 'boolean' | 'number' | 'string'

/**
 * Rust `LlamacppConfig` (args.rs:12-97) field types — engine settings from `settings.json` plus the
 * per-model / computed fields the load plan merges in, so one table serves both.
 */
const LLAMACPP_VALUE_TYPES: Readonly<Record<string, CanonicalValueType>> = {
  version_backend: 'string',
  auto_unload: 'boolean',
  timeout: 'number',
  llamacpp_env: 'string',
  extra_args: 'string',
  reasoning_preserve: 'boolean',
  mtp: 'boolean',
  mtp_draft_path: 'string',
  dflash: 'boolean',
  dflash_draft_path: 'string',
  dflash_spec_supported: 'boolean',
  dflash_n_max: 'number',
  dflash_block_size: 'number',
  concurrent_mode: 'boolean',
  concurrent_slots: 'number',
  expose_metrics: 'boolean',
  parallel: 'number',
  cont_batching: 'boolean',
  fit: 'boolean',
  fit_target: 'string',
  fit_ctx: 'string',
  threads: 'number',
  threads_batch: 'number',
  ctx_shift: 'boolean',
  ctx_size: 'number',
  n_gpu_layers: 'number',
  n_predict: 'number',
  batch_size: 'number',
  ubatch_size: 'number',
  device: 'string',
  split_mode: 'string',
  main_gpu: 'number',
  flash_attn: 'string',
  no_mmap: 'boolean',
  mlock: 'boolean',
  no_kv_offload: 'boolean',
  cache_type_k: 'string',
  cache_type_v: 'string',
  defrag_thold: 'number',
  rope_scaling: 'string',
  rope_scale: 'number',
  rope_freq_base: 'number',
  rope_freq_scale: 'number',
  chat_template: 'string',
  offload_mmproj: 'boolean',
  cpu_moe: 'boolean',
  n_cpu_moe: 'number',
  override_tensor_buffer_t: 'string',
}

/** MLX `settings.json` keys plus the `MlxConfig` fields `buildMlxConfig` derives from them. */
const MLX_VALUE_TYPES: Readonly<Record<string, CanonicalValueType>> = {
  version_backend: 'string',
  dflash_enabled: 'boolean',
  block_size: 'number',
  mtp_enabled: 'boolean',
  mtp_block_size: 'number',
  eagle3_enabled: 'boolean',
  eagle3_block_size: 'number',
  kv_quant_scheme: 'string',
  kv_bits: 'number',
  timeout: 'number',
  auto_unload: 'boolean',
  ctx_size: 'number',
  draft_model_path: 'string',
}

const FOUNDATION_MODELS_VALUE_TYPES: Readonly<Record<string, CanonicalValueType>> = {
  timeout: 'number',
}

export const CANONICAL_VALUE_TYPES: Record<LocalProviderId, Readonly<Record<string, CanonicalValueType>>> = {
  'llamacpp-upstream': LLAMACPP_VALUE_TYPES,
  'llamacpp': LLAMACPP_VALUE_TYPES,
  'mlx': MLX_VALUE_TYPES,
  'foundation-models': FOUNDATION_MODELS_VALUE_TYPES,
}

/**
 * Coerce one value to its wire type. Uncoercible input ("abc" for a number, `{}` for a boolean) is
 * returned unchanged rather than invented — validation, if any, belongs to the caller.
 */
export function canonicalizeSettingValue(type: CanonicalValueType, value: unknown): unknown {
  switch (type) {
    case 'boolean': {
      if (typeof value === 'boolean') return value
      if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : value
      if (typeof value === 'string') {
        const s = value.trim().toLowerCase()
        if (s === 'true' || s === '1') return true
        if (s === 'false' || s === '0') return false
      }
      return value
    }
    case 'number': {
      if (typeof value === 'number') return value
      if (typeof value === 'boolean') return value ? 1 : 0
      if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value)
        return Number.isFinite(n) ? n : value
      }
      return value
    }
    case 'string': {
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      return value
    }
  }
}

/**
 * Apply the provider's type table to every key of `values`: booleans for checkboxes, numbers where Rust
 * has `i32`/`u32`/`f32`, strings for `fit_ctx`/`fit_target`/dropdowns. Keys the table does not know are
 * copied as they are. Never mutates the input.
 */
export function canonicalizeSettingValues(
  provider: LocalProviderId,
  values: Record<string, unknown>
): Record<string, unknown> {
  const types = CANONICAL_VALUE_TYPES[provider]
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    const type = types[key]
    out[key] = type === undefined ? value : canonicalizeSettingValue(type, value)
  }
  return out
}
