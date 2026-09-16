import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome } from '../../../test/helpers/agent-config-home.js'
import type { AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configureKilo } from './kilo.js'
import { writerFor } from './registry.js'

const PATH = '.config/kilo/kilo.jsonc'

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

describe('configureKilo', () => {
  it('is the writer the registry hands out for "kilo"', () => {
    expect(writerFor('kilo')).toBe(configureKilo)
  })

  it("writes only kilo.jsonc, and seeds Kilo's own $schema", async () => {
    home = await makeAgentHome()
    await configureKilo(agentInput(home.fs))
    const tree = await home.tree()
    expect(Object.keys(tree)).toEqual([PATH])
    expect(JSON.parse(tree[PATH] ?? '')['$schema']).toBe('https://app.kilo.ai/config.json')
  })

  it('accepts JSON5 the strict parser would reject, and drops it on write', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, '{\n  /* block */ "theme": "dracula", // line\n}\n')
    await configureKilo(agentInput(home.fs))
    const written = (await home.read(PATH)) ?? ''
    expect(written).not.toContain('/* block */')
    expect(written).not.toContain('// line')
    expect(JSON.parse(written).theme).toBe('dracula')
  })

  it('reports a JSON5 syntax error and leaves the broken file untouched', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, '{ "provider": { ')
    await expect(configureKilo(agentInput(home.fs))).rejects.toThrow(/Failed to parse/)
    expect(await home.tree()).toEqual({ [PATH]: '{ "provider": { ' })
  })

  it('rejects a config whose root is not an object', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, '["not", "a", "config"]')
    await expect(configureKilo(agentInput(home.fs))).rejects.toThrow('kilo.jsonc is not a JSON object')
  })

  it('works from a home directory whose path contains a space', async () => {
    home = await makeAgentHome('atomic kilo home-')
    await configureKilo(agentInput(home.fs))
    expect(Object.keys(await home.tree())).toEqual([PATH])
  })
})
