import { describe, expect, it } from 'vitest'
import { decisionPromptPreview, decisionReplyFields } from './decision-preview.js'
import { PREVIEW_MAX_CHARS } from './telemetry.js'

const bytes = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))

describe('decisionPromptPreview', () => {
  it('shows a text state with the question names', () => {
    expect(
      decisionPromptPreview(
        bytes({ state: 'Billed twice', questions: { refund: { type: 'noul' }, topic: { type: 'choice' } } })
      )
    ).toEqual({
      text: 'Billed twice\n\nQuestions: refund, topic',
      chars: 38,
      message_count: null,
      has_non_text_parts: false,
    })
  })

  it('writes a structured state as compact JSON', () => {
    expect(decisionPromptPreview(bytes({ state: { body: 'hi', n: 1 }, questions: {} })).text).toBe(
      '{"body":"hi","n":1}'
    )
  })

  it('names the task and the candidates of a router request', () => {
    expect(
      decisionPromptPreview(
        bytes({ task: 'Extract the total', criterion: 'exact', candidates: [{ id: 'a' }, {}] })
      ).text
    ).toBe('Extract the total\n\nCandidates: a, ?')
  })

  it('caps the text and keeps the full length', () => {
    const preview = decisionPromptPreview(bytes({ state: 'я'.repeat(PREVIEW_MAX_CHARS + 5) }))
    expect([...(preview.text ?? '')]).toHaveLength(PREVIEW_MAX_CHARS)
    expect(preview.chars).toBe(PREVIEW_MAX_CHARS + 5)
  })

  it('has no text for a body that is not a JSON object', () => {
    expect(decisionPromptPreview(bytes('{bad')).text).toBeNull()
    expect(decisionPromptPreview(bytes([1, 2])).text).toBeNull()
  })
})

describe('decisionReplyFields', () => {
  it('lists each answer and reads the input tokens', () => {
    const fields = decisionReplyFields(
      bytes({
        answers: {
          topic: { type: 'choice', choice: 'billing', probabilities: { billing: 0.987, other: 0.013 } },
          refund: { type: 'noul', noul: 0.93 },
          sev: { type: 'score', score: 1.4 },
          odd: { type: 'future' },
        },
        usage: { input_tokens: 138, output_tokens: 0 },
      })
    )
    expect(fields.reply_preview).toBe('topic: billing (0.99)\nrefund: 0.93\nsev: 1.40')
    expect(fields.reply_chars).toBe(fields.reply_preview?.length)
    expect([fields.prompt_tokens, fields.completion_tokens, fields.total_tokens]).toEqual([138, 0, 138])
  })

  it('lists router scores', () => {
    expect(
      decisionReplyFields(bytes({ scores: [{ id: 'local/q', p_success: 0.9412 }, { id: 'x' }] }))
        .reply_preview
    ).toBe('local/q: 0.94\nx: ?')
  })

  it('has no preview for an error envelope or a body that is not JSON', () => {
    expect(
      decisionReplyFields(bytes({ error: { code: 501, reason: 'ROUTER_NOT_CALIBRATED' } })).reply_preview
    ).toBeNull()
    expect(decisionReplyFields(bytes('oops')).reply_preview).toBeNull()
    expect(decisionReplyFields(bytes('oops')).prompt_tokens).toBeNull()
  })
})
