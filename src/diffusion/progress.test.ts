/**
 * Hand-ported from the `#[test]` table of `progress.rs` in `tauri-plugin-atomic-diffusion` (app
 * commit `767ff6350`).
 */
import { describe, expect, it } from 'vitest'
import {
  classifyExit,
  diagnosticTail,
  isProgressRedraw,
  OutputRecords,
  parseStepLine,
  parseTileAnnouncement,
  splitRecords,
  stripAnsi,
} from './progress.js'

describe('splitRecords', () => {
  it('splits on CR, LF, CRLF and the erase sequence', () => {
    expect(splitRecords('a\rb\nc\r\nd\x1b[Ke')).toEqual({ records: ['a', 'b', 'c', 'd\x1b[K'], rest: 'e' })
  })

  it('delivers an in-place redraw when it is flushed', () => {
    // The CR leads the *next* redraw; the erase closes the current one.
    expect(splitRecords('\r|==>  | 1/4 - 2.0s/it\x1b[K\r|====>| 2/4')).toEqual({
      records: ['', '|==>  | 1/4 - 2.0s/it\x1b[K', ''],
      rest: '|====>| 2/4',
    })
  })

  it('never splits inside a character', () => {
    expect(splitRecords('é\x1b[Kü')).toEqual({ records: ['é\x1b[K'], rest: 'ü' })
    expect(splitRecords('')).toEqual({ records: [], rest: '' })
  })
})

describe('stripAnsi', () => {
  it('removes CSI sequences and nothing else', () => {
    expect(stripAnsi('\x1b[32mok\x1b[0m done\x1b[K')).toBe('ok done')
    expect(stripAnsi('plain')).toBe('plain')
    // A lone escape is not a CSI sequence; an unterminated one swallows the rest, as in Rust.
    expect(stripAnsi('a\x1bb')).toBe('a\x1bb')
    expect(stripAnsi('a\x1b[12;3')).toBe('a')
  })
})

describe('OutputRecords', () => {
  it('holds a multibyte character back until its continuation arrives', () => {
    const bytes = Buffer.from('прогресс 1/4\n', 'utf8')
    const out = new OutputRecords()
    // Split in the middle of the first Cyrillic letter (two bytes each).
    expect(out.push(bytes.subarray(0, 1))).toEqual([])
    expect(out.push(bytes.subarray(1))).toEqual(['прогресс 1/4'])
    expect(out.finish()).toEqual([])
  })

  it('turns invalid bytes into replacement characters', () => {
    const out = new OutputRecords()
    expect(out.push(Buffer.from([0x61, 0xff, 0x62, 0x0a]))).toEqual(['a\ufffdb'])
  })

  it('reports each redraw as soon as its erase sequence arrives, cleaned', () => {
    const out = new OutputRecords()
    expect(out.push(Buffer.from('\r|==>  | 1/4 - 2.0s/it\x1b[K'))).toEqual(['|==>  | 1/4 - 2.0s/it'])
    // The next redraw is still open: nothing yet, and the leading CR yields only an empty record.
    expect(out.push(Buffer.from('\r|====>| 2/4 - 2.0s'))).toEqual([])
    expect(out.push(Buffer.from('/it\x1b[K\n'))).toEqual(['|====>| 2/4 - 2.0s/it'])
  })

  it('strips colour, trims the right edge, drops blank lines, and flushes the tail at the end', () => {
    const out = new OutputRecords()
    expect(
      out.push(Buffer.from('\x1b[32m[INFO ]\x1b[0m loading   \n\n   \nlast line without an end'))
    ).toEqual(['[INFO ] loading'])
    expect(out.finish()).toEqual(['last line without an end'])
    expect(out.finish()).toEqual([])
  })
})

