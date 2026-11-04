import { describe, expect, it } from 'vitest'

import type { JsonValue } from '../shims/index.js'
import { placedSystemMessages } from './system-messages.js'

const user = { role: 'user', content: 'hi' }
const assistant = { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }
const reminder = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`

describe('placedSystemMessages', () => {
  it('keeps a system message inside the conversation in place, before the next user text', () => {
    const body = {
      system: 'You are Claude Code.',
      messages: [
        user,
        assistant,
        { role: 'system', content: 'Reminder one.' },
        { role: 'user', content: 'next' },
        assistant,
        {
          role: 'developer',
          content: [
            { type: 'text', text: 'Reminder ' },
            { type: 'text', text: 'two.' },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'and then' }] },
      ],
    }
    // The top-level system is untouched, so the start of the prompt llama.cpp has cached stays as it was.
    expect(placedSystemMessages('llamacpp', body)).toEqual({
      messages: [
        user,
        assistant,
        { role: 'user', content: `${reminder('Reminder one.')}\n\nnext` },
        assistant,
        {
          role: 'user',
          content: [
            { type: 'text', text: `${reminder('Reminder two.')}\n` },
            { type: 'text', text: 'and then' },
          ],
        },
      ],
    })
  })

  it('puts a reminder after the tool results it follows, never between a tool call and its result', () => {
    const call = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
    }
    const result = (content: JsonValue) => ({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content },
        { type: 'text', text: 'typed' },
      ],
    })
    const body = (content: JsonValue) => ({
      messages: [user, call, { role: 'system', content: 'Note.' }, result(content)],
    })
    const placed = (content: JsonValue) =>
      (placedSystemMessages('llamacpp-upstream', body(content))?.messages[2] as { content: unknown[] })
        .content[0]

    expect(placed('file.txt')).toEqual({
      type: 'tool_result',
      tool_use_id: 't1',
      content: `file.txt\n\n${reminder('Note.')}`,
    })
    expect(placed([{ type: 'text', text: 'file.txt' }])).toEqual({
      type: 'tool_result',
      tool_use_id: 't1',
      content: [
        { type: 'text', text: 'file.txt' },
        { type: 'text', text: `\n\n${reminder('Note.')}` },
      ],
    })
  })

  it('merges a trailing reminder into the user turn before it, or adds a user turn after an assistant', () => {
    expect(
      placedSystemMessages('atomic-prism', { messages: [user, { role: 'system', content: 'Late.' }] })
    ).toEqual({ messages: [{ role: 'user', content: `hi\n\n${reminder('Late.')}` }] })
    expect(
      placedSystemMessages('llamacpp', {
        messages: [user, assistant, { role: 'system', content: '<system-reminder>As is.</system-reminder>' }],
      })
    ).toEqual({
      messages: [user, assistant, { role: 'user', content: '<system-reminder>As is.</system-reminder>' }],
    })
    // Before the assistant's reply: into the user turn it answers, at the end.
    expect(
      placedSystemMessages('llamacpp', {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'q' }] },
          { role: 'system', content: 'R.' },
          assistant,
        ],
      })
    ).toEqual({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'q' },
            { type: 'text', text: `\n${reminder('R.')}` },
          ],
        },
        assistant,
      ],
    })
  })

  it('merges system messages before the first turn into the system, as before', () => {
    const blocks = [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1' },
      { type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } },
    ]
    expect(
      placedSystemMessages('llamacpp-upstream', {
        system: blocks,
        messages: [{ role: 'system', content: 'Leading.' }, user],
      })
    ).toEqual({ system: [...blocks, { type: 'text', text: '\n\nLeading.' }], messages: [user] })
    expect(
      placedSystemMessages('atomic-prism', { messages: [{ role: 'system', content: 'Only this.' }, user] })
    ).toEqual({ system: 'Only this.', messages: [user] })
    expect(
      placedSystemMessages('llamacpp', { system: 'Kept.', messages: [user, { role: 'system', content: '' }] })
    ).toEqual({ messages: [user] })
  })

  it('drops a turn-scoped reminder once a user message follows it', () => {
    const scoped = { role: 'system', content: 'Two tasks running.', clear_at: 'next_user_message' }
    // While it is the latest word it is shown; a turn later it is gone, as the Anthropic API clears it.
    expect(placedSystemMessages('llamacpp', { messages: [user, scoped] })).toEqual({
      messages: [{ role: 'user', content: `hi\n\n${reminder('Two tasks running.')}` }],
    })
    expect(
      placedSystemMessages('llamacpp', {
        messages: [user, scoped, assistant, { role: 'user', content: 'go' }],
      })
    ).toEqual({ messages: [user, assistant, { role: 'user', content: 'go' }] })
  })

  it('leaves a conversation without system messages, and other engines, as sent', () => {
    expect(placedSystemMessages('llamacpp', { system: 'S', messages: [user, assistant] })).toBeUndefined()
    expect(
      placedSystemMessages('mlx', { messages: [user, { role: 'system', content: 'Reminder.' }] })
    ).toBeUndefined()
    expect(placedSystemMessages('llamacpp', { messages: 'not a list' })).toBeUndefined()
  })
})
