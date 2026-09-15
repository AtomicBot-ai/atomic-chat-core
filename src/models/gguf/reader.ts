/**
 * GGUF header reader. Port of `tauri-plugin-llamacpp-upstream/src/gguf/{helpers,types}.rs`.
 *
 * Reads magic, version, tensor count and the metadata KV block only — never the tensor table.
 * Every value is stringified the way the Rust reader does (`to_string()`, `[a, b]` for arrays of
 * up to 24 elements, a placeholder for longer ones), so downstream code sees identical strings.
 *
 * Pure over a byte buffer; callers feed it a file prefix and grow it while it asks for more.
 */

import { formatRustF32, formatRustF64 } from '../../util/index.js'

export interface GgufMetadata {
  version: number
  tensor_count: number
  metadata: Record<string, string>
}

export const GGUF_VALUE_TYPE_NAMES = [
  'Uint8',
  'Int8',
  'Uint16',
  'Int16',
  'Uint32',
  'Int32',
  'Float32',
  'Bool',
  'String',
  'Array',
  'Uint64',
  'Int64',
  'Float64',
] as const

export const MAX_GGUF_STRING_BYTES = 1024 * 1024
export const MAX_GGUF_ARRAY_LEN = 1_000_000
export const INLINE_ARRAY_MAX_LEN = 24

/** The buffer ended before the header did; feed more bytes and retry. */
export class GgufNeedMoreData extends Error {
  constructor() {
    super('GGUF header incomplete')
    this.name = 'GgufNeedMoreData'
  }
}

/** The bytes are not a GGUF header the reader understands (same messages as the Rust reader). */
export class GgufParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GgufParseError'
  }
}

