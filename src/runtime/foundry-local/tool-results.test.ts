import { describe, expect, it } from 'vitest'
import { groupFoundryToolResults } from './tool-results.js'

const call = (id: string) => ({ id, type: 'function', function: { name: 'read', arguments: '{}' } })
const assistant = (...ids: string[]) => ({ role: 'assistant', content: null, tool_calls: ids.map(call) })
const tool = (id: string) => ({ role: 'tool', tool_call_id: id, content: `Result of ${id}` })
const user = (content: string) => ({ role: 'user', content })

describe('groupFoundryToolResults', () => {
  it('keeps complete parallel results adjacent to their call and preserves intervening text', () => {
    const question = user('Read both files.')
    const calls = assistant('a', 'b', 'c')
    const firstNote = user('Give a short answer.')
    const secondNote = user('Include both file names.')
    const nextTurn = { role: 'assistant', content: 'Both files were read.' }
    const split = [question, calls, tool('b'), firstNote, tool('a'), secondNote, tool('c'), nextTurn]

    expect(groupFoundryToolResults(split)).toEqual([
      question,
      calls,
      tool('b'),
      tool('a'),
      tool('c'),
      firstNote,
      secondNote,
      nextTurn,
    ])
    expect(split[3]).toBe(firstNote)
  })

  it('uses the complete Foundry assistant turn when Claude replays its calls in separate messages', () => {
    const first = assistant('a')
    const second = assistant('b')
    const note = user('Continue.')
    expect(groupFoundryToolResults([first, second, tool('b'), note, tool('a')])).toEqual([
      first,
      second,
      tool('b'),
      tool('a'),
      note,
    ])
  })

  it('preserves real results and explicitly marks the call with no result in an interrupted group', () => {
    const calls = assistant('a', 'b')
    const note = user('Continue.')
    expect(groupFoundryToolResults([calls, tool('b'), note])).toEqual([
      calls,
      tool('b'),
      {
        role: 'tool',
        tool_call_id: 'a',
        content: 'No tool result was provided for this call in the conversation history.',
      },
      note,
    ])
  })

  it('returns a result arriving after a later assistant turn to its original call', () => {
    const calls = assistant('a', 'b')
    const note = user('Continue.')
    const later = { role: 'assistant', content: 'Here is what I know so far.' }
    const history = [calls, tool('a'), note, later, tool('b')]
    expect(groupFoundryToolResults(history)).toEqual([calls, tool('a'), tool('b'), note, later])
  })

  it('moves a result from an earlier call out of the following parallel result group', () => {
    const first = assistant('c')
    const note = user('Now check the other two.')
    const next = assistant('a', 'b')
    const history = [first, note, next, tool('a'), tool('b'), tool('c')]
    expect(groupFoundryToolResults(history)).toEqual([first, tool('c'), note, next, tool('a'), tool('b')])
  })

  it('keeps an unanswered assistant call separate when the foreign result was its only separator', () => {
    const first = assistant('a', 'b')
    const note = user('Now check the other two.')
    const waiting = assistant('c')
    const next = assistant('d')
    const history = [first, tool('a'), note, waiting, tool('b'), next, tool('d')]
    expect(groupFoundryToolResults(history)).toEqual([
      first,
      tool('a'),
      tool('b'),
      note,
      waiting,
      {
        role: 'tool',
        tool_call_id: 'c',
        content: 'No tool result was provided for this call in the conversation history.',
      },
      next,
      tool('d'),
    ])
  })

  it.each([
    ['complete adjacent results', [assistant('a', 'b'), tool('b'), tool('a'), user('next')]],
    ['outstanding calls', [assistant('a', 'b'), user('next')]],
    ['a repeated result ID', [assistant('a', 'b'), tool('a'), user('next'), tool('a'), tool('b')]],
    ['a repeated call ID', [assistant('a', 'a'), tool('a'), user('next'), tool('a')]],
    ['an unrelated result', [assistant('a', 'b'), tool('a'), user('next'), tool('b'), tool('c')]],
    [
      'a result ID already used earlier in history',
      [assistant('b'), tool('b'), assistant('a', 'b'), tool('a')],
    ],
    [
      'separate named assistant turns',
      [
        { ...assistant('a'), name: 'first' },
        { ...assistant('b'), name: 'second' },
        tool('b'),
        user('next'),
        tool('a'),
      ],
    ],
    ['a single call', [assistant('a'), user('next'), tool('a')]],
  ])('leaves %s alone', (_name, messages) => {
    expect(groupFoundryToolResults(messages)).toBe(messages)
  })
})
