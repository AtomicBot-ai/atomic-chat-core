import { expect, it } from 'vitest'
import { flmLaunchSettings } from './launch-settings.js'

it('keeps model-specific prefill defaults and supplies the supported launch defaults', () => {
  expect(flmLaunchSettings({}, 32768)).toEqual({
    context: 32768,
    args: [
      '--ctx-len',
      '32768',
      '--pmode',
      'performance',
      '--prefix-cache-mb',
      '4096',
      '--prefix-slots',
      '8',
      '--prefix-min-gain',
      '128',
    ],
  })
})
it('normalizes context and prefill, and preserves zero cache slots and gain', () => {
  expect(
    flmLaunchSettings(
      {
        ctx_len: 8000,
        pmode: 'balanced',
        prefill_chunk_len: 5000,
        prefix_cache_mb: 2048,
        prefix_slots: 0,
        prefix_min_gain: 0,
      },
      32768
    )
  ).toEqual({
    context: 8192,
    args: [
      '--ctx-len',
      '8192',
      '--pmode',
      'balanced',
      '--prefill-chunk-len',
      '8192',
      '--prefix-cache-mb',
      '2048',
      '--prefix-slots',
      '0',
      '--prefix-min-gain',
      '0',
    ],
  })
})
it.each([
  [1, 32768, 512],
  [65536, 32768, 32768],
  [40000, 40960, 32768],
  [0, 40960, 32768],
])('reports the actual power-of-two context for %s with model limit %s', (ctx_len, limit, context) => {
  expect(flmLaunchSettings({ ctx_len }, limit).context).toBe(context)
})
it.each([
  { pmode: 'fast' },
  { ctx_len: -1 },
  { ctx_len: 1.5 },
  { ctx_len: Infinity },
  { prefill_chunk_len: -1 },
  { prefix_cache_mb: NaN },
  { prefix_slots: 33 },
  { prefix_slots: 1.5 },
  { prefix_min_gain: -1 },
  { prefix_slots: true },
])('rejects invalid launch settings %j before starting FLM', (settings) => {
  expect(() => flmLaunchSettings(settings, 32768)).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGUMENT' })
  )
})
