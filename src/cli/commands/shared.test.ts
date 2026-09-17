import { describe, expect, it } from 'vitest'
import { apiUrl, baseUrl, formatBytes } from './shared.js'

describe('url helpers', () => {
  it('dials loopback for a server bound to every interface', () => {
    const state = {
      running: true,
      host: '0.0.0.0',
      port: 1337,
      prefix: '/v1',
      requires_api_key: false,
      pid: 1,
    }
    expect(baseUrl(state)).toBe('http://127.0.0.1:1337')
    expect(apiUrl(state)).toBe('http://127.0.0.1:1337/v1')
    expect(apiUrl({ ...state, host: '192.168.1.5', prefix: '' })).toBe('http://192.168.1.5:1337')
  })

  it('formats sizes the way the table expects', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(3_221_225_472)).toBe('3.0 GB')
  })
})
