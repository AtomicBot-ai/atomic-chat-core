import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome, type AgentHome } from '../../../test/helpers/agent-config-home.js'
import { removeMarkedEnvBlock } from './legacy-env-block.js'
import { configurePoolside } from './poolside.js'

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

const MARKER = '# Atomic Chat - Poolside Config'

describe('configuring Poolside', () => {
  it('removes only the region between the paired markers', () => {
    const rc = `a\n${MARKER}\nexport POOLSIDE_API_KEY='atomic'\n\n${MARKER}\nexport POOLSIDE_API_KEY='cloud'\n`
    expect(removeMarkedEnvBlock(rc, MARKER)).toBe("a\nexport POOLSIDE_API_KEY='cloud'\n")
    expect(removeMarkedEnvBlock('a\n', MARKER)).toBe('a\n')
  })

  it("leaves another agent's block alone", async () => {
    home = await makeAgentHome()
    const muse =
      "# Atomic Chat - Muse Code Config\nexport META_API_KEY='atomic'\n\n# Atomic Chat - Muse Code Config\n"
    await home.seed('.bash_profile', muse)
    await configurePoolside(agentInput(home.fs, { shell: '/bin/bash' }))
    expect(await home.read('.bash_profile')).toBe(muse)
  })
})
