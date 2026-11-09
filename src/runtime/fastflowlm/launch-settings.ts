import { AtomicCoreError } from '../../contracts/index.js'

const modes = ['powersaver', 'balanced', 'performance', 'turbo'] as const
const rounded = (value: number) => 2 ** Math.ceil(Math.log2(Math.max(512, value)))

/** Validate settings at the launch boundary, including per-load overrides. */
export function flmLaunchSettings(settings: Record<string, unknown>, modelContext: number) {
  const integer = (key: string, fallback: number, max: number): number => {
    const value = settings[key] ?? fallback
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max)
      throw new AtomicCoreError('INVALID_ARGUMENT', `FastFlowLM ${key} must be an integer from 0 to ${max}.`)
    return value
  }
  const requested = integer('ctx_len', 0, 1048576)
  const prefill = integer('prefill_chunk_len', 0, 1048576)
  const cache = integer('prefix_cache_mb', 4096, 2147483647)
  const slots = integer('prefix_slots', 8, 32)
  const gain = integer('prefix_min_gain', 128, 2147483647)
  const mode = settings.pmode ?? 'performance'
  if (!modes.some((m) => m === mode))
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      'FastFlowLM pmode must be powersaver, balanced, performance or turbo.'
    )
  if (!Number.isSafeInteger(modelContext) || modelContext < 512)
    throw new AtomicCoreError(
      'FASTFLOWLM_INVALID_INSTALLATION',
      'FastFlowLM requires a model context of at least 512 tokens.'
    )
  // FLM rounds up. Clamp to a supported power of two so rounding cannot exceed the model's limit.
  const ceiling = 2 ** Math.floor(Math.log2(modelContext))
  const context = Math.min(ceiling, rounded(requested || modelContext))
  return {
    context,
    args: [
      '--ctx-len',
      String(context),
      '--pmode',
      String(mode),
      ...(prefill ? ['--prefill-chunk-len', String(rounded(prefill))] : []),
      '--prefix-cache-mb',
      String(cache),
      '--prefix-slots',
      String(slots),
      '--prefix-min-gain',
      String(gain),
    ],
  }
}
