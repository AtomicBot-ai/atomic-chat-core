/**
 * The `vllm` provider's settings (change `add-vllm-runtime`, task 3.1; spec `vllm-runtime`, "Выбор
 * карты и настройки провайдера vllm"): stored values, overlaid by a load's own overrides, reduced to
 * this provider's keys and validated before anything is asked of the machine — `INVALID_ARGUMENT` for
 * anything the schema (`src/settings/schema/vllm.json`) would refuse. What the engine is never told
 * by a setting: `trust_remote_code`, request logging, an API key — no key here reaches it.
 */
import { AtomicCoreError } from '../../contracts/index.js'
import {
  GENERATION_DEFAULT_KEYS,
  readGenerationDefaults,
  type GenerationDefaults,
} from '../managed-text/generation-defaults.js'

export interface VllmSettings {
  /** `GPU-<uuid>`/`MIG-<uuid>`, or `null` to let the load pick the card with the most free memory. */
  gpu_id: string | null
  context_length: number
  max_output_tokens: number
  /** `--max-num-seqs`. */
  max_num_seqs: number
  /**
   * `--kv-cache-memory-bytes`, in GiB; `null` passes nothing, and vLLM sizes the KV cache itself from
   * the memory its share of the card leaves after the weights (it knows every model's KV shape,
   * hybrid ones included).
   */
  kv_cache_memory_gib: number | null
  /**
   * `--gpu-memory-utilization`: the share of the card vLLM may take; `null` (auto) lets core compute it
   * from the card's free memory right before the container (`vllmGpuMemoryUtilization`).
   */
  gpu_memory_utilization: number | null
  cuda_graphs: 'auto' | 'on' | 'off'
  kv_cache_dtype: 'auto' | 'fp8'
  /** Seconds. `null` leaves the adapter's own weight-based estimate in force. */
  load_timeout_seconds: number | null
  /** `--max-num-batched-tokens`; `null` leaves vLLM's own. */
  max_num_batched_tokens: number | null
  /** `false` passes `--no-enable-prefix-caching`; vLLM's own default is on. */
  enable_prefix_caching: boolean
  /** `--cpu-offload-gb`, GiB of weights kept in host memory; counted off the card by the check. */
  cpu_offload_gb: number
  /** `--dtype` of unquantized weights and activations; `auto` passes nothing. */
  dtype: 'auto' | 'float16' | 'bfloat16' | 'float32'
  /** `--seed`; `null` leaves vLLM's own. */
  seed: number | null
  /** `--async-scheduling`. */
  async_scheduling: boolean
  /**
   * Sampling defaults for a request that sets none, in vLLM's generation-config names: they join
   * `max_new_tokens` in `--override-generation-config`. A key is present only when the person set it;
   * otherwise the model's own `generation_config.json` stands.
   */
  generation: VllmGenerationDefaults
}

export type VllmGenerationDefaults = GenerationDefaults

const KEYS = [
  'gpu_id',
  'context_length',
  'max_output_tokens',
  'max_num_seqs',
  'kv_cache_memory_gib',
  'gpu_memory_utilization',
  'cuda_graphs',
  'kv_cache_dtype',
  'load_timeout_seconds',
  'max_num_batched_tokens',
  'enable_prefix_caching',
  'cpu_offload_gb',
  'dtype',
  'seed',
  'async_scheduling',
  ...Object.values(GENERATION_DEFAULT_KEYS),
] as const

const DEFAULTS: VllmSettings = {
  gpu_id: null,
  context_length: 8192,
  max_output_tokens: 4096,
  // One request at a time (owner's decision).
  max_num_seqs: 1,
  kv_cache_memory_gib: null,
  gpu_memory_utilization: null,
  cuda_graphs: 'auto',
  kv_cache_dtype: 'auto',
  load_timeout_seconds: null,
  max_num_batched_tokens: null,
  enable_prefix_caching: true,
  cpu_offload_gb: 0,
  dtype: 'auto',
  seed: null,
  async_scheduling: false,
  generation: {},
}

const GPU_UUID = /^(GPU|MIG)-[0-9A-Za-z-]+$/

const invalid = (key: string, value: unknown, why: string): never => {
  throw new AtomicCoreError(
    'INVALID_ARGUMENT',
    `vllm setting ${key} ${why}.`,
    `${key}=${JSON.stringify(value)}`
  )
}

function integer(key: string, value: unknown, min: number, max: number): number {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) {
    return invalid(key, value, `must be a whole number from ${min} to ${max}`)
  }
  return number
}

