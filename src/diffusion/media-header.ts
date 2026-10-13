/**
 * Sizes and lengths read from file headers, without a codec (AGENTS.md: the core has no image or
 * video decoder beyond its 8-bit PNG reader): the dimensions of a PNG, JPEG or WebP, and the
 * dimensions and duration of an MP4. What a provider's file says about itself, for its recipe.
 */

export interface PixelSize {
  width: number
  height: number
}

function pngSize(bytes: Buffer): PixelSize | undefined {
  if (bytes.length < 24 || bytes.toString('latin1', 12, 16) !== 'IHDR') return undefined
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/** SOF markers carry the frame size; DHT (C4), JPG (C8) and DAC (CC) share the range but do not. */
const isStartOfFrame = (marker: number): boolean =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc

function jpegSize(bytes: Buffer): PixelSize | undefined {
  let at = 2
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined
    const marker = bytes[at + 1] as number
    // Fill bytes and standalone markers have no length.
    if (marker === 0xff) {
      at += 1
      continue
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2
      continue
    }
    const length = bytes.readUInt16BE(at + 2)
    if (isStartOfFrame(marker))
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) }
    if (marker === 0xda) return undefined
    at += 2 + length
  }
  return undefined
}

function webpSize(bytes: Buffer): PixelSize | undefined {
  if (bytes.length < 30) return undefined
  const chunk = bytes.toString('latin1', 12, 16)
  if (chunk === 'VP8X') return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 }
  if (chunk === 'VP8L') {
    const bits = bytes.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8 ')
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
  return undefined
}

/** The pixel size a PNG, JPEG or WebP declares, or `undefined` for anything else. */
export function imageSize(bytes: Buffer): PixelSize | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG')
    return pngSize(bytes)
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpegSize(bytes)
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  )
    return webpSize(bytes)
  return undefined
}

/** What the first bytes of an image say it is: `image/png`, `image/jpeg`, `image/webp`, or `undefined`. */
export function imageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG') return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  )
    return 'image/webp'
  return undefined
}

/** Whether `bytes` are an MP4 (ISO base media): an `ftyp` box first. */
export function isMp4(bytes: Buffer): boolean {
  return bytes.length >= 12 && bytes.toString('latin1', 4, 8) === 'ftyp'
}

export interface Mp4Facts {
  width: number
  height: number
  durationSecs: number
}

interface Box {
  type: string
  start: number
  end: number
}

/** The boxes directly inside `[start, end)`; stops at the first malformed one. */
function boxes(bytes: Buffer, start: number, end: number): Box[] {
  const out: Box[] = []
  let at = start
  while (at + 8 <= end) {
    let size = bytes.readUInt32BE(at)
    const type = bytes.toString('latin1', at + 4, at + 8)
    let header = 8
    if (size === 1) {
      if (at + 16 > end) break
      size = Number(bytes.readBigUInt64BE(at + 8))
      header = 16
    } else if (size === 0) size = end - at
    if (size < header || at + size > end) break
    out.push({ type, start: at + header, end: at + size })
    at += size
  }
  return out
}

/** `mvhd`'s duration in seconds. */
function movieSeconds(bytes: Buffer, box: Box): number | undefined {
  const version = bytes[box.start]
  if (version === 1) {
    if (box.start + 32 > box.end) return undefined
    const timescale = bytes.readUInt32BE(box.start + 20)
    const duration = Number(bytes.readBigUInt64BE(box.start + 24))
    return timescale > 0 ? duration / timescale : undefined
  }
  if (box.start + 20 > box.end) return undefined
  const timescale = bytes.readUInt32BE(box.start + 12)
  const duration = bytes.readUInt32BE(box.start + 16)
  return timescale > 0 ? duration / timescale : undefined
}

/** `tkhd`'s width and height (16.16 fixed point), zero for a track without picture. */
function trackSize(bytes: Buffer, box: Box): PixelSize | undefined {
  const version = bytes[box.start]
  const at = box.start + (version === 1 ? 88 : 76)
  if (at + 8 > box.end) return undefined
  return { width: bytes.readUInt32BE(at) >>> 16, height: bytes.readUInt32BE(at + 4) >>> 16 }
}

/** The picture size and length an MP4 declares in its `moov`, or `undefined` when it has none to read. */
export function mp4Facts(bytes: Buffer): Mp4Facts | undefined {
  if (!isMp4(bytes)) return undefined
  const moov = boxes(bytes, 0, bytes.length).find((box) => box.type === 'moov')
  if (!moov) return undefined
  const inside = boxes(bytes, moov.start, moov.end)
  const mvhd = inside.find((box) => box.type === 'mvhd')
  const seconds = mvhd ? movieSeconds(bytes, mvhd) : undefined
  let size: PixelSize | undefined
  for (const trak of inside.filter((box) => box.type === 'trak')) {
    const tkhd = boxes(bytes, trak.start, trak.end).find((box) => box.type === 'tkhd')
    const found = tkhd ? trackSize(bytes, tkhd) : undefined
    if (found && found.width > 0 && found.height > 0) {
      size = found
      break
    }
  }
  if (seconds === undefined && !size) return undefined
  return { width: size?.width ?? 0, height: size?.height ?? 0, durationSecs: seconds ?? 0 }
}
