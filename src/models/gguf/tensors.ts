/**
 * Bounded GGUF tensor-table reader: what a file is made of, for the engine-compatibility check.
 *
 * `reader.ts` reads the metadata block only and keeps the Rust reader's string contract; this reads
 * past it into the tensor infos (name, dims, ggml type, data offset) without touching tensor data,
 * and summarises them per ggml type: how many tensors, how many weights and — from the distance
 * between consecutive data offsets — how many bytes, hence bits per weight. Bits per weight is what
 * tells two layouts sharing one type id apart (Q2_0 group-64 at 2.25 vs the legacy group-128 at 2.125).
 *
 * Pure over a byte buffer like `reader.ts`; `readGgufTensorSummaryChunked` grows the prefix (a local
 * file or HTTP ranges). Every count and length is bounded, so a hostile header cannot make it
 * allocate or loop without limit.
 */

import { GgufNeedMoreData, GgufParseError } from './reader.js'

export const MAX_GGUF_TENSORS = 200_000
export const MAX_GGUF_TENSOR_DIMS = 8
export const MAX_GGUF_METADATA_ENTRIES = 1_000_000
const MAX_STRING_BYTES = 1024 * 1024
const MAX_ARRAY_LEN = 50_000_000
const DEFAULT_ALIGNMENT = 32

export interface GgufTensorTypeSummary {
  /** ggml tensor type id (`0` F32, `1` F16, `41` Q1_0, `42` Q2_0, `142` PQ2_0, `143` PTQ1_0 …). */
  type: number
  tensors: number
  /** Weights across those tensors. */
  elements: number
  /** Bytes of the tensors whose size is known (every one but the last without `fileSize`). */
  bytes: number
  /** Weights of exactly the tensors counted in `bytes`. */
  sizedElements: number
  /** `bytes * 8 / sizedElements`, `null` when no tensor of the type has a known size. */
  bitsPerWeight: number | null
}

export interface GgufTensorSummary {
  version: number
  tensorCount: number
  /** Scalar metadata stringified (`String(value)`); arrays appear as `[array]`. */
  metadata: Record<string, string>
  alignment: number
  /** Absolute file offset where tensor data starts. */
  dataOffset: number
  types: GgufTensorTypeSummary[]
}

class Cursor {
  pos = 0
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
  u32() {
    this.need(4)
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }
  /** A u64 that must fit a JS number below `limit`. */
  u64(limit = Number.MAX_SAFE_INTEGER, what = 'value'): number {
    this.need(8)
    const v = this.view.getBigUint64(this.pos, true)
    this.pos += 8
    if (v > BigInt(limit)) throw new GgufParseError(`${what} ${v} is unreasonably large`)
    return Number(v)
  }
  scalar(type: number): string {
    switch (type) {
      case 0:
        return String(this.u8())
      case 1:
        this.need(1)
        return String(this.view.getInt8(this.pos++))
      case 2:
      case 3: {
        this.need(2)
        const v = type === 2 ? this.view.getUint16(this.pos, true) : this.view.getInt16(this.pos, true)
        this.pos += 2
        return String(v)
      }
      case 4:
        return String(this.u32())
      case 5: {
        this.need(4)
        const v = this.view.getInt32(this.pos, true)
        this.pos += 4
        return String(v)
      }
      case 6: {
        this.need(4)
        const v = this.view.getFloat32(this.pos, true)
        this.pos += 4
        return String(v)
      }
      case 7:
        return this.u8() !== 0 ? 'true' : 'false'
      case 8:
        return this.string()
      case 10:
      case 11: {
        this.need(8)
        const v = type === 10 ? this.view.getBigUint64(this.pos, true) : this.view.getBigInt64(this.pos, true)
        this.pos += 8
        return v.toString()
      }
      case 12: {
        this.need(8)
        const v = this.view.getFloat64(this.pos, true)
        this.pos += 8
        return String(v)
      }
      default:
        throw new GgufParseError(`Unknown GGUF value type: ${type}`)
    }
  }
  string(): string {
    const len = this.u64(MAX_STRING_BYTES, 'String length')
    this.need(len)
    const raw = this.buf.subarray(this.pos, this.pos + len)
    this.pos += len
    return new TextDecoder('utf-8').decode(raw)
  }
  skip(n: number) {
    this.need(n)
    this.pos += n
  }
  skipValue(type: number, depth = 0): void {
    if (type !== 9) {
      const width = [1, 1, 2, 2, 4, 4, 4, 1, -1, -1, 8, 8, 8][type]
      if (width === undefined) throw new GgufParseError(`Unknown GGUF value type: ${type}`)
      if (width > 0) this.skip(width)
      else this.skip(this.u64(MAX_STRING_BYTES, 'String length'))
      return
    }
    if (depth > 4) throw new GgufParseError('GGUF arrays nested too deeply')
    const elem = this.u32()
    const len = this.u64(MAX_ARRAY_LEN, 'Array length')
    const width = [1, 1, 2, 2, 4, 4, 4, 1, -1, -1, 8, 8, 8][elem]
    if (width === undefined) throw new GgufParseError(`Unknown GGUF value type: ${elem}`)
    if (width > 0) this.skip(len * width)
    else for (let i = 0; i < len; i++) this.skipValue(elem, depth + 1)
  }
}

