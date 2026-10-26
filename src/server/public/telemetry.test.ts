import { describe, expect, it } from 'vitest'
import { StreamTelemetry, extractReasoning, promptPreview } from './telemetry.js'

// Parity with the Rust inspector is test/contract/inspector-telemetry.test.ts; these pin what the
// fixtures do not reach.
describe('telemetry edges', () => {
  it('finds no reasoning where there is none, and ignores empty spellings', () => {
    expect(extractReasoning({ delta: { reasoning_content: '', reasoning_details: [] } })).toBeUndefined()
    expect(extractReasoning({ message: { reasoning_details: [{ text: 'a' }, { nope: 1 }] } })).toBe('a')
    expect(extractReasoning('not a choice')).toBeUndefined()
  })

  it('reports no time to first token before any content, and a preview cap in characters', () => {
    const telemetry = new StreamTelemetry()
    expect(telemetry.ttftMs(0)).toBeNull()
    // A JSON pointer addresses an object key "0" the same way as an array index, as serde_json does.
    telemetry.onJson({ choices: { '0': { delta: { content: 'x' } } } }, 5)
    telemetry.onJson({ choices: [] }, 6)
    expect(telemetry.deltaCount).toBe(1)
    expect(telemetry.ttftMs(0)).toBe(5)
    expect(promptPreview({ messages: [{ role: 'user', content: '😀😀😀' }] }, 2)).toMatchObject({
      text: '😀😀',
      chars: 3,
    })
  })

  it('counts and times a reply without keeping its text when previews are off', () => {
    const telemetry = new StreamTelemetry({ previews: false })
    telemetry.onJson({ choices: [{ delta: { reasoning_content: 'thinking' } }] }, 3)
    telemetry.onJson({ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }, 4)
    telemetry.onJson({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }, 5)

    expect(telemetry.finishFields(0)).toEqual({
      ttft_ms: 3,
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
      tokens_estimated: false,
      prompt_per_second: null,
      predicted_per_second: null,
      finish_reason: 'stop',
      reply_preview: null,
      reply_chars: 14,
    })
  })
})
