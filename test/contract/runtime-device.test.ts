import { describe, expect, it } from 'vitest'
import type { RuntimeDeviceInfo } from '../../src/contracts/index.js'
import { isInconclusive, RuntimeDeviceAccumulator } from '../../src/runtime/llamacpp/runtime-device.js'
import { loadFixtureSet } from './fixtures.js'

interface Input {
  lines: string[]
  mark_cuda_runtime_missing: boolean
}
interface Expected {
  snapshot: RuntimeDeviceInfo
  is_inconclusive: boolean
}

const { index, cases } = loadFixtureSet<Input, Expected>('runtime-device')

describe(`contract: runtime-device (${index.source.file} @ ${index.source.commit.slice(0, 7)}, ${index.comparator})`, () => {
  it('has every indexed case', () => {
    expect(cases.map((c) => c.name).sort()).toEqual([...index.cases].sort())
  })

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const acc = new RuntimeDeviceAccumulator()
    if (c.input.mark_cuda_runtime_missing) acc.markCudaRuntimeMissing()
    for (const line of c.input.lines) acc.ingest(line)
    const info = acc.snapshot()
    expect(info).toEqual(c.expected.snapshot)
    expect(isInconclusive(info)).toBe(c.expected.is_inconclusive)
  })
})