class Cursor {
  private pos = 0
  private readonly view: DataView
  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  }
  private need(n: number) {
    if (this.pos + n > this.buf.byteLength) throw new GgufNeedMoreData()
  }
  u8() {
    this.need(1)
    return this.view.getUint8(this.pos++)
  }
  i8() {
    this.need(1)
    return this.view.getInt8(this.pos++)
  }
  u16() {
    this.need(2)
    const v = this.view.getUint16(this.pos, true)
    this.pos += 2
    return v
  }
  i16() {
    this.need(2)
    const v = this.view.getInt16(this.pos, true)
    this.pos += 2
    return v
  }
  u32() {
    this.need(4)
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }
  i32() {
    this.need(4)
    const v = this.view.getInt32(this.pos, true)
    this.pos += 4
    return v
  }
  f32() {
    this.need(4)
    const v = this.view.getFloat32(this.pos, true)
    this.pos += 4
    return v
  }
  u64(): bigint {
    this.need(8)
    const v = this.view.getBigUint64(this.pos, true)
    this.pos += 8
    return v
  }
  i64(): bigint {
    this.need(8)
    const v = this.view.getBigInt64(this.pos, true)
    this.pos += 8
    return v
  }
  f64() {
    this.need(8)
    const v = this.view.getFloat64(this.pos, true)
    this.pos += 8
    return v
  }
  bytes(n: number): Uint8Array {
    this.need(n)
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }
  skip(n: number) {
    this.need(n)
    this.pos += n
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

function readString(c: Cursor): string {
  const len = c.u64()
  if (len > BigInt(MAX_GGUF_STRING_BYTES))
    throw new GgufParseError(`String length ${len} is unreasonably large`)
  const raw = c.bytes(Number(len))
  try {
    return utf8.decode(raw)
  } catch {
    throw new GgufParseError('invalid utf-8 sequence')
  }
}

function valueType(n: number): number {
  if (n < 0 || n >= GGUF_VALUE_TYPE_NAMES.length) throw new GgufParseError(`Unknown GGUF value type: ${n}`)
  return n
}

function readValue(c: Cursor, type: number): string {
  switch (type) {
    case 0:
      return String(c.u8())
    case 1:
      return String(c.i8())
    case 2:
      return String(c.u16())
    case 3:
      return String(c.i16())
    case 4:
      return String(c.u32())
    case 5:
      return String(c.i32())
    case 6:
      return formatRustF32(c.f32())
    case 7:
      return c.u8() !== 0 ? 'true' : 'false'
    case 8:
      return readString(c)
    case 10:
      return c.u64().toString()
    case 11:
      return c.i64().toString()
    case 12:
      return formatRustF64(c.f64())
    case 9: {
      const elemType = valueType(c.u32())
      const len = c.u64()
      if (len > BigInt(MAX_GGUF_ARRAY_LEN))
        throw new GgufParseError(`Array length ${len} is unreasonably large`)
      const n = Number(len)
      if (n > INLINE_ARRAY_MAX_LEN) {
        skipArray(c, elemType, n)
        return `<Array of type ${GGUF_VALUE_TYPE_NAMES[elemType]} with ${n} elements, data skipped>`
      }
      const elems: string[] = []
      for (let i = 0; i < n; i++) elems.push(readValue(c, elemType))
      return `[${elems.join(', ')}]`
    }
    default:
      throw new GgufParseError(`Unknown GGUF value type: ${type}`)
  }
}

function skipArray(c: Cursor, elemType: number, len: number) {
  switch (elemType) {
    case 0:
    case 1:
    case 7:
      c.skip(len)
      return
    case 2:
    case 3:
      c.skip(len * 2)
      return
    case 4:
    case 5:
    case 6:
      c.skip(len * 4)
      return
    case 10:
    case 11:
    case 12:
      c.skip(len * 8)
      return
    case 8:
      for (let i = 0; i < len; i++) c.skip(Number(c.u64()))
      return
    case 9:
      // Nested arrays are read (not skipped), exactly like the Rust reader.
      for (let i = 0; i < len; i++) readValue(c, elemType)
      return
    default:
      throw new GgufParseError(`Unknown GGUF value type: ${elemType}`)
  }
}

/**
 * Parse the header from `bytes`. Throws `GgufNeedMoreData` when the buffer is too short and
 * `GgufParseError` when the bytes are not a valid header.
 */
export function readGgufMetadata(bytes: Uint8Array): GgufMetadata {
  const c = new Cursor(bytes)
  const magic = c.bytes(4)
  if (!(magic[0] === 0x47 && magic[1] === 0x47 && magic[2] === 0x55 && magic[3] === 0x46)) {
    throw new GgufParseError('Not a GGUF file')
  }
  const version = c.u32()
  const tensorCount = c.u64()
  const metadataCount = c.u64()
  const metadata: Record<string, string> = {}
  for (let i = 0n; i < metadataCount; i++) {
    try {
      const key = readString(c)
      const type = valueType(c.u32())
      metadata[key] = readValue(c, type)
    } catch (e) {
      if (e instanceof GgufNeedMoreData) throw e
      throw new GgufParseError(`Error reading metadata entry ${i}: ${(e as Error).message}`)
    }
  }
  return { version, tensor_count: Number(tensorCount), metadata }
}

/**
 * Drive `readGgufMetadata` over a source that yields the file in growing prefixes (a local file
 * read in chunks, or HTTP range requests). `readPrefix(byteLength)` returns at least what it can;
 * a prefix shorter than requested means EOF.
 */
export async function readGgufMetadataChunked(
  readPrefix: (byteLength: number) => Promise<Uint8Array>,
  options: { chunkSize?: number; maxBytes?: number } = {}
): Promise<GgufMetadata> {
  const chunk = options.chunkSize ?? 2 * 1024 * 1024
  const max = options.maxBytes ?? 120 * 1024 * 1024
  let want = chunk
  for (;;) {
    const bytes = await readPrefix(Math.min(want, max))
    try {
      return readGgufMetadata(bytes)
    } catch (e) {
      if (!(e instanceof GgufNeedMoreData)) throw e
      if (bytes.byteLength < Math.min(want, max) || want >= max) {
        throw new GgufParseError('Could not parse GGUF metadata from downloaded data')
      }
      want += chunk
    }
  }
}
