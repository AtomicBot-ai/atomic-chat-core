import { expect, it } from 'vitest'
import { canonicalizeSettingValues, settingsSchema } from './schema.js'
import { parseStrataSettings } from './strata-settings.js'
it('publishes canonical Strata settings with one GPU and conservative defaults', () => {
  const defaults = Object.fromEntries(settingsSchema('strata').map((d) => [d.key, d.controllerProps.value]))
  expect(parseStrataSettings(defaults)).toEqual({
    context_length: 0,
    gpu_id: '',
    memory_mode: 'auto',
    parallel_requests: 1,
    vision: 'auto',
    timeout: 1800,
  })
  expect(
    parseStrataSettings(
      canonicalizeSettingValues('strata', { context_length: '4096', parallel_requests: '2' })
    )
  ).toMatchObject({ context_length: 4096, parallel_requests: 2 })
})
it.each([
  { args: ['--experts', '2'] },
  { env: {} },
  { memory_mode: 'fast' },
  { gpu_id: ['a', 'b'] },
  { parallel_requests: 0 },
  { context_length: -1 },
  { timeout: Infinity },
  { vision: 'on' },
])('rejects unsafe or unsupported settings %j', (patch) => {
  expect(() => parseStrataSettings(patch)).toThrow()
})
