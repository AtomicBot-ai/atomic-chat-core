import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome } from '../../../test/helpers/agent-config-home.js'
import type { AgentHome } from '../../../test/helpers/agent-config-home.js'
import { writerFor } from './registry.js'
import { configureZed } from './zed.js'

const PATH = '.config/zed/settings.json'

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settings = async (): Promise<any> => JSON.parse((await home.read(PATH)) ?? '{}')

describe('configureZed', () => {
  it('is the writer the registry hands out for "zed"', () => {
    expect(writerFor('zed')).toBe(configureZed)
  })

  it('never persists the API key — Zed reads it from the keychain or the environment', async () => {
    home = await makeAgentHome()
    await configureZed(agentInput(home.fs, { apiKey: 'sk-secret-do-not-store' }))
    expect(await home.read(PATH)).not.toContain('sk-secret-do-not-store')
  })

  it('registers the provider with no models and no default when nothing is loaded', async () => {
    home = await makeAgentHome()
    await configureZed(agentInput(home.fs, { model: '' }))
    const root = await settings()
    expect(root.language_models.openai_compatible['Atomic Chat'].available_models).toEqual([])
    expect(root).not.toHaveProperty('agent')
  })

  it('leaves another provider as the agent default when nothing is loaded', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, '{"agent": {"default_model": {"provider": "ollama", "model": "llama3.2"}}}')
    await configureZed(agentInput(home.fs, { model: '' }))
    expect((await settings()).agent.default_model).toEqual({ provider: 'ollama', model: 'llama3.2' })
  })

  it('replaces an `agent` key that is not an object', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, '{"agent": "v2"}')
    await configureZed(agentInput(home.fs))
    expect((await settings()).agent.default_model.provider).toBe('Atomic Chat')
  })

  it('replaces an openai_compatible map that is not an object, keeping sibling providers', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, '{"language_models": {"ollama": {"api_url": "x"}, "openai_compatible": 7}}')
    await configureZed(agentInput(home.fs))
    const models = (await settings()).language_models
    expect(models.ollama).toEqual({ api_url: 'x' })
    expect(Object.keys(models.openai_compatible)).toEqual(['Atomic Chat'])
  })

  it('accepts comments, because Zed does', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, '{\n  // Zed settings\n  "theme": "One Dark",\n}\n')
    await configureZed(agentInput(home.fs))
    expect((await settings()).theme).toBe('One Dark')
  })

  it('reports a broken settings.json and writes nothing', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, '{"language_models": [[}')
    await expect(configureZed(agentInput(home.fs))).rejects.toThrow(/Failed to parse/)
    expect(await home.tree()).toEqual({ [PATH]: '{"language_models": [[}' })
  })

  it('rejects a settings file whose root is not an object', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, '"nope"')
    await expect(configureZed(agentInput(home.fs))).rejects.toThrow('settings.json is not a JSON object')
  })

  it('works from a home directory whose path contains a space', async () => {
    home = await makeAgentHome('atomic zed home-')
    await configureZed(agentInput(home.fs))
    expect(Object.keys(await home.tree())).toEqual([PATH])
  })
})
