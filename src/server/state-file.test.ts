import { describe, expect, it } from 'vitest'
import { DEFAULT_SERVER_STATE, parseServerState, serializeServerState, serverApiUrl } from './state-file.js'

describe('parseServerState', () => {
  const valid = { running: true, host: 'h', port: 1, prefix: '', requires_api_key: false, pid: 2 }

  it('rejects the whole file for a wrong type, a pid outside u32 or a non-object root', () => {
    expect(parseServerState(JSON.stringify({ ...valid, running: 'yes' }))).toEqual(DEFAULT_SERVER_STATE)
    expect(parseServerState(JSON.stringify({ ...valid, pid: 2 ** 32 }))).toEqual(DEFAULT_SERVER_STATE)
    expect(parseServerState('[]')).toEqual(DEFAULT_SERVER_STATE)
    expect(parseServerState(JSON.stringify(valid))).toEqual(valid)
  })

  it('writes fields in declaration order whatever order they were given in', () => {
    const shuffled = { pid: 0, prefix: '/v1', port: 1337, host: 'x', running: false, requires_api_key: true }
    expect(Object.keys(JSON.parse(serializeServerState(shuffled)) as object)).toEqual([
      'running',
      'host',
      'port',
      'prefix',
      'requires_api_key',
      'pid',
    ])
    expect(serverApiUrl({ host: '0.0.0.0', port: 8080, prefix: '' })).toBe('http://127.0.0.1:8080')
  })
})
