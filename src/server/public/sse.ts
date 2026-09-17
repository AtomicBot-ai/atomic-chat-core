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
