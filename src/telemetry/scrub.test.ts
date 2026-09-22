import { describe, expect, it } from 'vitest'
import { REDACTED, headline, scrubText, scrubValue } from './scrub.js'

describe('scrubText', () => {
  it.each([
    ['/Users/misha/Work/Atomic/app.log', `/Users/${REDACTED}/Work/Atomic/app.log`],
    ['/home/misha/data', `/home/${REDACTED}/data`],
    ['C:\\Users\\misha\\AppData', `C:\\Users\\${REDACTED}\\AppData`],
    ['C:/Users/misha/AppData', `C:/Users/${REDACTED}/AppData`],
    ['http://user:pass@proxy.local:8080/path', `http://${REDACTED}@proxy.local:8080/path`],
    ['token=hf_AbC123def', `token=${REDACTED}`],
    ['Authorization: Bearer abc.def', `Authorization: Bearer ${REDACTED}`],
    ['key sk-ant-api03-xyz_1 and sk-proj-abcdefghijkl', `key ${REDACTED} and ${REDACTED}`],
    ['google AIzaSyA1234567890abcdefghijk', `google ${REDACTED}`],
    ['gh ghp_abcdef123', `gh ${REDACTED}`],
    ['jwt eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl', `jwt ${REDACTED}`],
    ['https://h/x?api_key=secret&x=1&sig=abc', `https://h/x?api_key=${REDACTED}&x=1&sig=${REDACTED}`],
    ['mail me at a.b+c@example.co.uk', 'mail me at <email>'],
    ['https://quiet-owl-bird.trycloudflare.com/v1', 'https://<tunnel>.trycloudflare.com/v1'],
    ['LAN 192.168.1.23:1337, loop 127.0.0.1, any 0.0.0.0', 'LAN <ip>:1337, loop 127.0.0.1, any 0.0.0.0'],
  ])('%s', (input, expected) => {
    expect(scrubText(input)).toBe(expected)
  })

  it('leaves versions and build numbers alone', () => {
    expect(scrubText('Windows 10.0.22631.4317, CUDA 12.4.1, b6795')).toBe(
      'Windows 10.0.22631.4317, CUDA 12.4.1, b6795'
    )
  })

  it('replaces the data folder before the home folder, in both slash styles', () => {
    const context = { dataFolder: 'C:\\Users\\misha\\Atomic Chat\\data', homeDir: 'C:\\Users\\misha' }
    expect(scrubText('C:/Users/misha/Atomic Chat/data/models/a.gguf', context)).toBe('<data>/models/a.gguf')
    expect(scrubText('C:\\Users\\misha\\Desktop\\b.gguf', context)).toBe('~\\Desktop\\b.gguf')
  })

  it('ignores a folder too short to be one', () => {
    expect(scrubText('/a/b', { dataFolder: '/', homeDir: '' })).toBe('/a/b')
  })
})

describe('scrubValue', () => {
  it('drops sensitive keys and scrubs every nested string', () => {
    expect(
      scrubValue({
        api_key: 'abc',
        nested: { Authorization: 'x', path: '/home/bob/x', list: ['/Users/al/y', 3, null] },
        ok: true,
      })
    ).toEqual({
      api_key: REDACTED,
      nested: {
        Authorization: REDACTED,
        path: `/home/${REDACTED}/x`,
        list: [`/Users/${REDACTED}/y`, 3, null],
      },
      ok: true,
    })
  })
})

describe('headline', () => {
  it('takes the first non-empty line', () => {
    expect(headline('\n  llama-server exited  \nstack…')).toBe('llama-server exited')
  })

  it('cuts a long line', () => {
    expect(headline('x'.repeat(10), 5)).toBe('xxxx…')
    expect(headline('')).toBe('')
  })
})
