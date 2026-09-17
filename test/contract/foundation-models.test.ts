import { describe, expect, it } from 'vitest'
import type { ErrorBody } from '../../src/contracts/index.js'
import { classifyFoundationModelsStderr } from '../../src/runtime/foundation-models/index.js'
import { loadFixtureSet } from './fixtures.js'

const { index, cases } = loadFixtureSet<{ stderr: string }, ErrorBody>('foundation-models-errors')

/** Cases the port corrects on purpose; each keeps the app's answer next to the corrected one. */
const CORRECTED: Record<string, ErrorBody> = {
  swift_model_downloading: {
    code: 'FOUNDATION_MODELS_UNAVAILABLE',
    message: 'The Foundation Model is still downloading or not yet ready. Please wait and try again.',
    details: '[foundation-models] ERROR: Foundation model is downloading or not yet ready',
  },
}

describe(`contract: foundation-models errors (${index.source.file} @ ${index.source.commit.slice(0, 7)})`, () => {
  it('has every indexed case', () => {
    expect(cases.map((c) => c.name).sort()).toEqual([...index.cases].sort())
  })

  it.each(cases.map((c) => [c.name, c] as const))('%s', (name, c) => {
    const actual = classifyFoundationModelsStderr(c.input.stderr).toJSON()
    const corrected = CORRECTED[name]
    if (corrected) {
      // The app misclassified the Swift server's own wording as an unexpected error.
      expect(c.expected.code).toBe('PROCESS_ERROR')
      expect(actual).toEqual(corrected)
    } else {
      expect(actual).toEqual(c.expected)
    }
  })
})
