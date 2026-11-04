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
    // Intentional correction: an intact Ollama conversion can also have a different tensor layout.
    // Keep the original desktop fixture unchanged; see the tensor-layout error ADR.
    const expected = c.input.stderr.includes('wrong number of tensors')
      ? {
          ...c.expected,
          code: 'MODEL_ARCH_NOT_SUPPORTED',
          message: "The model's architecture or format is not supported by this version of the backend.",
        }
      : c.expected
    expect(err.toJSON()).toEqual(expected)
  })
})
