import { describe, expect, it } from 'vitest'
import { SseEventFramer, SseLineReader } from './sse.js'
import type { FramedSse } from './sse.js'

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

/** Run `input` through a line reader and the framer, as the resumable relay does. */
function frame(input: string | Buffer[]): Array<{ kind: string; text: string }> {
  const reader = new SseLineReader()
  const framer = new SseEventFramer()
  const out: FramedSse[] = []
  for (const chunk of typeof input === 'string' ? [Buffer.from(input)] : input) {
    reader.push(chunk)
    for (let line = reader.nextLine(); line; line = reader.nextLine()) out.push(...framer.push(line.raw))
  }
  out.push(...framer.end(reader.takeTail()))
  return out.map((item) => ({ kind: item.kind, text: item.bytes.toString('utf8') }))
}

describe('SseEventFramer', () => {
  it.each([
    [
      'one event per data block, with its terminator',
      'data: {"a":1}\n\ndata: [DONE]\n\n',
      [
        { kind: 'event', text: 'data: {"a":1}\n\n' },
        { kind: 'event', text: 'data: [DONE]\n\n' },
      ],
    ],
    [
      'a multi-line event with its event name, CRLF kept',
      'event: x\r\ndata: a\r\ndata: b\r\n\r\n',
      [{ kind: 'event', text: 'event: x\r\ndata: a\r\ndata: b\r\n\r\n' }],
    ],
    ['a bare `data` field', 'data\n\n', [{ kind: 'event', text: 'data\n\n' }]],
    [
      "the upstream's own id dropped, so it cannot override the run's",
      'id: 77\ndata: x\n\n',
      [{ kind: 'event', text: 'data: x\n\n' }],
    ],
    [
      'a keep-alive comment kept without its blank line, so no empty event is dispatched',
      ': ping\n\ndata: x\n\n',
      [
        { kind: 'comment', text: ': ping\n' },
        { kind: 'event', text: 'data: x\n\n' },
      ],
    ],
    [
      "a data-less block's other fields dropped (llama.cpp's old `error:` line)",
      'error: {"code":500}\n\ndata: [DONE]\n\n',
      [{ kind: 'event', text: 'data: [DONE]\n\n' }],
    ],
    ['stray blank lines dropped', '\n\ndata: x\n\n\n\n', [{ kind: 'event', text: 'data: x\n\n' }]],
    [
      'a comment inside a data block kept in it',
      'data: x\n: note\n\n',
      [{ kind: 'event', text: 'data: x\n: note\n\n' }],
    ],
    [
      'an unterminated last event closed at the end of the stream',
      'data: x\n\ndata: [DONE]',
      [
        { kind: 'event', text: 'data: x\n\n' },
        { kind: 'event', text: 'data: [DONE]\n\n' },
      ],
    ],
    [
      'a terminated last line without its blank line closed at the end',
      'data: [DONE]\n',
      [{ kind: 'event', text: 'data: [DONE]\n\n' }],
    ],
    ['a whitespace tail with nothing open', 'data: x\n\n \r', [{ kind: 'event', text: 'data: x\n\n' }]],
  ])('%s', (_label, input, expected) => {
    expect(frame(input)).toEqual(expected)
  })

  it('rejoins a line longer than the reader holds, and drops the continuation of an id line', () => {
    const big = 'x'.repeat(1024 * 1024)
    const chunks = [
      Buffer.from(`data: ${big}`),
      Buffer.from('tail\n\n'),
      Buffer.from(`id: ${big}`),
      Buffer.from('7\ndata: y\n\n'),
    ]
    expect(frame(chunks)).toEqual([
      { kind: 'event', text: `data: ${big}tail\n\n` },
      { kind: 'event', text: 'data: y\n\n' },
    ])
  })

  it('treats over-long whitespace as a line of its own, never as the start of one', () => {
    const framer = new SseEventFramer()
    expect(framer.push(Buffer.from(' '.repeat(16)))).toEqual([])
    expect(framer.push(Buffer.from('data: x\n'))).toEqual([])
    expect(framer.end(Buffer.alloc(0)).map((i) => i.bytes.toString())).toEqual(['data: x\n\n'])
  })
})
