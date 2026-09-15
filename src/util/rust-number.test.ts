import { describe, expect, it } from 'vitest'
import {
  expandExponent,
  f32Differs,
  floatAsU64,
  formatRustF32,
  formatRustF64,
  parseRustF64,
  parseRustI32,
  parseRustU64,
  saturatingSub,
} from './rust-number.js'

describe('parsers', () => {
  it.each([
    ['33', 33],
    ['+5', 5],
    ['-7', -7],
    ['2147483647', 2147483647],
    ['2147483648', undefined],
    ['1.5', undefined],
    ['', undefined],
    [' 3', undefined],
  ])('parseRustI32(%j) = %j', (s, e) => expect(parseRustI32(s)).toBe(e))

  it.each([
    ['0', 0],
    ['+42', 42],
    ['-1', undefined],
    ['18446744073709551615', Number(18446744073709551615n)],
    ['18446744073709551616', undefined],
    ['4e3', undefined],
  ])('parseRustU64(%j) = %j', (s, e) => expect(parseRustU64(s)).toBe(e))

  it.each([
    ['4096', 4096],
    ['4155.99', 4155.99],
    ['.5', 0.5],
    ['5.', 5],
    ['1e3', 1000],
    ['-2.5E-1', -0.25],
    ['inf', Infinity],
    ['-Infinity', -Infinity],
    ['n/a', undefined],
    ['', undefined],
  ])('parseRustF64(%j) = %j', (s, e) => expect(parseRustF64(s)).toBe(e))
  it('parses NaN', () => expect(Number.isNaN(parseRustF64('NaN') as number)).toBe(true))
})

describe('formatters', () => {
  it.each([
    ['1e+21', '1000000000000000000000'],
    ['1.5e+3', '1500'],
    ['1e-7', '0.0000001'],
    ['-2.5e-3', '-0.0025'],
    ['12.5', '12.5'],
  ])('expandExponent(%j) = %j', (s, e) => expect(expandExponent(s)).toBe(e))

  it.each([
    [0.5, '0.5'],
    [2.0, '2'],
    [10000.0, '10000'],
    [0.10000000149011612, '0.1'],
    [0.3, '0.3'],
    [-0.25, '-0.25'],
    [123456792, '123456790'],
    [Infinity, 'inf'],
    [-Infinity, '-inf'],
    [NaN, 'NaN'],
  ])('formatRustF32(%s) = %j', (v, s) => expect(formatRustF32(v)).toBe(s))

  it.each([
    [1, '1'],
    [0.1, '0.1'],
    [1e21, '1000000000000000000000'],
    [1e-7, '0.0000001'],
    [Infinity, 'inf'],
    [NaN, 'NaN'],
  ])('formatRustF64(%s) = %j', (v, s) => expect(formatRustF64(v)).toBe(s))
})

describe('arithmetic helpers', () => {
  it('f32Differs uses f32 epsilon', () => {
    expect(f32Differs(0.10000000149011612, 0.1)).toBe(false)
    expect(f32Differs(0.5, 0.1)).toBe(true)
    expect(f32Differs(1.0000001, 1.0)).toBe(false)
  })
  it('floatAsU64 truncates, floors negatives and NaN to 0, saturates', () => {
    expect(floatAsU64(4155.99 * 1024 * 1024)).toBe(Math.trunc(4155.99 * 1024 * 1024))
    expect(floatAsU64(-1)).toBe(0)
    expect(floatAsU64(NaN)).toBe(0)
    expect(floatAsU64(1e30)).toBe(Number.MAX_SAFE_INTEGER)
  })
  it('saturatingSub never goes negative', () => {
    expect(saturatingSub(5, 3)).toBe(2)
    expect(saturatingSub(3, 5)).toBe(0)
  })
})
