import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  crc32,
  decodePng,
  downscale,
  encodePng,
  fitWithin,
  HEADER_READ_LIMIT,
  insertAfterHeader,
  isPng,
  makeChunk,
  parseHeader,
  PNG_SIGNATURE,
  readChunk,
  readPngHeader,
  textChunk,
  thumbnailPng,
} from './png.js'
import type { RasterImage } from './png.js'

const fixture = (name: string) =>
  readFile(fileURLToPath(new URL(`../../test/fixtures/png/${name}`, import.meta.url)))

/** The formula `test/fixtures/png/generate.py` painted the fixtures with. */
function pixel(x: number, y: number, channels: 3 | 4): number[] {
  const rgb = [(x * 7 + y * 13) & 255, (x * x + y) & 255, (x ^ (y * 5)) & 255]
  return channels === 4 ? [...rgb, (x * y) & 255] : rgb
}

function painted(width: number, height: number, channels: 3 | 4): RasterImage {
  const data = Buffer.alloc(width * height * channels)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set(pixel(x, y, channels), (y * width + x) * channels)
  return { width, height, channels, data }
}

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-core-png-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('chunks', () => {
  it('computes the CRC-32 PNG uses', () => {
    // The check value of the CRC-32 catalogue, and the CRC every PNG ends with.
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
    expect(crc32(Buffer.from('IEND'))).toBe(0xae426082)
    expect(crc32(Buffer.from('1234'), Buffer.from('56789'))).toBe(0xcbf43926)
    expect(crc32()).toBe(0)
  })

  it('builds a chunk a reader accepts, and reads it back', () => {
    const chunk = makeChunk('IEND', Buffer.alloc(0))
    expect(chunk.toString('hex')).toBe('0000000049454e44ae426082')
    const text = textChunk('atomic', '{"prompt":"кот"}')
    const read = readChunk(text, 0)
    expect(read?.type).toBe('tEXt')
    expect(read?.end).toBe(text.length)
    expect(read?.data.toString('utf8')).toBe('atomic\0{"prompt":"кот"}')
    // Incomplete in every way a growing buffer can be.
    expect(readChunk(text, text.length)).toBeUndefined()
    expect(readChunk(text.subarray(0, 6), 0)).toBeUndefined()
    expect(readChunk(text.subarray(0, text.length - 1), 0)).toBeUndefined()
  })

  it('inserts chunks right after IHDR and leaves every other byte alone', async () => {
    const png = await fixture('rgb-all-filters.png')
    const inserted = insertAfterHeader(png, [textChunk('a', '1'), textChunk('b', '2')]) as Buffer
    const ihdrEnd = (readChunk(png, 8) as { end: number }).end
    expect(inserted.subarray(0, ihdrEnd).equals(png.subarray(0, ihdrEnd))).toBe(true)
    const added = inserted.length - png.length
    expect(inserted.subarray(ihdrEnd + added).equals(png.subarray(ihdrEnd))).toBe(true)
    expect(readChunk(inserted, ihdrEnd)?.data.toString('latin1')).toBe('a\x001')
    // The image itself is untouched: it still decodes to the same pixels.
    expect((await decodePng(inserted)).data.equals((await decodePng(png)).data)).toBe(true)

    expect(insertAfterHeader(Buffer.from('not a png'), [])).toBe('not-png')
    expect(insertAfterHeader(Buffer.concat([PNG_SIGNATURE, makeChunk('IDAT', Buffer.alloc(1))]), [])).toBe(
      'no-ihdr'
    )
    expect(insertAfterHeader(PNG_SIGNATURE, [])).toBe('no-ihdr')
    expect(isPng(Buffer.alloc(4))).toBe(false)
  })
})

