import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../src/contracts/index.js'
import type { DeviceInfo, ErrorBody } from '../../src/contracts/index.js'
import { parseDeviceOutput } from '../../src/runtime/llamacpp/devices.js'
import { loadFixtureSet } from './fixtures.js'

type Expected = { devices: DeviceInfo[] } | { error: ErrorBody }

const { index, cases } = loadFixtureSet<{ stdout: string }, Expected>('devices')

describe(`contract: devices (${index.source.file} @ ${index.source.commit.slice(0, 7)}, ${index.comparator})`, () => {
  it('has every indexed case', () => {
    expect(cases.map((c) => c.name).sort()).toEqual([...index.cases].sort())
  })

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    if ('error' in c.expected) {
      try {
        parseDeviceOutput(c.input.stdout)
        expect.unreachable('expected an error')
      } catch (e) {
        expect(e).toBeInstanceOf(AtomicCoreError)
        expect((e as AtomicCoreError).toJSON()).toEqual(c.expected.error)
      }
    } else {
      expect(parseDeviceOutput(c.input.stdout)).toEqual(c.expected.devices)
    }
  })
})
