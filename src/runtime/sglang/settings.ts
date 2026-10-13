/**
 * The `sglang` provider's settings (change `add-sglang-runtime`, task 2.1, design D6; spec
 * `sglang-runtime`, "Выбор карты и настройки провайдера sglang"): stored values, overlaid by a load's
 * own overrides, reduced to this provider's keys and validated before anything is asked of the
 * machine — `INVALID_ARGUMENT` for anything the schema (`src/settings/schema/sglang.json`) would
 * refuse. A value left at its default reaches the engine as nothing (SGLang's own), and what the
 * engine is never told by a setting — `--trust-remote-code`, request logging, an API key — has no key
 * here.
 */
import {
  GENERATION_DEFAULT_KEYS,
  readGenerationDefaults,
  type GenerationDefaults,
} from '../managed-text/generation-defaults.js'
import { settingValues } from '../managed-text/setting-values.js'

export interface SglangSettings {
  /** `GPU-<uuid>`/`MIG-<uuid>`, or `null` to let the load pick the card with the most free memory. */
  gpu_id: string | null
  context_length: number
  max_output_tokens: number
  /** `--max-running-requests`. */
  max_running_requests: number
  /**
   * `--mem-fraction-static`: the share of the card's free memory SGLang keeps for weights and KV
   * cache; `null` (auto) lets core compute it from the card's free memory right before the container.
   */
  mem_fraction_static: number | null
  /** `--max-total-tokens`; `null` lets SGLang size the KV cache from its share. */
  max_total_tokens: number | null
  /** `auto`: `--cuda-graph-max-bs <max_running_requests>`; `on`: SGLang's own; `off`: `--disable-cuda-graph`. */
  cuda_graphs: 'auto' | 'on' | 'off'
  kv_cache_dtype: 'auto' | 'fp8'
  /** Seconds. `null` leaves the adapter's own weight-based estimate in force. */
  load_timeout_seconds: number | null
  /** `false` passes `--disable-radix-cache`; SGLang's own default is on. */
  enable_prefix_caching: boolean
  /** `--chunked-prefill-size`; `null` leaves SGLang's own. */
  chunked_prefill_size: number | null
  /** `--dtype`; `auto` passes nothing. */
  dtype: 'auto' | 'float16' | 'bfloat16' | 'float32'
  /** `--random-seed`; `null` leaves SGLang's own. */
  seed: number | null
  /** Sampling defaults for a request that sets none; a key is present only when the person set it. */
  generation: GenerationDefaults
}

const KEYS = [
  'gpu_id',
  'context_length',
  'max_output_tokens',
  'max_running_requests',
  'mem_fraction_static',
  'max_total_tokens',
  'cuda_graphs',
  'kv_cache_dtype',
  'load_timeout_seconds',
  'enable_prefix_caching',
  'chunked_prefill_size',
  'dtype',
  'seed',
  ...Object.values(GENERATION_DEFAULT_KEYS),
] as const

const DEFAULTS: SglangSettings = {
  gpu_id: null,
  context_length: 8192,
  max_output_tokens: 4096,
  // One request at a time, as every managed engine (owner's decision, change add-vllm-runtime).
  max_running_requests: 1,
  mem_fraction_static: null,
  max_total_tokens: null,
  cuda_graphs: 'auto',
  kv_cache_dtype: 'auto',
  load_timeout_seconds: null,
  enable_prefix_caching: true,
  chunked_prefill_size: null,
  dtype: 'auto',
  seed: null,
  generation: {},
}

const GPU_UUID = /^(GPU|MIG)-[0-9A-Za-z-]+$/

const { invalid, integer, decimal, yesNo, oneOf } = settingValues('sglang')

