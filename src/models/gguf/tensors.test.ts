import { describe, expect, it } from 'vitest'
import { BPW, bonsaiLikeGguf, buildGguf } from '../../../test/helpers/gguf-builder.js'
import { GgufNeedMoreData, GgufParseError } from './reader.js'
import { readGgufTensorSummary, readGgufTensorSummaryChunked } from './tensors.js'

const typeOf = (bytes: Buffer, type: number, fileSize = bytes.length) =>
  readGgufTensorSummary(bytes, { fileSize }).types.find((t) => t.type === type)

describe('readGgufTensorSummary', () => {
  it('summarises tensors per ggml type with their bits per weight', () => {
    const file = bonsaiLikeGguf({
      weightType: 142,
      bitsPerWeight: BPW.pq2_0,
      metadata: { 'prism.hadamard.version': 1 },
    })
    const summary = readGgufTensorSummary(file, { fileSize: file.length })
    expect(summary.version).toBe(3)
    expect(summary.tensorCount).toBe(13)
    expect(summary.metadata['general.architecture']).toBe('qwen3')
    expect(summary.metadata['prism.hadamard.version']).toBe('1')
    expect(summary.types.map((t) => [t.type, t.tensors])).toEqual([
      [0, 4],
      [1, 1],
      [142, 8],
    ])
    expect(typeOf(file, 142)?.bitsPerWeight).toBeCloseTo(BPW.pq2_0, 2)
    expect(typeOf(file, 1)?.bitsPerWeight).toBeCloseTo(16, 1)
  })

  it.each([
    ['group-64 Q2_0', BPW.q2_g64],
    ['legacy group-128 Q2_0', BPW.q2_g128],
  ])('tells %s apart by its bits per weight', (_label, bpw) => {
    const file = bonsaiLikeGguf({ weightType: 42, bitsPerWeight: bpw })
    expect(typeOf(file, 42)?.bitsPerWeight).toBeCloseTo(bpw, 2)
  })

  it('leaves the last tensor unsized without the file size', () => {
    const file = buildGguf({ tensors: [{ name: 'only', type: 41, dims: [4096], bitsPerWeight: BPW.q1_0 }] })
    const summary = readGgufTensorSummary(file)
    expect(summary.types[0]).toMatchObject({
      type: 41,
      tensors: 1,
      elements: 4096,
      sizedElements: 0,
      bitsPerWeight: null,
    })
  })

  it('honours general.alignment', () => {
    const file = buildGguf({
      alignment: 64,
      tensors: [{ name: 'a', type: 1, dims: [64], bitsPerWeight: BPW.f16 }],
    })
    const summary = readGgufTensorSummary(file, { fileSize: file.length })
    expect(summary.alignment).toBe(64)
    expect(summary.dataOffset % 64).toBe(0)
  })

  it('skips array metadata (a tokenizer) without reading it into memory', () => {
    const file = buildGguf({
      metadata: { 'tokenizer.ggml.tokens': { strings: ['a', 'b', 'c'] } },
      tensors: [{ name: 'a', type: 0, dims: [8], bitsPerWeight: 32 }],
    })
    expect(readGgufTensorSummary(file).metadata['tokenizer.ggml.tokens']).toBe('[array]')
  })

  it('asks for more bytes when the prefix ends inside the tensor table', () => {
    const file = bonsaiLikeGguf({ weightType: 142, bitsPerWeight: BPW.pq2_0 })
    expect(() => readGgufTensorSummary(file.subarray(0, 200))).toThrow(GgufNeedMoreData)
  })

  it.each([
    ['not a GGUF file', Buffer.from('NOPE0000000000000000000000000000')],
    ['GGUF v1', buildGguf({ version: 1, tensors: [] })],
    [
      'a huge tensor count',
      (() => {
        const b = buildGguf({ tensors: [] })
        b.writeBigUInt64LE(10n ** 12n, 8)
        return b
      })(),
    ],
    [
      'a tensor with no dimensions',
      buildGguf({ tensors: [{ name: 'x', type: 0, dims: [], bitsPerWeight: 32 }] }),
    ],
    [
      'an element count past 2^53',
      buildGguf({ tensors: [{ name: 'x', type: 0, dims: [2 ** 30, 2 ** 30, 2 ** 30], bitsPerWeight: 0 }] }),
    ],
  ])('refuses %s', (_label, bytes) => {
    expect(() => readGgufTensorSummary(bytes)).toThrow(GgufParseError)
  })
})

describe('readGgufTensorSummaryChunked', () => {
  const file = bonsaiLikeGguf({ weightType: 143, bitsPerWeight: BPW.ptq1_0, layers: 40 })
  const reader = (calls: number[]) => async (n: number) => {
    calls.push(n)
    return file.subarray(0, n)
  }

  it('grows the prefix until the table is read', async () => {
    const calls: number[] = []
    const summary = await readGgufTensorSummaryChunked(reader(calls), {
      chunkSize: 512,
      fileSize: file.length,
    })
    expect(summary.tensorCount).toBe(121)
    expect(calls.length).toBeGreaterThan(1)
  })

  it('gives up at the read budget', async () => {
    await expect(readGgufTensorSummaryChunked(reader([]), { chunkSize: 256, maxBytes: 512 })).rejects.toThrow(
      /read budget/
    )
  })

  it('reports a truncated file', async () => {
    const short = file.subarray(0, 300)
    await expect(
      readGgufTensorSummaryChunked(async (n) => short.subarray(0, n), { chunkSize: 4096 })
    ).rejects.toThrow(GgufParseError)
  })
})
