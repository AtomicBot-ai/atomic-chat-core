/**
 * Replay of the request inspector's pure parts, dumped from the app's `request_inspector.rs`
 * (PLAN.md §4, stage 4d): prompt preview, stream telemetry, `include_usage` injection.
 */

import { describe, expect, it } from 'vitest'
import { loadFixtureSet } from './fixtures.js'
import {
  PREVIEW_MAX_CHARS,
  StreamTelemetry,
  isUsageOnlyChunk,
  maybeInjectStreamUsage,
  promptPreview,
} from '../../src/server/public/telemetry.js'
import { serdeToString } from '../../src/server/shims/index.js'
import type { JsonValue } from '../../src/server/shims/index.js'

type Input = Record<string, JsonValue>

describe('inspector-telemetry', () => {
  const { index, cases } = loadFixtureSet<Input, JsonValue>('inspector-telemetry')

  it('pins the preview cap', () => {
    const notes = (index as unknown as { comparator_notes: { constants: { preview_max_chars: number } } })
      .comparator_notes
    expect(PREVIEW_MAX_CHARS).toBe(notes.constants.preview_max_chars)
  })

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const input = c.input
    let actual: JsonValue
    switch (input['kind']) {
      case 'prompt_preview':
        actual = promptPreview(input['body'] as JsonValue) as unknown as JsonValue
        break
      case 'stream_telemetry': {
        const start = 1_000_000
        const telemetry = new StreamTelemetry()
        for (const frame of input['frames'] as Array<{ offset_ms: number; json: JsonValue }>)
          telemetry.onJson(frame.json, start + frame.offset_ms)
        if (input['whole_response'] === true) telemetry.firstContentAt = undefined
        actual = telemetry.finishFields(start) as unknown as JsonValue
        break
      }
      case 'maybe_inject_stream_usage': {
        const rewritten = maybeInjectStreamUsage(Buffer.from(serdeToString(input['body'] as JsonValue)))
        actual = { rewritten: rewritten ? (JSON.parse(rewritten.toString('utf8')) as JsonValue) : null }
        break
      }
      case 'maybe_inject_stream_usage_raw':
        actual = { rewritten: maybeInjectStreamUsage(Buffer.from(input['raw'] as string)) ? true : null }
        break
      case 'is_usage_only_chunk':
        actual = { trailer: isUsageOnlyChunk(input['chunk'] as JsonValue) }
        break
      default:
        throw new Error(`unknown case kind ${String(input['kind'])}`)
    }
    expect(actual).toEqual(c.expected)
  })
})
