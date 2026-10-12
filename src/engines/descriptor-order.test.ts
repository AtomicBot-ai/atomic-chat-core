import { describe, expect, it } from 'vitest'
import { compareDescriptorIds, isNewerDescriptor, parseDescriptorId } from './descriptor-order.js'

describe('parseDescriptorId', () => {
  it('reads <engine_id>-<version>-r<n>, a pre-release suffix included', () => {
    expect(parseDescriptorId('tensorrt-llm', 'tensorrt-llm-1.3.0rc29-r3')).toEqual({
      parts: [1, 3, 0],
      pre: { kind: 'rc', number: 29 },
      revision: 3,
    })
    expect(parseDescriptorId('vllm', 'vllm-0.31.0-r1')).toEqual({ parts: [0, 31, 0], pre: null, revision: 1 })
  })

  it('answers null for an id of another engine or of another form', () => {
    expect(parseDescriptorId('vllm', 'vllm-nightly')).toBeNull()
    expect(parseDescriptorId('vllm', 'vllm-latest')).toBeNull()
    expect(parseDescriptorId('vllm', 'tensorrt-llm-1.3.0-r1')).toBeNull()
    // The engine id is a prefix of the other engine's id, not a match.
    expect(parseDescriptorId('tensorrt', 'tensorrt-llm-1.3.0-r1')).toBeNull()
    expect(parseDescriptorId('vllm', 'vllm-0.31.0')).toBeNull()
    expect(parseDescriptorId('vllm', 'vllm-0.31.0-r')).toBeNull()
  })
})

describe('compareDescriptorIds', () => {
  const table: Array<[string, string, string]> = [
    // [engine, older, newer]
    ['tensorrt-llm', 'tensorrt-llm-1.3.0rc29-r3', 'tensorrt-llm-1.3.0-r1'],
    ['tensorrt-llm', 'tensorrt-llm-1.3.0a1-r9', 'tensorrt-llm-1.3.0b1-r1'],
    ['tensorrt-llm', 'tensorrt-llm-1.3.0b9-r1', 'tensorrt-llm-1.3.0rc1-r1'],
    ['tensorrt-llm', 'tensorrt-llm-1.3.0rc2-r1', 'tensorrt-llm-1.3.0rc10-r1'],
    ['tensorrt-llm', 'tensorrt-llm-1.2.9-r5', 'tensorrt-llm-1.3.0rc1-r1'],
    ['vllm', 'vllm-0.31.0-r1', 'vllm-0.31.0-r2'],
    ['vllm', 'vllm-0.31.0-r2', 'vllm-0.32.0-r1'],
    ['vllm', 'vllm-0.9.0-r1', 'vllm-0.10.0-r1'],
    ['vllm', 'vllm-0.31-r1', 'vllm-0.31.1-r1'],
    ['vllm', 'vllm-nightly', 'vllm-0.0.1-r1'],
  ]
  it.each(table)('%s: %s < %s', (engine, older, newer) => {
    expect(compareDescriptorIds(engine, older, newer)).toBeLessThan(0)
    expect(compareDescriptorIds(engine, newer, older)).toBeGreaterThan(0)
    expect(isNewerDescriptor(engine, newer, older)).toBe(true)
    expect(isNewerDescriptor(engine, older, newer)).toBe(false)
  })

  it('treats missing trailing parts as zero and an id as equal to itself', () => {
    expect(compareDescriptorIds('vllm', 'vllm-0.31-r1', 'vllm-0.31.0-r1')).toBe(0)
    expect(isNewerDescriptor('vllm', 'vllm-0.31.0-r1', 'vllm-0.31.0-r1')).toBe(false)
  })

  it('never calls an unparsable or foreign id newer than anything', () => {
    expect(isNewerDescriptor('vllm', 'vllm-nightly', 'vllm-0.31.0-r1')).toBe(false)
    expect(isNewerDescriptor('vllm', 'vllm-nightly', 'vllm-latest')).toBe(false)
    expect(isNewerDescriptor('vllm', 'tensorrt-llm-9.0.0-r1', 'vllm-0.31.0-r1')).toBe(false)
  })
})
