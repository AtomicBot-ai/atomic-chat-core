import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome, type AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configureOpenhands } from './openhands.js'

let home: AgentHome
afterEach(async () => {
  await home.cleanup()
})

describe('configuring OpenHands', () => {
  it('keeps the litellm openai/ prefix on the Windows path as well', async () => {
    home = await makeAgentHome()
    const spawned: string[][] = []
    await configureOpenhands(
      agentInput(home.fs, {
        model: 'my/model',
        apiKey: '',
        platform: 'win32',
        spawn: async (program, args) => {
          spawned.push([program, ...args])
          return { code: 0, stdout: '', stderr: '' }
        },
      })
    )
    expect(spawned).toEqual([
      ['setx', 'LLM_MODEL', 'openai/my/model'],
      ['setx', 'LLM_BASE_URL', 'http://127.0.0.1:1337/v1'],
      // Unlike Copilot, OpenHands gets the placeholder rather than no variable.
      ['setx', 'LLM_API_KEY', 'atomic'],
    ])
  })
})
