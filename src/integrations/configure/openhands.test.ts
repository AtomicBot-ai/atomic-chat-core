import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome, type AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configureOpenhands } from './openhands.js'

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

const OLD_BLOCK =
  "# Atomic Chat - OpenHands Config\nexport LLM_MODEL='openai/m'\n" +
  "export LLM_BASE_URL='http://127.0.0.1:1337/v1'\nexport LLM_API_KEY='atomic'\n\n# Atomic Chat - OpenHands Config\n"

describe('configuring OpenHands', () => {
  it('persists nothing: the variables go on the process launch starts', async () => {
    home = await makeAgentHome()
    const spawned: string[][] = []
    for (const platform of ['darwin', 'win32'] as const) {
      await configureOpenhands(
        agentInput(home.fs, {
          platform,
          spawn: async (program, args) => {
            spawned.push([program, ...args])
            return { code: 0, stdout: '', stderr: '' }
          },
        })
      )
    }
    expect(await home.tree()).toEqual({})
    expect(spawned).toEqual([])
  })

  it("removes the block an older release wrote, and keeps the user's own exports", async () => {
    home = await makeAgentHome()
    const own = "export LLM_API_KEY='sk-mine'\n"
    await home.seed('.zshenv', `${own}${OLD_BLOCK}`)
    await home.seed('.bashrc', OLD_BLOCK)
    await configureOpenhands(agentInput(home.fs))
    expect(await home.tree()).toEqual({ '.bashrc': '', '.zshenv': own })
  })
})
