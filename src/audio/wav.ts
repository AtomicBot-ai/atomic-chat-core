/**
 * The only structural check the core makes on a clip: a RIFF/WAVE header with a `fmt ` chunk and a
 * `data` chunk, read for the sample rate, the channels and the length. Pure.
 */

export interface WavInfo {
  sampleRate: number
  channels: number
  bitsPerSample: number
  /** Bytes of sample data. */
  dataBytes: number
  /** Length of the clip, rounded to the millisecond. */
  audioMs: number
}

/** `data:audio/wav;base64,` and friends, ahead of a base64 payload. */
const DATA_URL_PREFIX = /^data:[^,]*;base64,/i

/** The payload of a base64 string that may carry a data-URL prefix. */
export function stripAudioDataUrl(value: string): string {
  return value.trim().replace(DATA_URL_PREFIX, '')
}

/**
 * The header of a WAV, from the whole file or from its first bytes. `fileSize` is the size on disk
 * when only the start was read: a `data` chunk that runs to the end of the file (a streamed WAV says
 * `0xFFFFFFFF`, or the read stopped short) is measured from it. `undefined` when the bytes are not a
 * PCM-style WAV.
 */
export function parseWav(bytes: Buffer, fileSize = bytes.length): WavInfo | undefined {
  if (bytes.length < 12) return undefined
  if (bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE')
    return undefined
  let at = 12
  let format: { channels: number; sampleRate: number; byteRate: number; bitsPerSample: number } | undefined
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('latin1', at, at + 4)
    const size = bytes.readUInt32LE(at + 4)
    const body = at + 8
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.length) return undefined
      format = {
        channels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        byteRate: bytes.readUInt32LE(body + 8),
        bitsPerSample: bytes.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      if (!format || format.channels === 0 || format.sampleRate === 0 || format.byteRate === 0)
        return undefined
      const available = Math.max(fileSize - body, 0)
      const dataBytes = size === 0xffff_ffff || size > available ? available : size
      return {
        sampleRate: format.sampleRate,
        channels: format.channels,
        bitsPerSample: format.bitsPerSample,
        dataBytes,
        audioMs: Math.round((dataBytes / format.byteRate) * 1000),
      }
    }
    // Chunks are word-aligned: an odd size is followed by a pad byte.
    at = body + size + (size % 2)
  }
  return undefined
}
