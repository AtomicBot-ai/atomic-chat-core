import { describe, expect, it } from 'vitest'
import { SseLineReader } from './sse.js'

describe('SseLineReader', () => {
  it('reassembles lines across reads, parses data payloads and keeps the original bytes', () => {
    const reader = new SseLineReader()
    reader.push(Buffer.from('dat'))
    expect(reader.nextLine()).toBeUndefined()
    reader.push(Buffer.from('a: {"a":1}\r\n: comment\ndata: [DONE]\ndata: plain\n'))

    const lines = [reader.nextLine(), reader.nextLine(), reader.nextLine(), reader.nextLine()]

    expect(lines.map((l) => (l?.kind === 'data' ? l.payload : l?.kind))).toEqual([
      { kind: 'json', json: { a: 1 } },
      'other',
      { kind: 'done' },
      { kind: 'raw', text: 'plain' },
    ])
    expect(lines[0]?.raw.toString()).toBe('data: {"a":1}\r\n')
  })

  it('hands back an unterminated tail, and flushes a line too long to be SSE', () => {
    const reader = new SseLineReader()
    reader.push(Buffer.from('tail'))
    expect(reader.takeTail().toString()).toBe('tail')

    reader.push(Buffer.alloc(1024 * 1024, 0x61))
    expect(reader.nextLine()).toMatchObject({ kind: 'other' })
    expect(reader.takeTail().length).toBe(0)
  })
})
