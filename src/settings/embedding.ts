/**
 * The `embedding` section of `settings.json`: the embedding model's configuration
 * (ADR 2026-10-07-embedding-models-are-their-own-core-module). Pure, and the same two tempers as the
 * decision section: `embeddingSettingsOf` keeps the default for any value a hand edit broke, and
 * `parseEmbeddingSettingsPatch` refuses an unknown key or a bad value from the control API with
 * `INVALID_ARGUMENT`.
 */

import { AtomicCoreError, DEFAULT_EMBEDDING_SETTINGS, EMBEDDING_POOLINGS } from '../contracts/index.js'
import type { EmbeddingSettings } from '../contracts/index.js'

type Kind = 'boolean' | 'string' | { min: number; max: number } | { oneOf: readonly string[] }

/** The keys, their types and their ranges. */
const SCHEMA: Record<keyof EmbeddingSettings, Kind> = {
  enabled: 'boolean',
  model_path: 'string',
  mmproj_path: 'string',
  model_id: 'string',
  // 0 = automatic; past 1 Mi tokens no input is real, only an allocation that fails.
  ctx_size: { min: 0, max: 1 << 20 },
  pooling: { oneOf: ['', ...EMBEDDING_POOLINGS] },
  image_max_tokens: { min: 0, max: 1 << 16 },
  threads: { min: 0, max: 256 },
  idle_unload_secs: { min: 0, max: 7 * 24 * 3600 },
  startup_timeout_secs: { min: 1, max: 3600 },
  engine_path: 'string',
}

const KEYS = Object.keys(SCHEMA) as Array<keyof EmbeddingSettings>

function coerce(kind: Kind, value: unknown): unknown {
  if (kind === 'boolean') {
    if (typeof value === 'boolean') return value
    if (value === 'true' || value === 'false') return value === 'true'
    return undefined
  }
  if (kind === 'string') return typeof value === 'string' ? value.trim() : undefined
  if ('oneOf' in kind) {
    const s = typeof value === 'string' ? value.trim().toLowerCase() : undefined
    return s !== undefined && kind.oneOf.includes(s) ? s : undefined
  }
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < kind.min || n > kind.max) return undefined
  return n
}

function describe(kind: Kind): string {
  if (kind === 'boolean') return 'a boolean'
  if (kind === 'string') return 'a string'
  if ('oneOf' in kind) return `one of ${kind.oneOf.map((v) => (v === '' ? "''" : v)).join(', ')}`
  return `an integer from ${kind.min} to ${kind.max}`
}

/** The section as stored, defaults for anything missing or unusable. Unknown keys are dropped here, kept on disk. */
export function embeddingSettingsOf(raw: unknown): EmbeddingSettings {
  const record = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  const out = { ...DEFAULT_EMBEDDING_SETTINGS } as Record<string, unknown>
  for (const key of KEYS) {
    const value = coerce(SCHEMA[key], (record as Record<string, unknown>)[key])
    if (value !== undefined) out[key] = value
  }
  return out as unknown as EmbeddingSettings
}

/** A control-API patch, checked: only known keys, each of its type and range. `undefined` values are skipped. */
export function parseEmbeddingSettingsPatch(patch: unknown): Partial<EmbeddingSettings> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch))
    throw new AtomicCoreError('INVALID_ARGUMENT', 'The embedding settings must be a JSON object.')
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (!(KEYS as string[]).includes(key))
      throw new AtomicCoreError(
        'INVALID_ARGUMENT',
        `Unknown embedding setting '${key}'.`,
        `known: ${KEYS.join(', ')}`
      )
    if (value === undefined) continue
    const kind = SCHEMA[key as keyof EmbeddingSettings]
    const coerced = coerce(kind, value)
    if (coerced === undefined)
      throw new AtomicCoreError(
        'INVALID_ARGUMENT',
        `The embedding setting '${key}' must be ${describe(kind)}.`,
        `got ${JSON.stringify(value)}`
      )
    out[key] = coerced
  }
  return out as Partial<EmbeddingSettings>
}
