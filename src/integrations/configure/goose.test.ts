import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome, type AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configureGoose } from './goose.js'

let home: AgentHome
afterEach(async () => {
  await home.cleanup()
})

describe('configuring Goose', () => {
  it('drops a stale GOOSE_ export that leaked outside the block, but keeps every other line', async () => {
    home = await makeAgentHome()
    await home.seed(
      '.zshenv',
      ['export EDITOR=nvim', "export GOOSE_MODEL='hand-written'", "export OPENAI_API_KEY='mine'", ''].join(
        '\n'
      )
    )
    await configureGoose(agentInput(home.fs))
    const rc = (await home.read('.zshenv')) as string
    expect(rc).not.toContain('hand-written')
    // `OPENAI_` is not our prefix, so the user's own key survives above our block and is only
    // shadowed by the managed one below it.
    expect(rc.indexOf("export OPENAI_API_KEY='mine'")).toBeLessThan(rc.indexOf('# Atomic Chat'))
    expect(rc).toContain('export EDITOR=nvim')
  })

  it('reruns to a byte-identical file', async () => {
    home = await makeAgentHome()
    await configureGoose(agentInput(home.fs, { platform: 'linux', shell: '/bin/bash' }))
    const once = await home.read('.bashrc')
    await configureGoose(agentInput(home.fs, { platform: 'linux', shell: '/bin/bash' }))
    expect(await home.read('.bashrc')).toBe(once)
  })
})
