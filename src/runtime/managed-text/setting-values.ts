/**
 * The value checks a managed provider's settings reader runs on merged stored values and a load's
 * overrides (vLLM, SGLang): a number may arrive as its text, as the app's inputs store it, and anything
 * out of range is `INVALID_ARGUMENT` naming the provider, the key and the value — before a container
 * exists.
 */
import { AtomicCoreError } from '../../contracts/index.js'

export interface SettingValues {
  invalid(key: string, value: unknown, why: string): never
  integer(key: string, value: unknown, min: number, max: number): number
  decimal(key: string, value: unknown, inRange: (n: number) => boolean, range: string): number
  yesNo(key: string, value: unknown): boolean
  oneOf<T extends string>(key: string, value: unknown, allowed: readonly T[]): T
}

/** The checks, with messages that say `<provider> setting <key> …`. */
export function settingValues(provider: string): SettingValues {
  const invalid = (key: string, value: unknown, why: string): never => {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      `${provider} setting ${key} ${why}.`,
      `${key}=${JSON.stringify(value)}`
    )
  }
  const asNumber = (value: unknown): unknown =>
    typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return {
    invalid,
    integer(key, value, min, max) {
      const number = asNumber(value)
      if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) {
        return invalid(key, value, `must be a whole number from ${min} to ${max}`)
      }
      return number
    },
    decimal(key, value, inRange, range) {
      const number = asNumber(value)
      if (typeof number !== 'number' || !Number.isFinite(number) || !inRange(number)) {
        return invalid(key, value, `must be a number ${range}`)
      }
      return number
    },
    yesNo(key, value) {
      if (value === true || value === 'true') return true
      if (value === false || value === 'false') return false
      return invalid(key, value, 'must be true or false')
    },
    oneOf(key, value, allowed) {
      return allowed.includes(value as (typeof allowed)[number])
        ? (value as (typeof allowed)[number])
        : invalid(key, value, `must be one of ${allowed.join(', ')}`)
    },
  }
}
