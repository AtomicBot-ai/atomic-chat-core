import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome, type AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configureDroid } from './droid.js'

const PATH = '.factory/settings.json'

let home: AgentHome
afterEach(async () => {
  await home.cleanup()
})

describe('configuring Droid', () => {
  it('numbers the selector by the position our entry ends up at', async () => {
    home = await makeAgentHome()
    // Droid addresses a custom model by index, so two models ahead of ours means `-2`.
    await home.seed(
      PATH,
      JSON.stringify({
        customModels: [{ displayName: 'A' }, { displayName: 'B' }, { displayName: 'Atomic Chat' }],
      })
    )
    await configureDroid(agentInput(home.fs))
    const written = JSON.parse((await home.read(PATH)) as string)
    expect(written.model).toBe('custom:Atomic-Chat-2')
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
    expect(JSON.parse((await home.read(PATH)) as string).model).toBe('custom:Atomic-Chat-0')
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