/** Validates already-merged values; anything absent takes the schema's default. */
export function validateSglangSettings(raw: Record<string, unknown>): SglangSettings {
  const settings: SglangSettings = { ...DEFAULTS }
  if (raw['gpu_id'] !== undefined && raw['gpu_id'] !== null) {
    if (typeof raw['gpu_id'] !== 'string' || !GPU_UUID.test(raw['gpu_id'])) {
      invalid('gpu_id', raw['gpu_id'], 'must be an NVIDIA GPU or MIG UUID')
    }
    settings.gpu_id = raw['gpu_id'] as string
  }
  if (raw['context_length'] !== undefined)
    settings.context_length = integer('context_length', raw['context_length'], 512, 1_048_576)
  if (raw['max_output_tokens'] !== undefined)
    settings.max_output_tokens = integer('max_output_tokens', raw['max_output_tokens'], 1, 1_048_576)
  if (raw['max_running_requests'] !== undefined)
    settings.max_running_requests = integer('max_running_requests', raw['max_running_requests'], 1, 256)
  // Below 1: the rest of SGLang's free memory is its room for activations and CUDA graphs.
  if (raw['mem_fraction_static'] !== undefined && raw['mem_fraction_static'] !== null)
    settings.mem_fraction_static = decimal(
      'mem_fraction_static',
      raw['mem_fraction_static'],
      (n) => n > 0 && n < 1,
      'above 0 and below 1'
    )
  if (raw['max_total_tokens'] !== undefined && raw['max_total_tokens'] !== null)
    settings.max_total_tokens = integer('max_total_tokens', raw['max_total_tokens'], 1, 16_777_216)
  if (raw['cuda_graphs'] !== undefined)
    settings.cuda_graphs = oneOf('cuda_graphs', raw['cuda_graphs'], ['auto', 'on', 'off'])
  if (raw['kv_cache_dtype'] !== undefined)
    settings.kv_cache_dtype = oneOf('kv_cache_dtype', raw['kv_cache_dtype'], ['auto', 'fp8'])
  if (raw['load_timeout_seconds'] !== undefined && raw['load_timeout_seconds'] !== null)
    settings.load_timeout_seconds = integer('load_timeout_seconds', raw['load_timeout_seconds'], 1, 3600)
  if (raw['enable_prefix_caching'] !== undefined)
    settings.enable_prefix_caching = yesNo('enable_prefix_caching', raw['enable_prefix_caching'])
  if (raw['chunked_prefill_size'] !== undefined && raw['chunked_prefill_size'] !== null)
    settings.chunked_prefill_size = integer('chunked_prefill_size', raw['chunked_prefill_size'], 1, 1_048_576)
  if (raw['dtype'] !== undefined)
    settings.dtype = oneOf('dtype', raw['dtype'], ['auto', 'float16', 'bfloat16', 'float32'])
  if (raw['seed'] !== undefined && raw['seed'] !== null)
    settings.seed = integer('seed', raw['seed'], 1, 2_147_483_647)
  settings.generation = readGenerationDefaults('sglang', raw)
  if (settings.max_output_tokens >= settings.context_length) {
    invalid(
      'max_output_tokens',
      settings.max_output_tokens,
      `must be less than the context length (${settings.context_length})`
    )
  }
  return settings
}

/**
 * Stored values, overlaid by a load's own overrides (the control API's `overrides`), reduced to this
 * provider's keys and validated. Anything else in either object — another provider's key, a stray
 * field a client sent — is ignored rather than passed to the engine. `''` and `0` are the stored
 * spelling of "not set" (`''` for a generation default, whose `0` can be a real value).
 */
export function sglangSettings(
  stored: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
): SglangSettings {
  const merged: Record<string, unknown> = {}
  for (const key of KEYS) {
    const value = key in overrides ? overrides[key] : stored[key]
    if (value !== undefined) merged[key] = value
  }
  if (typeof merged['gpu_id'] === 'string' && merged['gpu_id'].trim() === '') merged['gpu_id'] = null
  for (const key of [
    'load_timeout_seconds',
    'mem_fraction_static',
    'max_total_tokens',
    'chunked_prefill_size',
    'seed',
  ]) {
    if (merged[key] === 0) merged[key] = null
  }
  for (const key of Object.values(GENERATION_DEFAULT_KEYS)) {
    if (typeof merged[key] === 'string' && merged[key].trim() === '') merged[key] = null
  }
  return validateSglangSettings(merged)
}
