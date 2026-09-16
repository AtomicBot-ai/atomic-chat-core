import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome } from '../../../test/helpers/agent-config-home.js'
import type { AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configureOpencode } from './opencode.js'
import { writerFor } from './registry.js'

const PATH = '.config/opencode/opencode.json'

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

describe('configureOpencode', () => {
  it('is the writer the registry hands out for "opencode"', () => {
    expect(writerFor('opencode')).toBe(configureOpencode)
  })

  it("writes only opencode.json, and seeds OpenCode's own $schema", async () => {
    home = await makeAgentHome()
    await configureOpencode(agentInput(home.fs))
    const tree = await home.tree()
    expect(Object.keys(tree)).toEqual([PATH])
    expect(JSON.parse(tree[PATH] ?? '')['$schema']).toBe('https://opencode.ai/config.json')
  })

  it('refuses comments, unlike Kilo — this file is strict JSON', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, '{\n  // a comment\n  "theme": "nord"\n}\n')
    await expect(configureOpencode(agentInput(home.fs))).rejects.toThrow(/Failed to parse/)
    expect(await home.read(PATH)).toContain('// a comment')
  })

  it('reports a truncated file and writes nothing', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, '{"provider":')
    await expect(configureOpencode(agentInput(home.fs))).rejects.toThrow(/Failed to parse/)
    expect(await home.tree()).toEqual({ [PATH]: '{"provider":' })
  })

  it('rejects a config whose root is not an object', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, '"just a string"')
    await expect(configureOpencode(agentInput(home.fs))).rejects.toThrow('opencode.json is not a JSON object')
  })

  it('works from a home directory whose path contains a space', async () => {
    home = await makeAgentHome('atomic opencode home-')
    await configureOpencode(agentInput(home.fs))
    expect(Object.keys(await home.tree())).toEqual([PATH])
  })
})
