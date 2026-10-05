/**
 * Synthetic GGUF files: a header with metadata and a tensor table whose data offsets reproduce a
 * chosen bits-per-weight, followed by zero-filled tensor data. Small enough to write in a test, real
 * enough for the tensor-table reader and the compatibility check (PrismML types 41/42/142/143,
 * `prism.hadamard.*` keys, Q2_0 group-64 vs the legacy group-128 layout).
 */

export type GgufMetaValue = string | number | boolean | { u64: bigint } | { strings: string[] }

export interface GgufTensorSpec {
  name: string
  /** ggml type id (0 F32, 1 F16, 41 Q1_0, 42 Q2_0, 142 PQ2_0, 143 PTQ1_0 …). */
  type: number
  dims: number[]
  /** Bits per weight of the data this tensor occupies. */
  bitsPerWeight: number
}

export interface GgufSpec {
  version?: number
  metadata?: Record<string, GgufMetaValue>
  tensors: GgufTensorSpec[]
  alignment?: number
}

/**
 * Bits per weight measured on the real Hugging Face files (Range reads of the Bonsai headers):
 * 2.25 is Q2_0 group-64, 2.125 the legacy group-128 layout; PQ2_0 2.125, PTQ1_0 1.75.
 */
export const BPW = { q2_g64: 2.25, q2_g128: 2.125, pq2_0: 2.125, ptq1_0: 1.75, q1_0: 1.125, f16: 16, f32: 32 }

class Writer {
  private chunks: Buffer[] = []
  get length(): number {
    return this.chunks.reduce((n, c) => n + c.length, 0)
  }
  u32(v: number) {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(v)
    this.chunks.push(b)
  }
  u64(v: bigint | number) {
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(BigInt(v))
    this.chunks.push(b)
  }
  str(s: string) {
    const bytes = Buffer.from(s, 'utf8')
    this.u64(bytes.length)
    this.chunks.push(bytes)
  }
  raw(b: Buffer) {
    this.chunks.push(b)
  }
  done(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

function writeValue(w: Writer, value: GgufMetaValue) {
  if (typeof value === 'string') {
    w.u32(8)
    w.str(value)
  } else if (typeof value === 'boolean') {
    w.u32(7)
    w.raw(Buffer.from([value ? 1 : 0]))
  } else if (typeof value === 'number') {
    w.u32(4)
    w.u32(value)
  } else if ('u64' in value) {
    w.u32(10)
    w.u64(value.u64)
  } else {
    w.u32(9)
    w.u32(8)
    w.u64(value.strings.length)
    for (const s of value.strings) w.str(s)
  }
}

/** The whole file: header, tensor table, padding, tensor data. */
export function buildGguf(spec: GgufSpec): Buffer {
  const alignment = spec.alignment ?? 32
  const metadata = { ...(spec.metadata ?? {}) }
  if (spec.alignment !== undefined) metadata['general.alignment'] = spec.alignment
  const w = new Writer()
  w.raw(Buffer.from('GGUF', 'ascii'))
  w.u32(spec.version ?? 3)
  w.u64(spec.tensors.length)
  w.u64(Object.keys(metadata).length)
  for (const [key, value] of Object.entries(metadata)) {
    w.str(key)
    writeValue(w, value)
  }
  let offset = 0
  const sizes: number[] = []
  for (const t of spec.tensors) {
    w.str(t.name)
    w.u32(t.dims.length)
    for (const d of t.dims) w.u64(d)
    w.u32(t.type)
    w.u64(offset)
    const elements = t.dims.reduce((a, b) => a * b, 1)
    const size = Math.ceil((elements * t.bitsPerWeight) / 8)
    sizes.push(size)
    offset += Math.ceil(size / alignment) * alignment
  }
  const headerLength = w.length
  w.raw(Buffer.alloc(Math.ceil(headerLength / alignment) * alignment - headerLength))
  sizes.forEach((size) => w.raw(Buffer.alloc(Math.ceil(size / alignment) * alignment)))
  return w.done()
}

/** A one-architecture model of `layers` blocks, all weights of one ggml type. */
export function bonsaiLikeGguf(options: {
  weightType: number
  bitsPerWeight: number
  layers?: number
  metadata?: Record<string, GgufMetaValue>
}): Buffer {
  const tensors: GgufTensorSpec[] = [
    { name: 'token_embd.weight', type: 1, dims: [256, 512], bitsPerWeight: BPW.f16 },
  ]
  for (let i = 0; i < (options.layers ?? 4); i++) {
    tensors.push({ name: `blk.${i}.attn_norm.weight`, type: 0, dims: [256], bitsPerWeight: BPW.f32 })
    tensors.push({
      name: `blk.${i}.attn_q.weight`,
      type: options.weightType,
      dims: [256, 1024],
      bitsPerWeight: options.bitsPerWeight,
    })
    tensors.push({
      name: `blk.${i}.ffn_up.weight`,
      type: options.weightType,
      dims: [256, 2048],
      bitsPerWeight: options.bitsPerWeight,
    })
  }
  return buildGguf({
    metadata: { 'general.architecture': 'qwen3', 'general.name': 'Bonsai', ...(options.metadata ?? {}) },
    tensors,
  })
}