/**
 * Summarise the tensor table in `bytes` (a prefix of the file). `fileSize`, when known, sizes the
 * last tensor too. Throws `GgufNeedMoreData` for a prefix that ends inside the table and
 * `GgufParseError` for anything that is not a sane GGUF header.
 */
export function readGgufTensorSummary(
  bytes: Uint8Array,
  options: { fileSize?: number } = {}
): GgufTensorSummary {
  const c = new Cursor(bytes)
  if (c.u8() !== 0x47 || c.u8() !== 0x47 || c.u8() !== 0x55 || c.u8() !== 0x46) {
    throw new GgufParseError('Not a GGUF file')
  }
  const version = c.u32()
  if (version < 2) throw new GgufParseError(`Unsupported GGUF version ${version}`)
  const tensorCount = c.u64(MAX_GGUF_TENSORS, 'Tensor count')
  const metadataCount = c.u64(MAX_GGUF_METADATA_ENTRIES, 'Metadata count')

  const metadata: Record<string, string> = {}
  for (let i = 0; i < metadataCount; i++) {
    const key = c.string()
    const type = c.u32()
    if (type === 9) {
      c.skipValue(9)
      metadata[key] = '[array]'
    } else {
      metadata[key] = c.scalar(type)
    }
  }
  const alignmentRaw = Number(metadata['general.alignment'] ?? DEFAULT_ALIGNMENT)
  const alignment =
    Number.isInteger(alignmentRaw) && alignmentRaw > 0 && alignmentRaw % 8 === 0
      ? alignmentRaw
      : DEFAULT_ALIGNMENT

  const infos: Array<{ type: number; elements: number; offset: number }> = []
  for (let i = 0; i < tensorCount; i++) {
    c.string()
    const dims = c.u32()
    if (dims < 1 || dims > MAX_GGUF_TENSOR_DIMS)
      throw new GgufParseError(`Tensor ${i} has ${dims} dimensions`)
    let elements = 1
    for (let d = 0; d < dims; d++) {
      elements *= c.u64(Number.MAX_SAFE_INTEGER, 'Tensor dimension')
      if (!Number.isSafeInteger(elements)) throw new GgufParseError(`Tensor ${i} has too many elements`)
    }
    const type = c.u32()
    const offset = c.u64(Number.MAX_SAFE_INTEGER, 'Tensor offset')
    infos.push({ type, elements, offset })
  }
  const dataOffset = Math.ceil(c.pos / alignment) * alignment

  const sorted = [...infos].sort((a, b) => a.offset - b.offset)
  const dataSize = options.fileSize !== undefined ? options.fileSize - dataOffset : undefined
  const byType = new Map<number, GgufTensorTypeSummary>()
  sorted.forEach((t, i) => {
    const next = sorted[i + 1]?.offset ?? dataSize
    const size = next !== undefined && next >= t.offset ? next - t.offset : undefined
    const entry = byType.get(t.type) ?? {
      type: t.type,
      tensors: 0,
      elements: 0,
      bytes: 0,
      sizedElements: 0,
      bitsPerWeight: null,
    }
    entry.tensors += 1
    entry.elements += t.elements
    if (size !== undefined && t.elements > 0) {
      entry.bytes += size
      entry.sizedElements += t.elements
    }
    byType.set(t.type, entry)
  })
  const types = [...byType.values()]
    .map((t) => ({ ...t, bitsPerWeight: t.sizedElements > 0 ? (t.bytes * 8) / t.sizedElements : null }))
    .sort((a, b) => a.type - b.type)

  return { version, tensorCount, metadata, alignment, dataOffset, types }
}

/**
 * `readGgufTensorSummary` over growing prefixes (`readPrefix(n)` returns up to `n` bytes; fewer
 * means EOF). Bonsai headers are 6–12 MB, so the default reads 4 MB at a time up to 64 MB.
 */
export async function readGgufTensorSummaryChunked(
  readPrefix: (byteLength: number) => Promise<Uint8Array>,
  options: { fileSize?: number; chunkSize?: number; maxBytes?: number; growth?: 'linear' | 'doubling' } = {}
): Promise<GgufTensorSummary> {
  const chunk = options.chunkSize ?? 4 * 1024 * 1024
  const max = options.maxBytes ?? 64 * 1024 * 1024
  // `linear` adds a chunk per read; `doubling` starts small and doubles, for a reader that pays per
  // request (HTTP ranges): a 64 KiB header takes one request, a 12 MiB one eight.
  const next = (want: number) => (options.growth === 'doubling' ? want * 2 : want + chunk)
  let want = chunk
  for (;;) {
    const limit = Math.min(want, max)
    const bytes = await readPrefix(limit)
    try {
      return readGgufTensorSummary(
        bytes,
        options.fileSize !== undefined ? { fileSize: options.fileSize } : {}
      )
    } catch (e) {
      if (!(e instanceof GgufNeedMoreData)) throw e
      if (bytes.byteLength < limit || want >= max) {
        throw new GgufParseError('Could not read the GGUF tensor table within the read budget')
      }
      want = next(want)
    }
  }
}