function decimal(key: string, value: unknown, inRange: (n: number) => boolean, range: string): number {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isFinite(number) || !inRange(number)) {
    return invalid(key, value, `must be a number ${range}`)
  }
  return number
}

function yesNo(key: string, value: unknown): boolean {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return invalid(key, value, 'must be true or false')
}

function oneOf<T extends string>(key: string, value: unknown, allowed: readonly T[]): T {
  return allowed.includes(value as T)
    ? (value as T)
    : invalid(key, value, `must be one of ${allowed.join(', ')}`)
}

/** Validates already-merged values; anything absent takes the schema's default. */
export function validateVllmSettings(raw: Record<string, unknown>): VllmSettings {
  const settings: VllmSettings = { ...DEFAULTS }
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
  if (raw['max_num_seqs'] !== undefined)
    settings.max_num_seqs = integer('max_num_seqs', raw['max_num_seqs'], 1, 256)
  if (raw['kv_cache_memory_gib'] !== undefined && raw['kv_cache_memory_gib'] !== null)
    settings.kv_cache_memory_gib = decimal(
      'kv_cache_memory_gib',
      raw['kv_cache_memory_gib'],
      (n) => n > 0 && n <= 1024,
      'above 0 and at most 1024'
    )
  if (raw['gpu_memory_utilization'] !== undefined && raw['gpu_memory_utilization'] !== null)
    settings.gpu_memory_utilization = decimal(
      'gpu_memory_utilization',
      raw['gpu_memory_utilization'],
      (n) => n > 0 && n <= 1,
      'above 0 and at most 1'
    )
  if (raw['cuda_graphs'] !== undefined)
    settings.cuda_graphs = oneOf('cuda_graphs', raw['cuda_graphs'], ['auto', 'on', 'off'])
  if (raw['kv_cache_dtype'] !== undefined)
    settings.kv_cache_dtype = oneOf('kv_cache_dtype', raw['kv_cache_dtype'], ['auto', 'fp8'])
  if (raw['load_timeout_seconds'] !== undefined && raw['load_timeout_seconds'] !== null)
    settings.load_timeout_seconds = integer('load_timeout_seconds', raw['load_timeout_seconds'], 1, 3600)
  if (raw['max_num_batched_tokens'] !== undefined && raw['max_num_batched_tokens'] !== null)
    settings.max_num_batched_tokens = integer(
      'max_num_batched_tokens',
      raw['max_num_batched_tokens'],
      1,
      1_048_576
    )
  if (raw['enable_prefix_caching'] !== undefined)
    settings.enable_prefix_caching = yesNo('enable_prefix_caching', raw['enable_prefix_caching'])
  if (raw['cpu_offload_gb'] !== undefined)
    settings.cpu_offload_gb = decimal(
      'cpu_offload_gb',
      raw['cpu_offload_gb'],
      (n) => n >= 0 && n <= 1024,
      'from 0 to 1024'
    )
  if (raw['dtype'] !== undefined)
    settings.dtype = oneOf('dtype', raw['dtype'], ['auto', 'float16', 'bfloat16', 'float32'])
  if (raw['seed'] !== undefined && raw['seed'] !== null)
    settings.seed = integer('seed', raw['seed'], 1, 2_147_483_647)
  if (raw['async_scheduling'] !== undefined)
    settings.async_scheduling = yesNo('async_scheduling', raw['async_scheduling'])
  settings.generation = readGenerationDefaults('vllm', raw)
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
export function vllmSettings(
  stored: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
): VllmSettings {
  const merged: Record<string, unknown> = {}
  for (const key of KEYS) {
    const value = key in overrides ? overrides[key] : stored[key]
    if (value !== undefined) merged[key] = value
  }
  if (typeof merged['gpu_id'] === 'string' && merged['gpu_id'].trim() === '') merged['gpu_id'] = null
  if (merged['load_timeout_seconds'] === 0) merged['load_timeout_seconds'] = null
  if (merged['kv_cache_memory_gib'] === 0) merged['kv_cache_memory_gib'] = null
  if (merged['gpu_memory_utilization'] === 0) merged['gpu_memory_utilization'] = null
  if (merged['max_num_batched_tokens'] === 0) merged['max_num_batched_tokens'] = null
  if (merged['seed'] === 0) merged['seed'] = null
  for (const key of Object.values(GENERATION_DEFAULT_KEYS)) {
    if (typeof merged[key] === 'string' && merged[key].trim() === '') merged[key] = null
  }
  return validateVllmSettings(merged)
}
