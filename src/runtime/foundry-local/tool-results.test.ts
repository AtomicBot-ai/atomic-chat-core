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

  it.each([
    ['complete adjacent results', [assistant('a', 'b'), tool('b'), tool('a'), user('next')]],
    ['outstanding calls', [assistant('a', 'b'), user('next')]],
    ['a missing result', [assistant('a', 'b'), tool('a'), user('next')]],
    ['a repeated result ID', [assistant('a', 'b'), tool('a'), user('next'), tool('a'), tool('b')]],
    ['a repeated call ID', [assistant('a', 'a'), tool('a'), user('next'), tool('a')]],
    ['an unrelated result', [assistant('a', 'b'), tool('a'), user('next'), tool('b'), tool('c')]],
    ['a result beyond a later assistant turn', [assistant('a', 'b'), tool('a'), assistant('c'), tool('b')]],
    ['a single call', [assistant('a'), user('next'), tool('a')]],
  ])('leaves %s alone', (_name, messages) => {
    expect(groupFoundryToolResults(messages)).toBe(messages)
  })
})
