import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome, type AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configureDroid } from './droid.js'

const PATH = '.factory/settings.json'
const BACKUP = '.factory/settings.json.atomic-chat-backup.json'

let home: AgentHome
afterEach(async () => {
  await home.cleanup()
})

const read = async (path = PATH) => JSON.parse((await home.read(path)) as string)

describe('configuring Droid', () => {
  it('numbers the selector by the position our entry ends up at, and names it explicitly', async () => {
    home = await makeAgentHome()
    await home.seed(
      PATH,
      JSON.stringify({
        customModels: [{ displayName: 'A' }, { displayName: 'B' }, { displayName: 'Atomic Chat' }],
      })
    )
    await configureDroid(agentInput(home.fs))
    const written = await read()
    expect(written.sessionDefaultSettings.model).toBe('custom:Atomic-Chat-2')
    expect(written.customModels[2]).toMatchObject({ id: 'custom:Atomic-Chat-2', index: 2 })
    expect(written.customModels.map((m: { displayName: string }) => m.displayName)).toEqual([
      'A',
      'B',
      'Atomic Chat',
    ])
  })

  it('treats a whitespace-only file as a fresh one', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, '   \n\n')
    await configureDroid(agentInput(home.fs))
    expect((await read()).sessionDefaultSettings.model).toBe('custom:Atomic-Chat-0')
  })

  it('caps the reply at a quarter of a known window and gives Droid the rest', async () => {
    home = await makeAgentHome()
    await configureDroid({ ...agentInput(home.fs), contextLength: 16384 })
    expect((await read()).customModels[0]).toMatchObject({ maxOutputTokens: 4096, maxContextLimit: 12288 })
    await configureDroid({ ...agentInput(home.fs), contextLength: 131072 })
    expect((await read()).customModels[0]).toMatchObject({ maxOutputTokens: 8192, maxContextLimit: 122880 })
    // Unknown: no limit is invented.
    await configureDroid(agentInput(home.fs))
    expect((await read()).customModels[0]).not.toHaveProperty('maxOutputTokens')
    expect((await read()).customModels[0]).not.toHaveProperty('maxContextLimit')
  })

  it('backs up the default it replaces, once, and drops the legacy top-level selector', async () => {
    home = await makeAgentHome()
    await home.seed(
      PATH,
      JSON.stringify({
        model: 'custom:Atomic-Chat-0',
        sessionDefaultSettings: { model: 'gpt-5.5', autonomyMode: 'normal' },
      })
    )
    await configureDroid(agentInput(home.fs))
    await configureDroid(agentInput(home.fs, { model: 'other' }))
    const written = await read()
    expect(written).not.toHaveProperty('model')
    expect(written.sessionDefaultSettings).toEqual({ model: 'custom:Atomic-Chat-0', autonomyMode: 'normal' })
    expect(await read(BACKUP)).toEqual({
      previous: { defaultModel: 'gpt-5.5', sessionDefaultSettings: true },
      written: { defaultModel: 'custom:Atomic-Chat-0' },
    })
  })

  it('takes a fresh backup when the user picked another default since', async () => {
    home = await makeAgentHome()
    await configureDroid(agentInput(home.fs))
    expect((await read(BACKUP)).previous).toEqual({ defaultModel: null, sessionDefaultSettings: false })
    const settings = await read()
    settings.sessionDefaultSettings.model = 'claude-opus'
    await home.seed(PATH, JSON.stringify(settings))
    await configureDroid({ ...agentInput(home.fs), platform: 'win32' })
    expect((await read(BACKUP)).previous).toEqual({
      defaultModel: 'claude-opus',
      sessionDefaultSettings: true,
    })
  })

  it('restores nothing when a backup that still matches lost its previous value', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, JSON.stringify({ sessionDefaultSettings: { model: 'custom:Atomic-Chat-0' } }))
    await home.seed(BACKUP, JSON.stringify({ written: { defaultModel: 'custom:Atomic-Chat-0' } }))
    await configureDroid(agentInput(home.fs))
    expect((await read(BACKUP)).previous).toBeNull()
  })

  it('refuses a malformed or non-object settings file and leaves it byte-identical', async () => {
    for (const bad of ['{ "customModels": ', '[1, 2, 3]']) {
      home = await makeAgentHome()
      await home.seed(PATH, bad)
      await expect(configureDroid(agentInput(home.fs)), bad).rejects.toThrow()
      expect(await home.read(PATH)).toBe(bad)
      await home.cleanup()
    }
    home = await makeAgentHome()
  })
})
