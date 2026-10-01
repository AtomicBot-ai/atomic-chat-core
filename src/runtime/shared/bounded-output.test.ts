import { describe, expect, it } from 'vitest'
import { HeadAndTail } from './bounded-output.js'

const fed = (limit: number, ...chunks: string[]): HeadAndTail => {
  const buffer = new HeadAndTail(limit)
  for (const chunk of chunks) buffer.push(Buffer.from(chunk, 'utf8'))
  return buffer
}

describe('HeadAndTail', () => {
  it('keeps everything that fits, byte for byte', () => {
    expect(fed(64, 'one\n', 'two\n').text()).toBe('one\ntwo\n')
  })

  it('past the cap keeps the whole lines of the start and of the end, and drops the middle', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${String(i).padStart(2, '0')}\n`)
    const text = fed(40, ...lines).text()

    expect(text.startsWith('line 00\n')).toBe(true)
    expect(text.endsWith('line 49\n')).toBe(true)
    expect(text).not.toContain('line 25')
    // Every line kept is whole: no fragment without its start or its end.
    for (const line of text.trimEnd().split('\n')) expect(line).toMatch(/^line \d\d$/)
  })

  it('hands back the kept bytes undecoded, for a stream that is not UTF-8', () => {
    const utf16 = Buffer.from('ok\r\n', 'utf16le')
    const buffer = new HeadAndTail(64)
    buffer.push(utf16)
    expect(buffer.bytes().equals(utf16)).toBe(true)
  })
})
