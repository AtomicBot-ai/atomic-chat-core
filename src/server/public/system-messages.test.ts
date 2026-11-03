import { describe, expect, it } from 'vitest'

import { mergedSystemMessages } from './system-messages.js'

const user = { role: 'user', content: 'hi' }
const assistant = { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }

describe('mergedSystemMessages', () => {
  it('merges system messages from the conversation into a string system, keeping the rest in order', () => {
    const body = {
      system: 'You are Claude Code.',
      messages: [
        user,
        assistant,
        { role: 'system', content: 'Reminder one.' },
        { role: 'user', content: 'next' },
        {
          role: 'developer',
          content: [
            { type: 'text', text: 'Reminder ' },
            { type: 'text', text: 'two.' },
          ],
        },
      ],
    }
    expect(mergedSystemMessages('llamacpp', body)).toEqual({
      system: 'You are Claude Code.\n\nReminder one.\n\nReminder two.',
      messages: [user, assistant, { role: 'user', content: 'next' }],
    })
  })

  it("appends one block to an array system and leaves the client's blocks as they were", () => {
    const blocks = [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1' },
      { type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } },
    ]
    const body = { system: blocks, messages: [user, { role: 'system', content: 'Reminder.' }] }
    expect(mergedSystemMessages('llamacpp-upstream', body)).toEqual({
      system: [...blocks, { type: 'text', text: '\n\nReminder.' }],
      messages: [user],
    })
  })

  it('makes the merged text the system when the request has none, and drops empty system messages', () => {
    expect(
      mergedSystemMessages('atomic-prism', { messages: [{ role: 'system', content: 'Only this.' }, user] })
    ).toEqual({ system: 'Only this.', messages: [user] })
    expect(
      mergedSystemMessages('llamacpp', { system: 'Kept.', messages: [user, { role: 'system', content: '' }] })
    ).toEqual({ messages: [user] })
  })

  it('leaves a conversation without system messages, and other engines, as sent', () => {
    expect(mergedSystemMessages('llamacpp', { system: 'S', messages: [user, assistant] })).toBeUndefined()
    expect(
      mergedSystemMessages('mlx', { messages: [user, { role: 'system', content: 'Reminder.' }] })
    ).toBeUndefined()
    expect(mergedSystemMessages('llamacpp', { messages: 'not a list' })).toBeUndefined()
  })
})
