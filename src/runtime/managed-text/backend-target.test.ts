import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import { projectSessionPort } from './backend-target.js'
import type { BackendTarget } from './types.js'

const target = (base_url: string): BackendTarget => ({ base_url })

describe('projectSessionPort', () => {
  it('accepts a plain http target on exactly 127.0.0.1 with a root path', () => {
    expect(projectSessionPort(target('http://127.0.0.1:34521'))).toBe(34521)
  })

  it('accepts an explicit root path', () => {
    expect(projectSessionPort(target('http://127.0.0.1:34521/'))).toBe(34521)
  })

  const refused: Array<[string, string]> = [
    ['localhost instead of the literal 127.0.0.1', 'http://localhost:34521'],
    ['the IPv6 loopback spelling', 'http://[::1]:34521'],
    ['a neighboring loopback address', 'http://127.0.0.2:34521'],
    ['the unspecified address', 'http://0.0.0.0:34521'],
    ['a private LAN host', 'http://10.0.0.5:34521'],
    ['a public host', 'http://example.com:34521'],
    ['https instead of http', 'https://127.0.0.1:34521'],
    ['a non-root path', 'http://127.0.0.1:34521/v1'],
    ['a port above the valid range', 'http://127.0.0.1:99999'],
    ['no explicit port', 'http://127.0.0.1'],
    ['embedded credentials', 'http://user:pass@127.0.0.1:34521'],
    ['a query string', 'http://127.0.0.1:34521?x=1'],
    ['a fragment', 'http://127.0.0.1:34521#frag'],
    ['a value that is not a URL at all', 'not a url'],
  ]

  for (const [label, baseUrl] of refused) {
    it(`refuses ${label}`, () => {
      expect(() => projectSessionPort(target(baseUrl))).toThrow(AtomicCoreError)
      try {
        projectSessionPort(target(baseUrl))
        expect.unreachable()
      } catch (error) {
        expect(error).toBeInstanceOf(AtomicCoreError)
        expect((error as AtomicCoreError).code).toBe('FORBIDDEN_HOST')
      }
    })
  }
})
