import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome, type AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configureCopilot } from './copilot.js'

let home: AgentHome
afterEach(async () => {
  await home.cleanup()
})

describe('configuring Copilot CLI', () => {
  it('omits the key variable entirely when there is none, on the Windows path too', async () => {
    home = await makeAgentHome()
    const spawned: string[][] = []
    await configureCopilot(
      agentInput(home.fs, {
        apiKey: '',
        platform: 'win32',
        spawn: async (program, args) => {
          spawned.push([program, ...args])
          return { code: 0, stdout: '', stderr: '' }
        },
      })
    )
    // Every other agent writes an `atomic` placeholder; an empty Copilot key would be sent as one.
    expect(spawned.map(([, key]) => key)).toEqual([
      'COPILOT_PROVIDER_BASE_URL',
      'COPILOT_PROVIDER_TYPE',
      'COPILOT_MODEL',
      'COPILOT_OFFLINE',
    ])
    expect(await home.tree()).toEqual({})
  })

  it('writes ~/.bashrc under a Linux bash login', async () => {
    home = await makeAgentHome()
    await configureCopilot(agentInput(home.fs, { platform: 'linux', shell: '/bin/bash' }))
    expect(await home.read('.bashrc')).toContain("export COPILOT_OFFLINE='true'")
  })
})
