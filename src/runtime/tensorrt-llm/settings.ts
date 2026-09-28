/**
 * The `tensorrt-llm` provider settings as the settings store holds them (`src/settings/schema/
 * tensorrt-llm.json`, task 2.14) turned into what the adapter validates (`TensorrtLlmSettings`). The
 * store keeps "not set" as a value a settings form can show — `gpu_id: ''`, `load_timeout_seconds:
 * 0` — while the adapter spells it `null`; this is the one place that translates between the two.
 * Validation itself is the adapter's (`validateTensorrtLlmSettings`), so a load is refused with
 * `INVALID_ARGUMENT` before any container exists (spec "Настройки MUST валидироваться схемой до
 * запуска контейнера").
 */
import { validateTensorrtLlmSettings } from './adapter.js'
import type { TensorrtLlmSettings } from './adapter.js'

const KEYS = [
  'gpu_id',
  'context_length',
  'max_output_tokens',
  'kv_cache_free_gpu_memory_fraction',
  'load_timeout_seconds',
] as const

/**
 * Stored values, overlaid by a load's own overrides (the control API's `overrides`), reduced to this
 * provider's keys and validated. Anything else in either object — another provider's key, a stray
 * field a client sent — is ignored rather than passed to the engine.
 */
export function tensorrtLlmSettings(
  stored: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
): TensorrtLlmSettings {
  const merged: Record<string, unknown> = {}
  for (const key of KEYS) {
    const value = key in overrides ? overrides[key] : stored[key]
    if (value !== undefined) merged[key] = value
  }
  if (typeof merged['gpu_id'] === 'string' && merged['gpu_id'].trim() === '') merged['gpu_id'] = null
  if (merged['load_timeout_seconds'] === 0) merged['load_timeout_seconds'] = null
  return validateTensorrtLlmSettings(merged)
}
