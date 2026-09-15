import { describe, expect, it } from 'vitest'
import type { ErrorBody } from '../../src/contracts/index.js'
import { classifyProcessOutput } from '../../src/runtime/llamacpp/errors.js'
import { loadFixtureSet } from './fixtures.js'

interface ErrorsInput {
  stderr: string
  stdout: string
  exit: { code: number | null; signal: number | null }
}

const { index, cases } = loadFixtureSet<ErrorsInput, ErrorBody>('errors')

describe(`contract: errors (${index.source.file} @ ${index.source.commit.slice(0, 7)}, ${index.comparator})`, () => {
  it('has every indexed case', () => {
    expect(cases.map((c) => c.name).sort()).toEqual([...index.cases].sort())
  })

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    // The emitter runs on Unix, so signals are Unix numbers and the platform is unix-like.
    const err = classifyProcessOutput(c.input.exit, c.input.stderr, c.input.stdout, 'linux')
    expect(err.toJSON()).toEqual(c.expected)
  })
})
