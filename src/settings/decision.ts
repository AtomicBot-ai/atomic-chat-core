/**
 * The `decision` section of `settings.json`: the decision model's configuration
 * (ADR 2026-09-30-the-decision-model-is-its-own-core-module). Pure: the store reads and writes it,
 * the decision module only ever sees the canonical `DecisionSettings`.
 *
 * Two readers with different tempers. A hand-edited file must never stop the core from starting, so
 * `decisionSettingsOf` keeps the default for any value it cannot use. A write through the control API
 * is a caller's mistake worth telling, so `parseDecisionSettingsPatch` refuses unknown keys and bad
 * values with `INVALID_ARGUMENT`.
 */

import { AtomicCoreError, DECISION_CONVERT_TYPES, DEFAULT_DECISION_SETTINGS } from '../contracts/index.js'
import type { DecisionSettings } from '../contracts/index.js'

type Kind = 'boolean' | 'string' | { min: number; max: number } | { oneOf: readonly string[] }

/** The keys, their types and their ranges. Ranges pin what the engine and the fail-open budget can take. */
const SCHEMA: Record<keyof DecisionSettings, Kind> = {
  enabled: 'boolean',
  model_path: 'string',
  model_id: 'string',
  spec_path: 'string',
  threads: { min: 0, max: 256 },
  // A budget under 1 ms cannot be met; over a minute it is not a fail-open budget any more.
  timeout_ms: { min: 1, max: 60_000 },
  idle_unload_secs: { min: 0, max: 7 * 24 * 3600 },
  startup_timeout_secs: { min: 1, max: 3600 },
  allow_uncalibrated: 'boolean',
  engine_path: 'string',
  convert_type: { oneOf: DECISION_CONVERT_TYPES },
}

const KEYS = Object.keys(SCHEMA) as Array<keyof DecisionSettings>

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
  if ('oneOf' in kind) return `one of ${kind.oneOf.join(', ')}`
  return `an integer from ${kind.min} to ${kind.max}`
}

/** The section as stored, defaults for anything missing or unusable. Unknown keys are dropped here, kept on disk. */
export function decisionSettingsOf(raw: unknown): DecisionSettings {
  const record = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  const out = { ...DEFAULT_DECISION_SETTINGS } as Record<string, unknown>
  for (const key of KEYS) {
    const value = coerce(SCHEMA[key], (record as Record<string, unknown>)[key])
    if (value !== undefined) out[key] = value
  }
  return out as unknown as DecisionSettings
}

/** A control-API patch, checked: only known keys, each of its type and range. `undefined` values are skipped. */
export function parseDecisionSettingsPatch(patch: unknown): Partial<DecisionSettings> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch))
    throw new AtomicCoreError('INVALID_ARGUMENT', 'The decision settings must be a JSON object.')
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (!(KEYS as string[]).includes(key))
      throw new AtomicCoreError(
        'INVALID_ARGUMENT',
        `Unknown decision setting '${key}'.`,
        `known: ${KEYS.join(', ')}`
      )
    if (value === undefined) continue
    const kind = SCHEMA[key as keyof DecisionSettings]
    const coerced = coerce(kind, value)
    if (coerced === undefined)
      throw new AtomicCoreError(
        'INVALID_ARGUMENT',
        `The decision setting '${key}' must be ${describe(kind)}.`,
        `got ${JSON.stringify(value)}`
      )
    out[key] = coerced
  }
  return out as Partial<DecisionSettings>
}
