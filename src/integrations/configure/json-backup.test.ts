import { describe, expect, it } from 'vitest'
import { configDirFrom, isOurServerUrl, outputCap, ourServerFromUrl, redo } from './json-backup.js'
import type { JsonObject } from './json-tree.js'

describe('json-backup', () => {
  it('caps output at a quarter of the window, at most 8192', () => {
    expect(outputCap(16384)).toBe(4096)
    expect(outputCap(32768)).toBe(8192)
    expect(outputCap(262144)).toBe(8192)
    expect(outputCap(1001)).toBe(250)
  })

  it('takes a config directory only when it is absolute or ~-relative', () => {
    expect(configDirFrom(undefined, '/home/u')).toBeUndefined()
    expect(configDirFrom('  ', '/home/u')).toBeUndefined()
    expect(configDirFrom('relative/dir', '/home/u')).toBeUndefined()
    expect(configDirFrom('~', '/home/u')).toBe('/home/u')
    expect(configDirFrom('~/cc', '/home/u')).toBe('/home/u/cc')
    expect(configDirFrom('/opt/cc', '/home/u')).toBe('/opt/cc')
    expect(configDirFrom('C:\\Users\\u\\cc', '/home/u')).toBe('C:\\Users\\u\\cc')
  })

  it('matches this server by exact host and port, or loopback with its port', () => {
    const lan = ourServerFromUrl('http://192.168.1.20:1337')
    for (const url of [
      'http://192.168.1.20:1337',
      'http://127.0.0.1:1337/v1',
      'http://localhost:1337',
      'http://[::1]:1337',
      'localhost:1337',
    ]) {
      expect(isOurServerUrl(lan, url), url).toBe(true)
    }
    for (const url of [
      'http://192.168.1.21:1337',
      'http://192.168.1.20:4000',
      'http://127.0.0.1:1338',
      'http://localhost',
      'https://api.anthropic.com',
      '',
    ]) {
      expect(isOurServerUrl(lan, url), url).toBe(false)
    }
    expect(isOurServerUrl(ourServerFromUrl('http://0.0.0.0:1337'), 'http://127.0.0.1:1337')).toBe(true)
    expect(isOurServerUrl(undefined, 'http://127.0.0.1:1337')).toBe(false)
  })

  it('undoes a previous connect before recording, so a value the user changed becomes theirs', () => {
    const root: JsonObject = { env: { A: 'user' } }
    const first = redo(root, undefined, true, [[['env', 'A'], 'ours']], [], () => {})
    expect(first.entries[0]).toEqual({ path: ['env', 'A'], existed: true, previous: 'user', written: 'ours' })
    ;(root['env'] as JsonObject)['A'] = 'changed'
    const second = redo(root, first, true, [[['env', 'A'], 'ours']], [], () => {})
    expect(second.entries[0]).toMatchObject({ existed: true, previous: 'changed' })
    expect(root).toEqual({ env: { A: 'ours' } })
  })
})