describe('reading a header', () => {
  it('takes the size and the text chunks, and stops at the first IDAT', async () => {
    const png = await fixture('rgba-all-filters.png')
    const tagged = insertAfterHeader(png, [
      textChunk('atomic', '{"ж":1}'),
      textChunk('parameters', 'a cat'),
    ]) as Buffer
    // A text chunk after the image data is not part of the header.
    const late = Buffer.concat([
      tagged.subarray(0, tagged.length - 12),
      textChunk('late', 'x'),
      tagged.subarray(tagged.length - 12),
    ])
    const path = join(dir, 'tagged.png')
    await writeFile(path, late)
    const header = await readPngHeader(path)
    expect(header).toEqual({
      width: 31,
      height: 17,
      texts: new Map([
        ['atomic', '{"ж":1}'],
        ['parameters', 'a cat'],
      ]),
    })
  })

  it('answers undefined for what is not a readable PNG', async () => {
    expect(await readPngHeader(join(dir, 'missing.png'))).toBeUndefined()
    await writeFile(join(dir, 'text.png'), 'not a png at all')
    expect(await readPngHeader(join(dir, 'text.png'))).toBeUndefined()
    await writeFile(join(dir, 'empty.png'), '')
    expect(await readPngHeader(join(dir, 'empty.png'))).toBeUndefined()
    const shortIhdr = Buffer.concat([PNG_SIGNATURE, makeChunk('IHDR', Buffer.alloc(4))])
    await writeFile(join(dir, 'short-ihdr.png'), shortIhdr)
    expect(await readPngHeader(join(dir, 'short-ihdr.png'))).toBeUndefined()
    expect(await readPngHeader(dir)).toBeUndefined()
  })

  it('returns what it has for a file that ends early, and gives up on a header that never ends', async () => {
    const png = await fixture('rgb-all-filters.png')
    const ihdrEnd = (readChunk(png, 8) as { end: number }).end
    await writeFile(join(dir, 'cut.png'), png.subarray(0, ihdrEnd + 5))
    expect(await readPngHeader(join(dir, 'cut.png'))).toEqual({ width: 31, height: 17, texts: new Map() })

    // More than the limit of ancillary chunks before any image data.
    const filler = makeChunk('tEXt', Buffer.concat([Buffer.from('k\0'), Buffer.alloc(60_000, 0x61)]))
    const endless = Buffer.concat([
      png.subarray(0, ihdrEnd),
      ...Array.from({ length: 6 }, () => filler),
      png.subarray(ihdrEnd),
    ])
    expect(endless.length).toBeGreaterThan(HEADER_READ_LIMIT)
    await writeFile(join(dir, 'endless.png'), endless)
    const header = await readPngHeader(join(dir, 'endless.png'))
    expect(header?.width).toBe(31)
    expect(header?.texts.get('k')?.length).toBe(60_000)

    expect(parseHeader(Buffer.alloc(3))).toEqual({ header: undefined, done: false })
    expect(parseHeader(Buffer.from('definitely not'))).toBe('not-png')
  })
})

describe('decodePng', () => {
  it.each([
    ['rgb-all-filters.png', 3],
    ['rgba-all-filters.png', 4],
  ] as const)('reads %s: every filter type, several IDAT chunks', async (name, channels) => {
    const image = await decodePng(await fixture(name))
    expect([image.width, image.height, image.channels]).toEqual([31, 17, channels])
    expect(image.data.equals(painted(31, 17, channels).data)).toBe(true)
  })

  it.each(['gray8.png', 'palette.png', 'gray16.png', 'interlaced.png'])(
    'refuses %s rather than guessing',
    async (name) => {
      await expect(decodePng(await fixture(name))).rejects.toThrow(/unsupported PNG flavour/)
    }
  )

  it('refuses damaged files', async () => {
    const png = await fixture('rgb-all-filters.png')
    await expect(decodePng(Buffer.from('nope'))).rejects.toThrow('not a PNG')
    await expect(decodePng(png.subarray(0, png.length - 12))).rejects.toThrow('truncated PNG')
    await expect(
      decodePng(Buffer.concat([PNG_SIGNATURE, makeChunk('IEND', Buffer.alloc(0))]))
    ).rejects.toThrow('PNG without a usable IHDR')
    await expect(
      decodePng(
        Buffer.concat([PNG_SIGNATURE, makeChunk('IHDR', Buffer.alloc(5)), makeChunk('IEND', Buffer.alloc(0))])
      )
    ).rejects.toThrow('bad IHDR')

    // A header that claims more pixels than the data holds, and one that claims an absurd size.
    const ihdr = Buffer.from((readChunk(png, 8) as { data: Buffer }).data)
    ihdr.writeUInt32BE(18, 4)
    const taller = Buffer.concat([PNG_SIGNATURE, makeChunk('IHDR', ihdr), png.subarray(33)])
    await expect(decodePng(taller)).rejects.toThrow('PNG data does not match its header')
    ihdr.writeUInt32BE(100_000, 0)
    ihdr.writeUInt32BE(100_000, 4)
    const huge = Buffer.concat([PNG_SIGNATURE, makeChunk('IHDR', ihdr), png.subarray(33)])
    await expect(decodePng(huge)).rejects.toThrow('PNG too large')
  })

  it('refuses a filter type that does not exist', async () => {
    const image = painted(4, 2, 3)
    const encoded = await encodePng(image)
    const idat = readChunk(encoded, 33) as { data: Buffer; end: number }
    const raw = inflateSync(idat.data)
    raw[0] = 9
    const { deflateSync } = await import('node:zlib')
    const broken = Buffer.concat([
      encoded.subarray(0, 33),
      makeChunk('IDAT', deflateSync(raw)),
      encoded.subarray(idat.end),
    ])
    await expect(decodePng(broken)).rejects.toThrow('unknown PNG filter 9')
  })
})

