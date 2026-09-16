import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome } from '../../../test/helpers/agent-config-home.js'
import type { AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configureMimo } from './mimo.js'
import { configureOpencode } from './opencode.js'
import { writerFor } from './registry.js'

const PATH = '.config/mimocode/mimocode.json'

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

describe('configureMimo', () => {
  it('is the writer the registry hands out for "mimo"', () => {
    expect(writerFor('mimo')).toBe(configureMimo)
  })

  it("writes only mimocode.json, and seeds MiMo's own $schema", async () => {
    home = await makeAgentHome()
    await configureMimo(agentInput(home.fs))
    const tree = await home.tree()
    expect(Object.keys(tree)).toEqual([PATH])
    expect(JSON.parse(tree[PATH] ?? '')['$schema']).toBe('https://mimo.xiaomi.com/config.json')
  })

  it("produces OpenCode's file field for field — only the path and $schema differ", async () => {
    // MiMo Code is a fork of OpenCode; if the two ever diverge it should be on purpose.
    home = await makeAgentHome()
    await configureMimo(agentInput(home.fs))
    await configureOpencode(agentInput(home.fs))
    const tree = await home.tree()
    const mimo = JSON.parse(tree[PATH] ?? '')
    const opencode = JSON.parse(tree['.config/opencode/opencode.json'] ?? '')
    delete mimo['$schema']
    delete opencode['$schema']
    expect(mimo).toEqual(opencode)
  })

  it('refuses comments — this file is strict JSON', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, '{ "theme": "nord", } // trailing\n')
    await expect(configureMimo(agentInput(home.fs))).rejects.toThrow(/Failed to parse/)
    expect(await home.tree()).toEqual({ [PATH]: '{ "theme": "nord", } // trailing\n' })
  })

  it('rejects a config whose root is not an object', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, '[]')
    await expect(configureMimo(agentInput(home.fs))).rejects.toThrow('mimocode.json is not a JSON object')
  })

  it('works from a home directory whose path contains a space', async () => {
    home = await makeAgentHome('atomic mimo home-')
    await configureMimo(agentInput(home.fs))
    expect(Object.keys(await home.tree())).toEqual([PATH])
  })
})
