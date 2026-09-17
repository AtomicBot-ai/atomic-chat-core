import { describe, expect, it } from 'vitest'
import { extractHostFromOrigin, isValidHost, removePrefix } from './gates.js'

describe('removePrefix', () => {
  it('strips the prefix as a string, not a path segment', () => {
    expect(removePrefix('/v1models', '/v1')).toBe('/models')
    expect(removePrefix('/v1', '/v1')).toBe('/')
    expect(removePrefix('/other', '/v1')).toBe('/other')
    expect(removePrefix('/models', '')).toBe('/models')
  })
})

describe('isValidHost', () => {
  it('matches trusted hosts with and without ports, and bracketed IPv6', () => {
    expect(isValidHost('[fe80::1]:8080', ['[fe80::1]'])).toBe(true)
    expect(isValidHost('lan.example:1', ['lan.example:9999'])).toBe(true)
    expect(isValidHost('LOCALHOST:1337', [])).toBe(true)
    expect(isValidHost('', ['lan.example'])).toBe(false)
    expect(isValidHost('', ['*'])).toBe(true)
  })

  it('does not trust the IPv6 loopback by default', () => {
    expect(isValidHost('[::1]:1337', [])).toBe(false)
  })
})

describe('extractHostFromOrigin', () => {
  it('keeps host and port and drops scheme and path', () => {
    expect(extractHostFromOrigin('http://a.example:3000/path')).toBe('a.example:3000')
    expect(extractHostFromOrigin('null')).toBe('null')
  })
})
