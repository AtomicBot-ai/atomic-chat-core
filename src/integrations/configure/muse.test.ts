import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome, type AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configureMuse } from './muse.js'

let home: AgentHome
afterEach(async () => {
  await home.cleanup()
})

describe('configuring Muse Code', () => {
  it('persists only the key: the endpoint and model are launch flags, not configuration', async () => {
    home = await makeAgentHome()
    await configureMuse(agentInput(home.fs, { apiUrl: 'http://a:1/v1', model: 'one' }))
    const first = await home.read('.zshenv')
    await home.cleanup()

    home = await makeAgentHome()
    await configureMuse(agentInput(home.fs, { apiUrl: 'http://b:2/v1', model: 'two' }))
    expect(await home.read('.zshenv')).toBe(first)
  })

  it('clobbers an unrelated META_ export, which is the cost of the prefix safety net', async () => {
    home = await makeAgentHome()
    await home.seed('.zshenv', "export META_LLAMA_HOME='/opt/llama'\n")
    await configureMuse(agentInput(home.fs))
    expect(await home.read('.zshenv')).not.toContain('META_LLAMA_HOME')
  })
})
