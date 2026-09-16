import { describe, expect, it } from 'vitest'
import { asJsonArray, asJsonObject } from './json-tree.js'

describe('asJsonObject', () => {
  it.each([
    ['a plain object', {}, true],
    ['a populated object', { a: 1 }, true],
    ['null', null, false],
    ['an array', [1, 2], false],
    ['a string', 'nope', false],
    ['a number', 42, false],
    ['a boolean', true, false],
    ['undefined', undefined, false],
  ])('treats %s as an object: %s', (_label, value, expected) => {
    expect(asJsonObject(value) !== undefined).toBe(expected)
  })

  it('returns the very same reference, so callers can mutate in place', () => {
    const value = { keep: 'me' }
    expect(asJsonObject(value)).toBe(value)
  })
})

describe('asJsonArray', () => {
  it.each([
    ['an array', [], true],
    ['an object', {}, false],
    ['null', null, false],
    ['a string', '[]', false],
  ])('treats %s as an array: %s', (_label, value, expected) => {
    expect(asJsonArray(value) !== undefined).toBe(expected)
  })

  it('returns the very same reference', () => {
    const value = [1, 2, 3]
    expect(asJsonArray(value)).toBe(value)
  })
})
