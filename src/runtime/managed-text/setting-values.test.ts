import { describe, expect, it } from 'vitest'
import { settingValues } from './setting-values.js'

describe('settingValues', () => {
  const { integer, decimal, yesNo, oneOf } = settingValues('engine')

  it('reads a number or its text, a flag or its text, and one of a list', () => {
    expect(integer('n', '4', 1, 8)).toBe(4)
    expect(decimal('f', '0.5', (n) => n > 0 && n < 1, 'between 0 and 1')).toBe(0.5)
    expect(yesNo('b', 'false')).toBe(false)
    expect(oneOf('mode', 'on', ['on', 'off'])).toBe('on')
  })

  it('refuses with INVALID_ARGUMENT naming the provider, the key and the value', () => {
    expect(() => integer('n', 0, 1, 8)).toThrow(
      expect.objectContaining({
        code: 'INVALID_ARGUMENT',
        message: 'engine setting n must be a whole number from 1 to 8.',
        details: 'n=0',
      })
    )
    expect(() => integer('n', '1.5', 1, 8)).toThrow(/whole number/)
    expect(() => decimal('f', 'x', () => true, 'at all')).toThrow(/f must be a number at all/)
    expect(() => yesNo('b', 1)).toThrow(/b must be true or false/)
    expect(() => oneOf('mode', 'auto', ['on', 'off'])).toThrow(/mode must be one of on, off/)
  })
})
