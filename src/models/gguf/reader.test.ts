import { describe, expect, it } from 'vitest'
import { GgufNeedMoreData, GgufParseError, readGgufMetadata, readGgufMetadataChunked } from './reader.js'

// ── tiny GGUF writer for tests ───────────────────────────────────────────────
type V =
  | { t: 'u8'; v: number }
  | { t: 'i32'; v: number }
  | { t: 'u32'; v: number }
  | { t: 'f32'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'str'; v: string }
  | { t: 'u64'; v: bigint }
  | { t: 'i64'; v: bigint }
  | { t: 'f64'; v: number }
  | { t: 'arr'; elem: number; items: V[] }

const TYPE: Record<string, number> = {
  u8: 0,
  i32: 5,
  u32: 4,
  f32: 6,
  bool: 7,
  str: 8,
  arr: 9,
  u64: 10,
  i64: 11,
  f64: 12,
}

class W {
  private parts: Uint8Array[] = []
  u8(v: number) {
    this.parts.push(new Uint8Array([v]))
  }
  u32(v: number) {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, v, true)
    this.parts.push(b)
  }
  i32(v: number) {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setInt32(0, v, true)
    this.parts.push(b)
  }
  f32(v: number) {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setFloat32(0, v, true)
    this.parts.push(b)
  }
  u64(v: bigint) {
    const b = new Uint8Array(8)
    new DataView(b.buffer).setBigUint64(0, v, true)
    this.parts.push(b)
  }
  i64(v: bigint) {
    const b = new Uint8Array(8)
    new DataView(b.buffer).setBigInt64(0, v, true)
    this.parts.push(b)
  }
  f64(v: number) {
    const b = new Uint8Array(8)
    new DataView(b.buffer).setFloat64(0, v, true)
    this.parts.push(b)
  }
  str(s: string) {
    const bytes = new TextEncoder().encode(s)
    this.u64(BigInt(bytes.length))
    this.parts.push(bytes)
  }
  value(v: V) {
    switch (v.t) {
      case 'u8':
        return this.u8(v.v)
      case 'i32':
        return this.i32(v.v)
      case 'u32':
        return this.u32(v.v)
      case 'f32':
        return this.f32(v.v)
      case 'bool':
        return this.u8(v.v ? 1 : 0)
      case 'str':
        return this.str(v.v)
      case 'u64':
        return this.u64(v.v)
      case 'i64':
        return this.i64(v.v)
      case 'f64':
        return this.f64(v.v)
      case 'arr':
        this.u32(v.elem)
        this.u64(BigInt(v.items.length))
        for (const it of v.items) this.value(it)
        return
    }
  }
  bytes(): Uint8Array {
    const len = this.parts.reduce((n, p) => n + p.length, 0)
    const out = new Uint8Array(len)
    let o = 0
    for (const p of this.parts) {
      out.set(p, o)
      o += p.length
    }
    return out
  }
}

function gguf(
  entries: [string, V][],
  opts: { magic?: string; version?: number; tensors?: bigint } = {}
): Uint8Array {
  const w = new W()
  w['parts'].push(new TextEncoder().encode(opts.magic ?? 'GGUF'))
  w.u32(opts.version ?? 3)
  w.u64(opts.tensors ?? 291n)
  w.u64(BigInt(entries.length))
  for (const [k, v] of entries) {
    w.str(k)
    w.u32(TYPE[v.t] as number)
    w.value(v)
  }
  return w.bytes()
}

