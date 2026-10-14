import { describe, expect, it } from 'vitest'
import { imageMime, imageSize, isMp4, mp4Facts } from './media-header.js'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64'
)

/** A JPEG with an APP0 segment, then a SOF0 for `width`×`height`. */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0])
  const sof = Buffer.alloc(19)
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08])
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])])
}

function webpVp8x(width: number, height: number): Buffer {
  const out = Buffer.alloc(30)
  out.write('RIFF', 0, 'latin1')
  out.write('WEBP', 8, 'latin1')
  out.write('VP8X', 12, 'latin1')
  out.writeUIntLE(width - 1, 24, 3)
  out.writeUIntLE(height - 1, 27, 3)
  return out
}

function box(type: string, ...children: Buffer[]): Buffer {
  const body = Buffer.concat(children)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(8 + body.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, body])
}

function mp4(width: number, height: number, timescale: number, duration: number): Buffer {
  const mvhd = Buffer.alloc(100)
  mvhd.writeUInt32BE(timescale, 12)
  mvhd.writeUInt32BE(duration, 16)
  const tkhd = Buffer.alloc(84)
  tkhd.writeUInt32BE(width << 16, 76)
  tkhd.writeUInt32BE(height << 16, 80)
  const audio = Buffer.alloc(84)
  return Buffer.concat([
    box('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1')),
    box('moov', box('mvhd', mvhd), box('trak', box('tkhd', audio)), box('trak', box('tkhd', tkhd))),
    box('mdat', Buffer.alloc(16)),
  ])
}

describe('imageSize', () => {
  it.each([
    ['png', PNG_1X1, { width: 1, height: 1 }],
    ['jpeg', jpeg(1536, 1024), { width: 1536, height: 1024 }],
    ['webp', webpVp8x(800, 600), { width: 800, height: 600 }],
  ])('reads a %s header', (_name, bytes, size) => {
    expect(imageSize(bytes)).toEqual(size)
  })

  it('answers undefined for bytes that are not an image', () => {
    expect(imageSize(Buffer.from('not an image'))).toBeUndefined()
  })
})

describe('imageMime', () => {
  it('names the three image types a gallery keeps, and nothing else', () => {
    expect(imageMime(PNG_1X1)).toBe('image/png')
    expect(imageMime(jpeg(2, 2))).toBe('image/jpeg')
    expect(imageMime(webpVp8x(2, 2))).toBe('image/webp')
    expect(imageMime(Buffer.from('GIF89a'))).toBeUndefined()
  })
})

describe('mp4Facts', () => {
  it('reads the movie length and the picture track size, skipping a track without picture', () => {
    const bytes = mp4(1280, 720, 1000, 8000)
    expect(isMp4(bytes)).toBe(true)
    expect(mp4Facts(bytes)).toEqual({ width: 1280, height: 720, durationSecs: 8 })
  })

  it('answers undefined for a WebM or a truncated file', () => {
    expect(mp4Facts(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]))).toBeUndefined()
    expect(mp4Facts(box('ftyp', Buffer.from('isom', 'latin1')))).toBeUndefined()
  })
})
