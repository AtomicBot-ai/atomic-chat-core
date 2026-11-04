import { describe, expect, it } from 'vitest'
import { sampleWav } from '../../test/helpers/audio-fixtures.js'
import { parseWav, stripAudioDataUrl } from './wav.js'

/** A WAV with extra chunks before `fmt ` and `data`, as macOS writes them (`JUNK`, `FLLR`). */
function wavWithChunks(): Buffer {
  const plain = sampleWav(24000, 1, 0.1)
  const junk = Buffer.concat([
    Buffer.from('JUNK', 'latin1'),
    Buffer.from([3, 0, 0, 0]),
    Buffer.from([0, 0, 0, 0]),
  ])
  const body = Buffer.concat([plain.subarray(12, 36), junk, plain.subarray(36)])
  const head = Buffer.alloc(12)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(4 + body.length, 4)
  head.write('WAVE', 8, 'latin1')
  return Buffer.concat([head, Buffer.from('JUNK', 'latin1'), Buffer.from([1, 0, 0, 0, 0, 0]), body])
}

describe('parseWav', () => {
  it.each([
    ['24 kHz mono speech', sampleWav(24000, 1, 0.5), { sampleRate: 24000, channels: 1, audioMs: 500 }],
    ['44.1 kHz stereo music', sampleWav(44100, 2, 2), { sampleRate: 44100, channels: 2, audioMs: 2000 }],
    [
      'odd chunks before the format and the data',
      wavWithChunks(),
      { sampleRate: 24000, channels: 1, audioMs: 100 },
    ],
  ])('reads %s', (_name, bytes, expected) => {
    expect(parseWav(bytes)).toMatchObject({ ...expected, bitsPerSample: 16 })
  })

  it('measures a streamed data chunk (size 0xFFFFFFFF) by the file, and a header read alone by the size on disk', () => {
    const streamed = sampleWav(8000, 1, 1)
    streamed.writeUInt32LE(0xffff_ffff, 40)
    expect(parseWav(streamed)?.audioMs).toBe(1000)
    const full = sampleWav(8000, 1, 2)
    expect(parseWav(full.subarray(0, 64), full.length)).toMatchObject({ audioMs: 2000, dataBytes: 32000 })
  })

  it.each([
    ['too short', Buffer.from('RIFF')],
    ['not RIFF', Buffer.concat([Buffer.from('RIFX'), sampleWav().subarray(4)])],
    ['not WAVE', Buffer.concat([sampleWav().subarray(0, 8), Buffer.from('AVI '), sampleWav().subarray(12)])],
    [
      'data before fmt',
      (() => {
        const w = sampleWav()
        return Buffer.concat([w.subarray(0, 12), w.subarray(36)])
      })(),
    ],
    [
      'a format with no channels',
      (() => {
        const w = Buffer.from(sampleWav())
        w.writeUInt16LE(0, 22)
        return w
      })(),
    ],
    ['a truncated format chunk', sampleWav().subarray(0, 30)],
    ['no data chunk', sampleWav().subarray(0, 36)],
    ['JSON', Buffer.from('{"error":{"message":"x"}}')],
  ])('refuses %s', (_name, bytes) => {
    expect(parseWav(bytes)).toBeUndefined()
  })
})

describe('stripAudioDataUrl', () => {
  it.each([
    ['data:audio/wav;base64,UklGRg==', 'UklGRg=='],
    ['  data:audio/x-wav;base64,UklGRg==  ', 'UklGRg=='],
    ['UklGRg==', 'UklGRg=='],
  ])('%j → %j', (input, expected) => {
    expect(stripAudioDataUrl(input)).toBe(expected)
  })
})