describe('readGgufMetadata', () => {
  it('reads header fields and stringifies every scalar like Rust', () => {
    const meta = readGgufMetadata(
      gguf([
        ['general.architecture', { t: 'str', v: 'llama' }],
        ['llama.block_count', { t: 'u32', v: 32 }],
        ['neg', { t: 'i32', v: -7 }],
        ['small', { t: 'u8', v: 200 }],
        ['flag', { t: 'bool', v: true }],
        ['f32', { t: 'f32', v: 0.1 }],
        ['f64', { t: 'f64', v: 1e21 }],
        ['big', { t: 'u64', v: 18446744073709551615n }],
        ['negbig', { t: 'i64', v: -9223372036854775808n }],
      ])
    )
    expect(meta.version).toBe(3)
    expect(meta.tensor_count).toBe(291)
    expect(meta.metadata).toEqual({
      'general.architecture': 'llama',
      'llama.block_count': '32',
      'neg': '-7',
      'small': '200',
      'flag': 'true',
      'f32': '0.1',
      'f64': '1000000000000000000000',
      'big': '18446744073709551615',
      'negbig': '-9223372036854775808',
    })
  })

  it('inlines arrays up to 24 elements and skips longer ones with the Rust placeholder', () => {
    const short = { t: 'arr' as const, elem: 5, items: [1, 2, 3].map((v) => ({ t: 'i32' as const, v })) }
    const long = {
      t: 'arr' as const,
      elem: 8,
      items: Array.from({ length: 25 }, (_, i) => ({ t: 'str' as const, v: `t${i}` })),
    }
    const nested = { t: 'arr' as const, elem: 9, items: [short, short] }
    const meta = readGgufMetadata(
      gguf([
        ['short', short],
        ['long', long],
        ['after', { t: 'str', v: 'still-readable' }],
        ['nested', nested],
      ])
    )
    expect(meta.metadata['short']).toBe('[1, 2, 3]')
    expect(meta.metadata['long']).toBe('<Array of type String with 25 elements, data skipped>')
    expect(meta.metadata['after']).toBe('still-readable')
    expect(meta.metadata['nested']).toBe('[[1, 2, 3], [1, 2, 3]]')
  })

  it('rejects a wrong magic, unknown types and oversized strings with the Rust messages', () => {
    expect(() => readGgufMetadata(gguf([], { magic: 'GGML' }))).toThrow(new GgufParseError('Not a GGUF file'))
    const badType = gguf([['k', { t: 'u8', v: 1 }]])
    badType.set([99, 0, 0, 0], badType.length - 5) // overwrite the value-type u32 (5 bytes from end: type(4)+u8(1))
    expect(() => readGgufMetadata(badType)).toThrow(
      /Error reading metadata entry 0: Unknown GGUF value type: 99/
    )
    const w = new W()
    w['parts'].push(new TextEncoder().encode('GGUF'))
    w.u32(3)
    w.u64(0n)
    w.u64(1n)
    w.u64(BigInt(2 * 1024 * 1024)) // key length too large
    expect(() => readGgufMetadata(w.bytes())).toThrow(/String length 2097152 is unreasonably large/)
  })

  it('asks for more data when the buffer is truncated', () => {
    const full = gguf([['general.architecture', { t: 'str', v: 'llama' }]])
    expect(() => readGgufMetadata(full.subarray(0, 20))).toThrow(GgufNeedMoreData)
    expect(() => readGgufMetadata(full.subarray(0, full.length - 1))).toThrow(GgufNeedMoreData)
  })

  it('readGgufMetadataChunked grows the prefix until the header parses and gives up at EOF', async () => {
    const full = gguf([
      ['general.architecture', { t: 'str', v: 'llama' }],
      ['pad', { t: 'str', v: 'x'.repeat(100) }],
    ])
    const reads: number[] = []
    const meta = await readGgufMetadataChunked(
      async (n) => {
        reads.push(n)
        return full.subarray(0, Math.min(n, full.length))
      },
      { chunkSize: 16 }
    )
    expect(meta.metadata['general.architecture']).toBe('llama')
    expect(reads.length).toBeGreaterThan(1)
    await expect(
      readGgufMetadataChunked(async (n) => full.subarray(0, Math.min(n, 30)), { chunkSize: 16 })
    ).rejects.toThrow('Could not parse GGUF metadata from downloaded data')
  })
})
