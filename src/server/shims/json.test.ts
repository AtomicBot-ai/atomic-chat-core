import { describe, expect, it } from 'vitest'
import { isJsonObject, serdeToString } from './json.js'

describe('isJsonObject', () => {
  it('accepts a plain object and nothing that merely has typeof "object"', () => {
    expect(isJsonObject({ a: 1 })).toBe(true)
    expect(isJsonObject(null)).toBe(false)
    expect(isJsonObject([])).toBe(false)
    expect(isJsonObject('x')).toBe(false)
  })
})

describe('serdeToString', () => {
  it("prints compact JSON with sorted keys and numbers the way serde_json's ryu does", () => {
    expect(serdeToString({ b: [1, 1.5, true, null], a: 'x' })).toBe('{"a":"x","b":[1,1.5,true,null]}')
    expect(serdeToString(-0)).toBe('-0.0')
    expect(serdeToString(Number.NaN)).toBe('null')
    expect(serdeToString(1e21)).toBe('1e21')
    expect(serdeToString(1.5e300)).toBe('1.5e300')
    expect(serdeToString(1e-7)).toBe('1e-7')
    expect(serdeToString(0.001)).toBe('0.001')
    expect(serdeToString(123.456)).toBe('123.456')
  })

  it('sorts keys by code point, shorter prefix first', () => {
    expect(serdeToString({ ab: 1, a: 2, é: 3, Z: 4 })).toBe('{"Z":4,"a":2,"ab":1,"é":3}')
  })

  it('prints integers outside i64/u64 and small fractions as floats', () => {
    expect(serdeToString(2 ** 70)).toBe('1.1805916207174113e21')
    expect(serdeToString(-1e20)).toBe('-1e20')
    expect(serdeToString(1.25e-5)).toBe('0.0000125')
    expect(serdeToString(1.5e-7)).toBe('1.5e-7')
    expect(serdeToString(-(2 ** 63))).toBe('-9223372036854775808')
  })
})
