import { afterEach, describe, expect, it } from 'vitest'
import { makeAgentHome, type AgentHome } from '../../../test/helpers/agent-config-home.js'
import {
  BACKUP_SUFFIX,
  getAt,
  parseBackup,
  readBackup,
  renderBackup,
  trackKeys,
  writeBackupText,
} from './json-key-backup.js'

let home: AgentHome | undefined
afterEach(async () => {
  await home?.cleanup()
  home = undefined
})

describe('the per-key backup of a JSON config', () => {
  it('reads a value at a path, and nothing where the path breaks off', () => {
    const root = { model: { primary: 'gpt-5', list: [1] } }
    expect(getAt(root, ['model', 'primary'])).toBe('gpt-5')
    expect(getAt(root, ['model', 'missing'])).toBeUndefined()
    expect(getAt(root, ['model', 'primary', 'deeper'])).toBeUndefined()
  })

  it('records what Connect replaced, and keeps the first value across reconnects', () => {
    const user = { model: { primary: 'anthropic/claude' } }
    const first = { model: { primary: 'atomic/qwen' } }
    const keys = trackKeys(user, first, [['model', 'primary'], ['gateway']], [])
    expect(keys).toEqual([{ path: ['model', 'primary'], before: 'anthropic/claude', ours: 'atomic/qwen' }])

    // A reconnect on another model still remembers the user's own value, not ours.
    const second = { model: { primary: 'atomic/gemma' } }
    expect(trackKeys(first, second, [['model', 'primary']], keys)).toEqual([
      { path: ['model', 'primary'], before: 'anthropic/claude', ours: 'atomic/gemma' },
    ])
  })

  it('treats a value the user changed after Connect as theirs', () => {
    const earlier = [{ path: ['model'], before: 'theirs-1', ours: 'atomic/qwen' }]
    expect(trackKeys({ model: 'theirs-2' }, { model: 'atomic/qwen' }, [['model']], earlier)).toEqual([
      { path: ['model'], before: 'theirs-2', ours: 'atomic/qwen' },
    ])
  })

  it('round-trips through its text form and refuses a malformed one', () => {
    const backup = {
      keys: [
        { path: ['a', 'b'], before: 1, ours: 2 },
        { path: ['c'], ours: true },
      ],
      seeded: ['x'],
    }
    expect(parseBackup(renderBackup(backup))).toEqual(backup)
    expect(parseBackup(renderBackup({ keys: [], seeded: [] }))).toEqual({ keys: [], seeded: [] })
    expect(parseBackup('not json')).toBeUndefined()
    expect(parseBackup('{"keys":[{"path":[1]}]}')).toBeUndefined()
  })

  it('sits next to the config it belongs to', async () => {
    home = await makeAgentHome()
    expect(await readBackup(home.fs, 'agent.json')).toBeUndefined()
    await home.fs.write('agent.json', '{}\n')
    await writeBackupText(
      home.fs,
      'agent.json',
      renderBackup({ keys: [{ path: ['m'], before: 'x' }], seeded: [] })
    )
    expect(await home.read(`agent.json${BACKUP_SUFFIX}`)).toContain('"before": "x"')
    expect(await readBackup(home.fs, 'agent.json')).toEqual({
      keys: [{ path: ['m'], before: 'x' }],
      seeded: [],
    })
  })
})
