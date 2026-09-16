import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome, type AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configurePoolside } from './poolside.js'

let home: AgentHome
afterEach(async () => {
  await home.cleanup()
})

describe('configuring Poolside', () => {
  it('normalises the base URL the same way on the Windows path', async () => {
    home = await makeAgentHome()
    const spawned: string[][] = []
    await configurePoolside(
      agentInput(home.fs, {
        apiUrl: ' http://127.0.0.1:1337/v1/ ',
        platform: 'win32',
        spawn: async (program, args) => {
          spawned.push([program, ...args])
          return { code: 0, stdout: '', stderr: '' }
        },
      })
    )
    expect(spawned[0]).toEqual(['setx', 'POOLSIDE_STANDALONE_BASE_URL', 'http://127.0.0.1:1337'])
  })

  it('leaves a URL that only looks like it ends in /v1 alone', async () => {
    home = await makeAgentHome()
    // `/v1beta` is not the `/v1` suffix, so nothing is stripped but the trailing slash.
    await configurePoolside(agentInput(home.fs, { apiUrl: 'http://host:1337/v1beta/' }))
    expect(await home.read('.zshenv')).toContain(
      "export POOLSIDE_STANDALONE_BASE_URL='http://host:1337/v1beta'"
    )
  })
})
