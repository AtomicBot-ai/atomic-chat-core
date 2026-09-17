/**
 * The little of PNG the gallery needs, on `node:zlib` alone: chunk splicing that never touches the
 * image data, a header reader that stops at the first `IDAT`, and a decoder, box downscale and
 * encoder for thumbnails of what stable-diffusion.cpp writes: 8-bit RGB or RGBA, non-interlaced
 * (ADR 2026-09-17-a-minimal-png-codec-on-node-zlib-for-recipes-and-thumbnails).
 */

import { open } from 'node:fs/promises'
import { promisify } from 'node:util'
import { deflate, inflate } from 'node:zlib'

const inflateAsync = promisify(inflate)
const deflateAsync = promisify(deflate)

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function isPng(bytes: Buffer): boolean {
  return bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)
}

export interface PngChunk {
  type: string
  data: Buffer
  /** Offset just past the chunk (length + type + data + CRC). */
  end: number
}

/** The chunk starting at `offset`, or `undefined` when it is not complete in `png`. */
export function readChunk(png: Buffer, offset: number): PngChunk | undefined {
  if (offset + 8 > png.length) return undefined
  const length = png.readUInt32BE(offset)
  const end = offset + 8 + length + 4
  if (end > png.length) return undefined
  return {
    type: png.toString('latin1', offset + 4, offset + 8),
    data: png.subarray(offset + 8, offset + 8 + length),
    end,
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 (ISO 3309, as PNG uses it) over the parts in order. */
export function crc32(...parts: Buffer[]): number {
  let c = 0xffffffff
  for (const part of parts)
    for (let i = 0; i < part.length; i++)
      c = (CRC_TABLE[(c ^ (part[i] as number)) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function makeChunk(type: string, data: Buffer): Buffer {
  const kind = Buffer.from(type, 'latin1')
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(kind, data))
  return Buffer.concat([head, kind, data, tail])
}

/** A `tEXt` chunk. The text goes in as UTF-8, which is what the app has always written and read. */
export function textChunk(keyword: string, text: string): Buffer {
  return makeChunk(
    'tEXt',
    Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'utf8')])
  )
}

/**
 * `png` with `chunks` inserted right after `IHDR`, everything else byte for byte. `not-png` and
 * `no-ihdr` tell the caller which of the two things was wrong.
 */
export function insertAfterHeader(png: Buffer, chunks: Buffer[]): Buffer | 'not-png' | 'no-ihdr' {
  if (!isPng(png)) return 'not-png'
  const ihdr = readChunk(png, 8)
  if (!ihdr || ihdr.type !== 'IHDR') return 'no-ihdr'
  return Buffer.concat([png.subarray(0, ihdr.end), ...chunks, png.subarray(ihdr.end)])
}

export interface PngHeader {
  width: number
  height: number
  /** `tEXt` chunks before the first `IDAT`, keyword → text (UTF-8, lossy); the first of a keyword wins. */
  texts: Map<string, string>
}

/** How much of a file a header may occupy: recipes are a few hundred bytes. */
export const HEADER_READ_LIMIT = 256 * 1024
const HEADER_READ_STEP = 64 * 1024

/** `IHDR` and the text chunks of what has been read so far; `done` once `IDAT` or `IEND` was reached. */
export function parseHeader(bytes: Buffer): { header: PngHeader | undefined; done: boolean } | 'not-png' {
  if (bytes.length >= 8 && !isPng(bytes)) return 'not-png'
  let header: PngHeader | undefined
  let offset = 8
  for (;;) {
    const chunk = readChunk(bytes, offset)
    if (!chunk) return { header, done: false }
    if (chunk.type === 'IHDR') {
      if (chunk.data.length < 8) return 'not-png'
      header = { width: chunk.data.readUInt32BE(0), height: chunk.data.readUInt32BE(4), texts: new Map() }
    } else if (chunk.type === 'tEXt' && header) {
      const nul = chunk.data.indexOf(0)
      const keyword = nul >= 0 ? chunk.data.toString('latin1', 0, nul) : undefined
      // The first chunk of a keyword wins: ours go right after IHDR, the engine's own follow.
      if (keyword !== undefined && !header.texts.has(keyword))
        header.texts.set(keyword, chunk.data.toString('utf8', nul + 1))
    } else if (chunk.type === 'IDAT' || chunk.type === 'IEND') return { header, done: true }
    offset = chunk.end
  }
}

/**
 * Read `IHDR` and the text chunks before the first `IDAT`, and no further: listing a gallery must
 * not read every image. `undefined` for anything that is not a readable PNG.
 */
export async function readPngHeader(path: string): Promise<PngHeader | undefined> {
  const file = await open(path, 'r').catch(() => undefined)
  if (!file) return undefined
  try {
    let bytes: Buffer = Buffer.alloc(0)
    for (;;) {
      const step = Buffer.alloc(HEADER_READ_STEP)
      const { bytesRead } = await file.read(step, 0, step.length, bytes.length)
      if (bytesRead === 0) break
      bytes = Buffer.concat([bytes, step.subarray(0, bytesRead)])
      const parsed = parseHeader(bytes)
      if (parsed === 'not-png') return undefined
      if (parsed.done || bytes.length > HEADER_READ_LIMIT) return parsed.header
    }
    const parsed = parseHeader(bytes)
    return parsed === 'not-png' ? undefined : parsed.header
  } catch {
    return undefined
  } finally {
    await file.close().catch(() => {})
  }
}

/** Decoded pixels, rows top to bottom, `channels` bytes per pixel, no padding. */
export interface RasterImage {
  width: number
  height: number
  channels: 3 | 4
  data: Buffer
}

/** Refuse a header that claims more than this before allocating for it (2048² is the largest output). */
export const MAX_PIXELS = 8192 * 8192
const ROWS_PER_SLICE = 128

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * Decode an 8-bit RGB or RGBA, non-interlaced PNG. Anything else throws: the caller goes without a
 * thumbnail rather than guessing.
 */
export async function decodePng(png: Buffer): Promise<RasterImage> {
  if (!isPng(png)) throw new Error('not a PNG')
  let width = 0
  let height = 0
  let channels: 3 | 4 | undefined
  const idat: Buffer[] = []
  for (let offset = 8; ;) {
    const chunk = readChunk(png, offset)
    if (!chunk) throw new Error('truncated PNG')
    if (chunk.type === 'IHDR') {
      if (chunk.data.length !== 13) throw new Error('bad IHDR')
      width = chunk.data.readUInt32BE(0)
      height = chunk.data.readUInt32BE(4)
      const [bitDepth, colorType, compression, filter, interlace] = chunk.data.subarray(8)
      if (
        bitDepth !== 8 ||
        (colorType !== 2 && colorType !== 6) ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0
      )
        throw new Error(
          `unsupported PNG flavour (depth ${bitDepth}, colour ${colorType}, interlace ${interlace})`
        )
      channels = colorType === 2 ? 3 : 4
    } else if (chunk.type === 'IDAT') idat.push(chunk.data)
    else if (chunk.type === 'IEND') break
    offset = chunk.end
  }
  if (channels === undefined || width === 0 || height === 0) throw new Error('PNG without a usable IHDR')
  if (width * height > MAX_PIXELS) throw new Error(`PNG too large (${width}x${height})`)

  const stride = width * channels
  const expected = height * (stride + 1)
  const raw = await inflateAsync(Buffer.concat(idat), { maxOutputLength: expected })
  if (raw.length !== expected) throw new Error('PNG data does not match its header')

  const data = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (stride + 1)] as number
    const src = y * (stride + 1) + 1
    const dst = y * stride
    const up = dst - stride
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? (data[dst + x - channels] as number) : 0
      const above = y > 0 ? (data[up + x] as number) : 0
      const aboveLeft = y > 0 && x >= channels ? (data[up + x - channels] as number) : 0
      let predicted: number
      switch (filterType) {
        case 0:
          predicted = 0
          break
        case 1:
          predicted = left
          break
        case 2:
          predicted = above
          break
        case 3:
          predicted = (left + above) >> 1
          break
        case 4:
          predicted = paeth(left, above, aboveLeft)
          break
        default:
          throw new Error(`unknown PNG filter ${filterType}`)
      }
      data[dst + x] = ((raw[src + x] as number) + predicted) & 0xff
    }
    if (y % ROWS_PER_SLICE === ROWS_PER_SLICE - 1) await yieldToEventLoop()
  }
  return { width, height, channels, data }
}

