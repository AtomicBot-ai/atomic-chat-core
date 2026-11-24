/**
 * Incremental line reader for Server-Sent Event streams: reassembles lines across network reads and
 * pre-parses `data:` payloads, while keeping each line's original bytes so a relay can forward the
 * stream unchanged.
 *
 * Ported from: src-tauri/src/core/server/sse.rs.
 */

import type { JsonValue } from '../shims/index.js'

/** Beyond this a "line" is assumed not to be SSE; it is flushed instead of buffered. */
const MAX_LINE_BYTES = 1024 * 1024

export type SseData = { kind: 'done' } | { kind: 'json'; json: JsonValue } | { kind: 'raw'; text: string }

export type SseLine = { kind: 'data'; raw: Buffer; payload: SseData } | { kind: 'other'; raw: Buffer }

export class SseLineReader {
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
  }

  /** The next complete line, or `undefined` when more bytes are needed. */
  nextLine(): SseLine | undefined {
    const pos = this.buf.indexOf(0x0a)
    if (pos < 0) {
      if (this.buf.length >= MAX_LINE_BYTES) return { kind: 'other', raw: this.takeTail() }
      return undefined
    }
    const raw = this.buf.subarray(0, pos + 1)
    this.buf = this.buf.subarray(pos + 1)
    return classify(raw)
  }

  /** Unterminated bytes left at the end of the stream. */
  takeTail(): Buffer {
    const tail = this.buf
    this.buf = Buffer.alloc(0)
    return tail
  }
}

/** A unit of a resumable stream: one complete event, or comment lines that only keep the line busy. */
export type FramedSse = { kind: 'event'; bytes: Buffer } | { kind: 'comment'; bytes: Buffer }

const COLON = 0x3a
const LF = 0x0a

/** The field a raw line names (`data`, `id`, …), `''` for a comment; per the SSE spec, nothing is trimmed. */
function fieldName(raw: Buffer): string {
  if (raw[0] === COLON) return ''
  const colon = raw.indexOf(COLON)
  const end = colon >= 0 ? colon : raw.length
  return raw
    .subarray(0, Math.min(end, 16))
    .toString('latin1')
    .replace(/[\r\n]+$/, '')
}

/**
 * Groups the lines of an SSE stream (as {@link SseLineReader} hands them over) into events, so a
 * resumable run can number each one and replay it on its own.
 *
 * An event is a block of lines with at least one `data` field, ended by a blank line; its `bytes`
 * are the block with its terminator, ready for an `id:` line in front. Any `id:` the upstream sent
 * is dropped, or it would override the number the run gives the event. A block without `data` is
 * never passed on as a block: once a stream carries ids, the OpenAI Python SDK turns every blank
 * line after one into an event and fails to parse its empty data. Only its comment lines survive,
 * without the blank line, so a keep-alive still reaches the client; other fields in it (llama.cpp's
 * old `error:` line) were ignored by every client and are dropped. Stray blank lines are dropped.
 */
export class SseEventFramer {
  private lines: Buffer[] = []
  private hasData = false
  /** The last line pushed had no line end: the next push continues it (a line over 1 MiB). */
  private midLine = false
  /** The line being continued is one that is dropped. */
  private dropping = false

  push(raw: Buffer): FramedSse[] {
    const continuing = this.midLine
    this.midLine = raw[raw.length - 1] !== LF
    if (continuing) {
      const last = this.lines.length - 1
      if (!this.dropping && last >= 0) this.lines[last] = Buffer.concat([this.lines[last] as Buffer, raw])
      return []
    }
    this.dropping = false
    if (raw.toString('latin1').trim() === '') {
      // Whitespace has nothing to continue: whatever follows starts a line of its own.
      this.midLine = false
      return this.close(raw)
    }
    const field = fieldName(raw)
    if (field === 'id') {
      this.dropping = true
      return []
    }
    if (field === 'data') this.hasData = true
    this.lines.push(raw)
    return []
  }

  /** The end of the stream: the unterminated tail, then a block the upstream never closed. */
  end(tail: Buffer): FramedSse[] {
    const out = tail.length > 0 ? this.push(tail) : []
    if (this.lines.length === 0) return out
    const last = this.lines.length - 1
    const line = this.lines[last] as Buffer
    if (line[line.length - 1] !== LF) this.lines[last] = Buffer.concat([line, Buffer.from('\n')])
    return [...out, ...this.close(Buffer.from('\n'))]
  }

  private close(terminator: Buffer): FramedSse[] {
    const lines = this.lines
    const hasData = this.hasData
    this.lines = []
    this.hasData = false
    if (lines.length === 0) return []
    if (hasData) return [{ kind: 'event', bytes: Buffer.concat([...lines, terminator]) }]
    const comments = lines.filter((line) => line[0] === COLON)
    return comments.length > 0 ? [{ kind: 'comment', bytes: Buffer.concat(comments) }] : []
  }
}

function classify(raw: Buffer): SseLine {
  const text = raw.toString('utf8').trim()
  if (!text.startsWith('data:')) return { kind: 'other', raw }
  const data = text.slice('data:'.length).trim()
  if (data === '[DONE]') return { kind: 'data', raw, payload: { kind: 'done' } }
  try {
    return { kind: 'data', raw, payload: { kind: 'json', json: JSON.parse(data) as JsonValue } }
  } catch {
    return { kind: 'data', raw, payload: { kind: 'raw', text: data } }
  }
}
