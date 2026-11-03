import { describe, expect, it } from 'vitest'

import { asSystemReminder } from './reminders.js'

describe('asSystemReminder', () => {
  it('wraps a mid-conversation system text the way Claude Code writes its reminders', () => {
    expect(asSystemReminder('  The user switched to plan mode.\n')).toBe(
      '<system-reminder>\nThe user switched to plan mode.\n</system-reminder>'
    )
  })

  it('keeps a text the client already wrapped as it is, without nesting it', () => {
    const wrapped = '<system-reminder>\nTodo list changed.\n</system-reminder>'
    expect(asSystemReminder(`\n${wrapped}  `)).toBe(wrapped)
  })
})
