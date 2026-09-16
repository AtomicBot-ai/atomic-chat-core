import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome, type AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configureOpenclaw, modelPolicyAllows, openclawPatchConfig } from './openclaw.js'

let home: AgentHome | undefined
afterEach(async () => {
  await home?.cleanup()
})

describe('an OpenClaw allow-list entry', () => {
  const ref = 'atomic/some-model'
  it.each([
    ['exact match', ['atomic/some-model'], true],
    ['provider wildcard', ['atomic/*'], true],
    ['bare wildcard', ['*'], true],
    ['different provider', ['openai/gpt-5'], false],
    ['prefix that does not reach', ['atomicx/*'], false],
    ['non-string entries are ignored', [42, null], false],
  ])('%s', (_name, list, expected) => {
    expect(modelPolicyAllows(list as never[], ref)).toBe(expected)
  })
})

describe('patching openclaw.json', () => {
  it('rejects a block whose type it cannot merge into, naming the block', () => {
    expect(() => openclawPatchConfig({ models: 'nope' }, 'u', 'm', 'k')).toThrow(
      'models is not a JSON object'
    )
    expect(() => openclawPatchConfig({ agents: { defaults: [] } }, 'u', 'm', 'k')).toThrow(
      'agents.defaults is not a JSON object'
    )
    expect(() => openclawPatchConfig([], 'u', 'm', 'k')).toThrow('openclaw.json is not a JSON object')
  })

  it('leaves an absent modelPolicy absent: writing one would introduce a restriction', () => {
    const out = openclawPatchConfig({}, 'u', 'm', 'k') as {
      agents: { defaults: Record<string, unknown> }
    }
    expect(out.agents.defaults).not.toHaveProperty('modelPolicy')
  })

  it('keeps a per-model settings entry the user already tuned', () => {
    const seeded = { agents: { defaults: { models: { 'atomic/m': { temperature: 0.1 } } } } }
    const out = openclawPatchConfig(seeded, 'u', 'm', 'k') as never
    const models = (out as { agents: { defaults: { models: Record<string, unknown> } } }).agents.defaults
      .models
    expect(models['atomic/m']).toEqual({ temperature: 0.1 })
  })
})

describe('configuring OpenClaw', () => {
  it('honours OPENCLAW_CONFIG_PATH instead of the default location', async () => {
    home = await makeAgentHome()
    await configureOpenclaw(agentInput(home.fs, { env: { OPENCLAW_CONFIG_PATH: 'elsewhere/oc.json' } }))
    expect(Object.keys(await home.tree())).toEqual(['elsewhere/oc.json'])
  })
})
