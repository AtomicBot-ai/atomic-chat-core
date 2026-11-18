import { AtomicCoreError } from '../contracts/index.js'
import type { StrataMemoryMode } from '../contracts/index.js'
export interface StrataSettings {
  context_length: number
  gpu_id: string
  memory_mode: StrataMemoryMode
  parallel_requests: number
  vision: 'auto' | 'off'
  timeout: number
}
const defaults: StrataSettings = {
  context_length: 0,
  gpu_id: '',
  memory_mode: 'auto',
  parallel_requests: 1,
  vision: 'auto',
  timeout: 1800,
}
/** Global bounds only; the selected model/build imposes stricter launch limits. */
export function parseStrataSettings(raw: Record<string, unknown>): StrataSettings {
  const v = { ...defaults, ...raw }
  const integer = (key: keyof StrataSettings, min: number, max: number) =>
    typeof v[key] === 'number' &&
    Number.isSafeInteger(v[key]) &&
    Number(v[key]) >= min &&
    Number(v[key]) <= max
  if (
    Object.keys(raw).some((k) => !Object.hasOwn(defaults, k)) ||
    !integer('context_length', 0, 2147483647) ||
    !integer('parallel_requests', 1, 32) ||
    !integer('timeout', 1, 86400) ||
    typeof v.gpu_id !== 'string' ||
    v.gpu_id.length > 256 ||
    [...v.gpu_id].some((c) => c.charCodeAt(0) < 32) ||
    !['auto', 'ram', 'ssd'].includes(String(v.memory_mode)) ||
    !['auto', 'off'].includes(String(v.vision))
  )
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      'Invalid Strata settings; raw arguments and environment overrides are not supported.'
    )
  return v as StrataSettings
}