/** The size `width`×`height` takes when its longest side is brought down to `maxEdge`; never larger than it was. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  if (width <= maxEdge && height <= maxEdge) return { width, height }
  const ratio = Math.min(maxEdge / width, maxEdge / height)
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) }
}

/** Box downscale: every destination pixel is the mean of the source pixels it covers. */
export async function downscale(image: RasterImage, maxEdge: number): Promise<RasterImage> {
  const size = fitWithin(image.width, image.height, maxEdge)
  if (size.width === image.width && size.height === image.height) return image
  const { channels } = image
  const data = Buffer.alloc(size.width * size.height * channels)
  const sums = new Float64Array(channels)
  for (let dy = 0; dy < size.height; dy++) {
    const y0 = Math.floor((dy * image.height) / size.height)
    const y1 = Math.max(y0 + 1, Math.floor(((dy + 1) * image.height) / size.height))
    for (let dx = 0; dx < size.width; dx++) {
      const x0 = Math.floor((dx * image.width) / size.width)
      const x1 = Math.max(x0 + 1, Math.floor(((dx + 1) * image.width) / size.width))
      sums.fill(0)
      for (let y = y0; y < y1; y++) {
        let at = (y * image.width + x0) * channels
        for (let x = x0; x < x1; x++)
          for (let c = 0; c < channels; c++) sums[c] = (sums[c] as number) + (image.data[at++] as number)
      }
      const count = (y1 - y0) * (x1 - x0)
      const out = (dy * size.width + dx) * channels
      for (let c = 0; c < channels; c++) data[out + c] = Math.round((sums[c] as number) / count)
    }
    if (dy % 16 === 15) await yieldToEventLoop()
  }
  return { width: size.width, height: size.height, channels, data }
}