describe('encodePng', () => {
  it.each([3, 4] as const)('round-trips %i channels through its own decoder', async (channels) => {
    const image = painted(300, 150, channels)
    const decoded = await decodePng(await encodePng(image))
    expect([decoded.width, decoded.height, decoded.channels]).toEqual([300, 150, channels])
    expect(decoded.data.equals(image.data)).toBe(true)
  })

  it('chooses filters per row instead of storing rows raw', async () => {
    // A smooth gradient: a filtered row is almost all zeros, a raw one is not.
    const width = 256
    const data = Buffer.alloc(width * 64 * 3)
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < width; x++) data.fill((x + y) & 255, (y * width + x) * 3, (y * width + x) * 3 + 3)
    const encoded = await encodePng({ width, height: 64, channels: 3, data })
    const raw = inflateSync((readChunk(encoded, 33) as { data: Buffer }).data)
    const filters = new Set(Array.from({ length: 64 }, (_, y) => raw[y * (width * 3 + 1)]))
    expect(filters.has(0)).toBe(false)
    expect(encoded.length).toBeLessThan(2_000)
  })
})

describe('thumbnails', () => {
  it('fits the longest side and never upscales', () => {
    expect(fitWithin(512, 256, 256)).toEqual({ width: 256, height: 128 })
    expect(fitWithin(1024, 1024, 256)).toEqual({ width: 256, height: 256 })
    expect(fitWithin(832, 1216, 256)).toEqual({ width: 175, height: 256 })
    expect(fitWithin(64, 48, 256)).toEqual({ width: 64, height: 48 })
    expect(fitWithin(4000, 3, 256)).toEqual({ width: 256, height: 1 })
  })

  it('averages the pixels each destination pixel covers', async () => {
    // 4x2 → 2x1: each destination pixel is the mean of a 2x2 block.
    const data = Buffer.from([
      ...[0, 0, 0],
      ...[10, 20, 30],
      ...[100, 100, 100],
      ...[101, 101, 101],
      ...[20, 40, 60],
      ...[30, 60, 90],
      ...[102, 102, 102],
      ...[103, 103, 103],
    ])
    const small = await downscale({ width: 4, height: 2, channels: 3, data }, 2)
    expect([small.width, small.height]).toEqual([2, 1])
    expect([...small.data]).toEqual([15, 30, 45, 102, 102, 102])
    const same = { width: 2, height: 2, channels: 3 as const, data: Buffer.alloc(12) }
    expect(await downscale(same, 256)).toBe(same)
  })

  it('makes a PNG thumbnail of a PNG, and says no to a flavour it cannot read', async () => {
    const big = await encodePng(painted(512, 256, 3))
    const thumb = await decodePng(await thumbnailPng(big, 256))
    expect([thumb.width, thumb.height, thumb.channels]).toEqual([256, 128, 3])
    await expect(thumbnailPng(await fixture('palette.png'), 256)).rejects.toThrow(/unsupported/)
  })
})