describe('parseStepLine', () => {
  it('parses every observed shape', () => {
    expect(parseStepLine('|====>    | 12/28 - 3.52s/it')).toEqual([12, 28])
    expect(parseStepLine('[ 12/ 28]')).toEqual([12, 28])
    expect(parseStepLine('sampling: 50%|.....| 14/28')).toEqual([14, 28])
    expect(parseStepLine('4/4')).toEqual([4, 4])
    expect(parseStepLine('loading model from file')).toBeUndefined()
    expect(parseStepLine('size 1024x1024')).toBeUndefined()
    expect(parseStepLine('3.5s/it')).toBeUndefined()
  })

  it('takes the first pair, skips numbers without one, and ignores what does not fit a u32', () => {
    expect(parseStepLine('image 2 of 3: 5/20 then 6/20')).toEqual([5, 20])
    expect(parseStepLine('7 /\t9')).toEqual([7, 9])
    expect(parseStepLine('99999999999/4 then 1/4')).toEqual([1, 4])
    expect(parseStepLine('1/99999999999')).toBeUndefined()
    expect(parseStepLine('12/')).toBeUndefined()
  })
})

describe('progress redraws and tile passes', () => {
  it('knows a redraw by its rate', () => {
    expect(isProgressRedraw('|==>   | 1/8 - 12.0s/it')).toBe(true)
    expect(isProgressRedraw('|==>   | 1/9 - 1.41it/s')).toBe(true)
    expect(isProgressRedraw('  |####  | 108/251 - 637.50MB/s')).toBe(true)
    expect(isProgressRedraw('[ERROR] sampling for image 1/1 failed after 0.31s')).toBe(false)
  })

  it('tells a tile announcement from other lines', () => {
    expect(parseTileAnnouncement('[VERBOSE] tiling.cpp:203  - processing 9 tiles')).toBe(9)
    expect(parseTileAnnouncement('processing 49 tiles')).toBe(49)
    expect(parseTileAnnouncement('[VERBOSE] tiling.cpp:201  - num tiles : 3, 3')).toBeUndefined()
    expect(parseTileAnnouncement('processing 9 latents')).toBeUndefined()
    expect(parseTileAnnouncement('|====>    | 3/9 - 1.30s/it')).toBeUndefined()
    expect(parseTileAnnouncement('processing tiles')).toBeUndefined()
    expect(parseTileAnnouncement('processing nine tiles')).toBeUndefined()
  })
})

describe('diagnosticTail', () => {
  it('puts marked lines first', () => {
    const lines = ["ggml_metal: error: unsupported op 'RMS_NORM'", 'GGML_ABORT']
    for (let i = 0; i < 30; i++) lines.push(`frame #${i} 0x${i.toString(16).padStart(8, '0')}`)
    const tail = diagnosticTail(lines, 20, 1500).split('\n')
    expect(tail[0]).toBe("ggml_metal: error: unsupported op 'RMS_NORM'")
    expect(tail[1]).toBe('GGML_ABORT')
    // Context: the last max(keep/2, 4) = 10 lines follow, de-duplicated.
    expect(tail).toHaveLength(12)
    expect(tail.at(-1)).toBe('frame #29 0x0000001d')
  })

  it('is capped and de-duplicated', () => {
    expect(diagnosticTail(['error x', 'error x', 'error x'], 20, 1500)).toBe('error x')
    expect(diagnosticTail(['a'.repeat(2000)], 20, 100)).toHaveLength(100)
    expect(diagnosticTail([])).toBe('')
  })

  it('keeps only the last marked lines, and at least four lines of context', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `error ${i}`).concat(['a', 'b', 'c', 'd', 'e'])
    expect(diagnosticTail(lines, 2, 1500).split('\n')).toEqual(['error 8', 'error 9', 'b', 'c', 'd', 'e'])
  })
})

describe('classifyExit', () => {
  it('reads an out-of-memory death from the code or the output', () => {
    expect(classifyExit('', 137)).toBe('OUT_OF_MEMORY')
    expect(classifyExit('ggml_backend_cuda_buffer_type_alloc_buffer: failed to allocate', 1)).toBe(
      'OUT_OF_MEMORY'
    )
    expect(classifyExit('CUDA error: Out Of Memory', 1)).toBe('OUT_OF_MEMORY')
    expect(classifyExit('cudaErrorMemoryAllocation', 1)).toBe('OUT_OF_MEMORY')
    expect(
      classifyExit('Insufficient Memory (00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory)', 1)
    ).toBe('OUT_OF_MEMORY')
    expect(classifyExit("unsupported op 'RMS_NORM'\nGGML_ABORT", -6)).toBe('ENGINE_CRASHED')
    expect(classifyExit('', undefined)).toBe('ENGINE_CRASHED')
  })
})