/** Encode with the usual heuristic: per row, the filter whose output has the smallest sum of absolute values. */
export async function encodePng(image: RasterImage): Promise<Buffer> {
  const { width, height, channels, data } = image
  const stride = width * channels
  const raw = Buffer.alloc(height * (stride + 1))
  const candidates = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride))
  for (let y = 0; y < height; y++) {
    const row = y * stride
    const up = row - stride
    const costs = [0, 0, 0, 0, 0]
    for (let x = 0; x < stride; x++) {
      const value = data[row + x] as number
      const left = x >= channels ? (data[row + x - channels] as number) : 0
      const above = y > 0 ? (data[up + x] as number) : 0
      const aboveLeft = y > 0 && x >= channels ? (data[up + x - channels] as number) : 0
      const predictions = [0, left, above, (left + above) >> 1, paeth(left, above, aboveLeft)]
      for (let f = 0; f < 5; f++) {
        const filtered = (value - (predictions[f] as number)) & 0xff
        ;(candidates[f] as Buffer)[x] = filtered
        costs[f] = (costs[f] as number) + (filtered < 128 ? filtered : 256 - filtered)
      }
    }
    let best = 0
    for (let f = 1; f < 5; f++) if ((costs[f] as number) < (costs[best] as number)) best = f
    raw[y * (stride + 1)] = best
    ;(candidates[best] as Buffer).copy(raw, y * (stride + 1) + 1)
    if (y % ROWS_PER_SLICE === ROWS_PER_SLICE - 1) await yieldToEventLoop()
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, channels === 3 ? 2 : 6, 0, 0, 0], 8)
  return Buffer.concat([
    PNG_SIGNATURE,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', await deflateAsync(raw)),
    makeChunk('IEND', Buffer.alloc(0)),
  ])
}

/** A PNG no larger than `maxEdge` on its longest side. Throws for a PNG flavour the decoder does not read. */
export async function thumbnailPng(png: Buffer, maxEdge: number): Promise<Buffer> {
  return encodePng(await downscale(await decodePng(png), maxEdge))
}
