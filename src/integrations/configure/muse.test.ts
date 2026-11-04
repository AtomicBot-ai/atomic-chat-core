import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome, type AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configureMuse } from './muse.js'

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

describe('configuring Muse Code', () => {
  it('writes nothing: the endpoint, model and key all go on the launch', async () => {
    home = await makeAgentHome()
    await configureMuse(agentInput(home.fs, { apiUrl: 'http://a:1/v1', model: 'one' }))
    expect(await home.tree()).toEqual({})
  })

  it('keeps an unrelated META_ export, which older releases deleted', async () => {
    home = await makeAgentHome()
    const rc =
      "export META_LLAMA_HOME='/opt/llama'\n# Atomic Chat - Muse Code Config\nexport META_API_KEY='atomic'\n\n" +
      '# Atomic Chat - Muse Code Config\n'
    await home.seed('.zshenv', rc)
    await configureMuse(agentInput(home.fs))
    expect(await home.read('.zshenv')).toBe("export META_LLAMA_HOME='/opt/llama'\n")
  })
})
