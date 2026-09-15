import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import {
  findMemoryPattern,
  isMemoryPattern,
  parseDeviceLine,
  parseDeviceOutput,
  parseMemoryValue,
} from './devices.js'

describe('isMemoryPattern', () => {
  it.each([
    ['8128 MiB, 8128 MiB free', true],
    ['0 MiB, 0 MiB free', true],
    ['8128 MB, 8128 MB free', false],
    ['8128 MiB 8128 MiB free', false],
    ['8128 MiB, 8128 MiB used', false],
    ['not_a_number MiB, 8128 MiB free', false],
    ['8128 MiB', false],
    ['', false],
    ['8128 MiB, free', false],
    ['1 MiB, 2 MiB, 3 MiB free', false],
  ])('%j → %s', (c, ok) => expect(isMemoryPattern(c)).toBe(ok))
})

describe('findMemoryPattern / parseMemoryValue', () => {
  it('returns the last valid group and its start index', () => {
    const text = 'Device (test) with (1024 MiB, 512 MiB free) and (2048 MiB, 1024 MiB free)'
    expect(findMemoryPattern(text)).toEqual({
      start: text.lastIndexOf('('),
      content: '2048 MiB, 1024 MiB free',
    })
    expect(findMemoryPattern('No memory info here')).toBeUndefined()
    expect(findMemoryPattern('(unclosed 1 MiB, 2 MiB free')).toBeUndefined()
  })
  it.each([
    ['8128 MiB', 8128],
    ['7721 MiB free', 7721],
    ['', undefined],
    ['x MiB', undefined],
  ])('parseMemoryValue(%j) = %j', (s, e) => expect(parseMemoryValue(s)).toBe(e))
})

describe('parseDeviceLine', () => {
  it('parses the three known shapes', () => {
    expect(
      parseDeviceLine('Vulkan0: Intel(R) Arc(tm) A750 Graphics (DG2) (8128 MiB, 8128 MiB free)')
    ).toEqual({
      id: 'Vulkan0',
      name: 'Intel(R) Arc(tm) A750 Graphics (DG2)',
      mem: 8128,
      free: 8128,
    })
    expect(parseDeviceLine('CUDA0: NVIDIA GeForce RTX 4090 (24576 MiB, 24000 MiB free)')?.name).toBe(
      'NVIDIA GeForce RTX 4090'
    )
    expect(parseDeviceLine('SYCL0: Intel(R) Arc(TM) A750 Graphics (8000 MiB, 7721 MiB free)')?.free).toBe(
      7721
    )
  })
  it.each([
    'Vulkan0 Intel Graphics (8128 MiB, 8128 MiB free)',
    'Vulkan0: Intel Graphics',
    'Vulkan0: Intel Graphics (invalid memory)',
  ])('skips malformed line %j', (l) => expect(parseDeviceLine(l)).toBeUndefined())
})

describe('parseDeviceOutput', () => {
  it('parses everything after the header, skipping blanks and junk', () => {
    const out = parseDeviceOutput(
      'hdr\nAvailable devices:\nCUDA0: A (1 MiB, 1 MiB free)\n\nnonsense\nVulkan0: B (2 MiB, 2 MiB free)\n'
    )
    expect(out.map((d) => d.id)).toEqual(['CUDA0', 'Vulkan0'])
  })
  it('returns an empty list for an empty section and throws without a header', () => {
    expect(parseDeviceOutput('Available devices:\n\n')).toEqual([])
    try {
      parseDeviceOutput('nothing here')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(AtomicCoreError)
      expect((e as AtomicCoreError).code).toBe('DEVICE_LIST_PARSE_FAILED')
      expect((e as AtomicCoreError).details).toBe('nothing here')
    }
  })
})
