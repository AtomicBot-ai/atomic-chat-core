/**
 * The `vllm` provider's settings (change `add-vllm-runtime`, task 3.1; spec `vllm-runtime`, "Выбор
 * карты и настройки провайдера vllm"): stored values, overlaid by a load's own overrides, reduced to
 * this provider's keys and validated before anything is asked of the machine — `INVALID_ARGUMENT` for
 * anything the schema (`src/settings/schema/vllm.json`) would refuse. What the engine is never told
 * by a setting: `trust_remote_code`, request logging, an API key — no key here reaches it.
 */
import { AtomicCoreError } from '../../contracts/index.js'

export interface VllmSettings {
  /** `GPU-<uuid>`/`MIG-<uuid>`, or `null` to let the load pick the card with the most free memory. */
  gpu_id: string | null
  context_length: number
  max_output_tokens: number
  /** `--max-num-seqs`. */
  max_num_seqs: number
  /** `null` sizes the KV cache as `context_length × max_num_seqs` tokens. */
  kv_cache_max_tokens: number | null
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

export interface VllmGenerationDefaults {
  temperature?: number
  top_p?: number
  top_k?: number
  min_p?: number
  repetition_penalty?: number
}

/** The stored key of each generation default, by its vLLM name. */
const GENERATION_KEYS = {
  temperature: 'default_temperature',
  top_p: 'default_top_p',
  top_k: 'default_top_k',
  min_p: 'default_min_p',
  repetition_penalty: 'default_repetition_penalty',
} as const

const KEYS = [
  'gpu_id',
  'context_length',
  'max_output_tokens',
  'max_num_seqs',
  'kv_cache_max_tokens',
  'cuda_graphs',
  'kv_cache_dtype',
  'load_timeout_seconds',
  'max_num_batched_tokens',
  'enable_prefix_caching',
  'cpu_offload_gb',
  'dtype',
  'seed',
  'async_scheduling',
  ...Object.values(GENERATION_KEYS),
] as const

const DEFAULTS: VllmSettings = {
  gpu_id: null,
  context_length: 8192,
  max_output_tokens: 4096,
  // One request at a time (owner's decision): the KV cache is sized for one full context.
  max_num_seqs: 1,
  kv_cache_max_tokens: null,
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

/** vLLM's own bounds of each sampling parameter (`SamplingParams._verify_args`). */
const GENERATION_RULES: Record<keyof VllmGenerationDefaults, (key: string, value: unknown) => number> = {
  temperature: (key, value) => decimal(key, value, (n) => n >= 0 && n <= 2, 'from 0 to 2'),
  top_p: (key, value) => decimal(key, value, (n) => n > 0 && n <= 1, 'above 0 and up to 1'),
  top_k: (key, value) => integer(key, value, -1, 1_000_000),
  min_p: (key, value) => decimal(key, value, (n) => n >= 0 && n <= 1, 'from 0 to 1'),
  repetition_penalty: (key, value) => decimal(key, value, (n) => n > 0 && n <= 10, 'above 0 and up to 10'),
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
  if (raw['kv_cache_max_tokens'] !== undefined && raw['kv_cache_max_tokens'] !== null)
    settings.kv_cache_max_tokens = integer('kv_cache_max_tokens', raw['kv_cache_max_tokens'], 1, 16_777_216)
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
  const generation: VllmGenerationDefaults = {}
  for (const [name, key] of Object.entries(GENERATION_KEYS) as [keyof VllmGenerationDefaults, string][]) {
    if (raw[key] !== undefined && raw[key] !== null) generation[name] = GENERATION_RULES[name](key, raw[key])
  }
  settings.generation = generation
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
  if (merged['kv_cache_max_tokens'] === 0) merged['kv_cache_max_tokens'] = null
  if (merged['max_num_batched_tokens'] === 0) merged['max_num_batched_tokens'] = null
  if (merged['seed'] === 0) merged['seed'] = null
  for (const key of Object.values(GENERATION_KEYS)) {
    if (typeof merged[key] === 'string' && merged[key].trim() === '') merged[key] = null
  }
  return validateVllmSettings(merged)
}
