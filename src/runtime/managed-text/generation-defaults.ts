/**
 * Sampling defaults a managed provider applies to a request that sets none (change
 * `add-vllm-runtime`, owner's decision after the live run): the settings `default_temperature`,
 * `default_top_p`, `default_top_k`, `default_min_p` and `default_repetition_penalty`, read once for
 * every engine. vLLM receives them in `--override-generation-config`; TensorRT-LLM, which has no such
 * launch option, gets them from the session gateway, written into a request that names none. `''`
 * (or nothing stored) is "not set" — the model's own default stands; a request's own value always wins.
 */
import { AtomicCoreError } from '../../contracts/index.js'

/** In the names both engines' sampling parameters use. */
export interface GenerationDefaults {
  temperature?: number
  top_p?: number
  top_k?: number
  min_p?: number
  repetition_penalty?: number
}

/** The stored key of each default, by its sampling-parameter name. */
export const GENERATION_DEFAULT_KEYS = {
  temperature: 'default_temperature',
  top_p: 'default_top_p',
  top_k: 'default_top_k',
  min_p: 'default_min_p',
  repetition_penalty: 'default_repetition_penalty',
} as const

type Name = keyof GenerationDefaults

/** The bounds both engines accept (vLLM's `SamplingParams._verify_args`; TRT-LLM's are looser). */
const RULES: Record<Name, { valid: (n: number) => boolean; range: string }> = {
  temperature: { valid: (n) => n >= 0 && n <= 2, range: 'a number from 0 to 2' },
  top_p: { valid: (n) => n > 0 && n <= 1, range: 'a number above 0 and up to 1' },
  top_k: { valid: (n) => Number.isInteger(n) && n >= -1 && n <= 1_000_000, range: 'a whole number from -1' },
  min_p: { valid: (n) => n >= 0 && n <= 1, range: 'a number from 0 to 1' },
  repetition_penalty: { valid: (n) => n > 0 && n <= 10, range: 'a number above 0 and up to 10' },
}

/**
 * The defaults `raw` sets, validated; `INVALID_ARGUMENT` for one out of range. `raw` holds the stored
 * keys (`default_temperature`, …); a value may be a number or its text, `''`/`null` is not set.
 */
export function readGenerationDefaults(provider: string, raw: Record<string, unknown>): GenerationDefaults {
  const defaults: GenerationDefaults = {}
  for (const [name, key] of Object.entries(GENERATION_DEFAULT_KEYS) as [Name, string][]) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.trim() === '') continue
    const number = typeof value === 'string' ? Number(value) : value
    if (typeof number !== 'number' || !Number.isFinite(number) || !RULES[name].valid(number)) {
      throw new AtomicCoreError(
        'INVALID_ARGUMENT',
        `${provider} setting ${key} must be ${RULES[name].range}.`,
        `${key}=${JSON.stringify(value)}`
      )
    }
    defaults[name] = number
  }
  return defaults
}

/** `body` with every default it does not set itself. */
export function withGenerationDefaults(
  body: Record<string, unknown>,
  defaults: GenerationDefaults
): Record<string, unknown> {
  const missing = Object.entries(defaults).filter(([name]) => body[name] === undefined || body[name] === null)
  return missing.length === 0 ? body : { ...body, ...Object.fromEntries(missing) }
}
