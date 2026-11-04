import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome } from '../../../test/helpers/agent-config-home.js'
import type { AgentHome } from '../../../test/helpers/agent-config-home.js'
import { nodeConfigFs } from '../config-io.js'
import { writerFor } from './registry.js'
import { configureZed, ZED_DEFAULT_MODEL_KEY, zedConfigDir } from './zed.js'

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

  it('writes the served window, a quarter of it for output, and no image input', async () => {
    home = await makeAgentHome()
    await configureZed({ ...agentInput(home.fs), contextLength: 16384 })
    const [entry] = (await settings()).language_models.openai_compatible['Atomic Chat'].available_models
    expect(entry.max_tokens).toBe(16384)
    expect(entry.max_output_tokens).toBe(4096)
    expect(entry.capabilities.images).toBe(false)

    // Every Connect rewrites it; unknown falls back to what Zed always got (it needs a value).
    await configureZed({ ...agentInput(home.fs), contextLength: 131072 })
    let models = (await settings()).language_models.openai_compatible['Atomic Chat'].available_models
    expect([models[0].max_tokens, models[0].max_output_tokens]).toEqual([131072, 8192])
    await configureZed(agentInput(home.fs))
    models = (await settings()).language_models.openai_compatible['Atomic Chat'].available_models
    expect([models[0].max_tokens, models[0].max_output_tokens]).toEqual([32768, 8192])
  })

  it("keeps the user's default model aside for Disconnect, never ours", async () => {
    home = await makeAgentHome()
    const user = { provider: 'ollama', model: 'llama3.2' }
    await home.seed(PATH, JSON.stringify({ agent: { default_model: user } }))
    await configureZed(agentInput(home.fs))
    await configureZed(agentInput(home.fs, { model: 'gemma' }))
    expect(JSON.parse((await home.read(`${PATH}.atomic-chat-backup.json`)) ?? '{}')).toEqual({
      [ZED_DEFAULT_MODEL_KEY]: user,
    })
    expect((await settings()).agent.default_model).toEqual({ provider: 'Atomic Chat', model: 'gemma' })
  })

  it('keeps no backup when the user had no default model', async () => {
    home = await makeAgentHome()
    await configureZed(agentInput(home.fs))
    expect(Object.keys(await home.tree())).toEqual([PATH])
  })

  it("finds Zed's config directory the way Zed does on each OS", async () => {
    home = await makeAgentHome()
    const fs = home.fs
    expect(zedConfigDir({}, 'darwin', fs)).toBe('.config/zed')
    // Linux honours an absolute $XDG_CONFIG_HOME, as Zed does.
    expect(zedConfigDir({ XDG_CONFIG_HOME: '/xdg' }, 'linux', fs)).toBe('/xdg/zed')
    expect(zedConfigDir({ XDG_CONFIG_HOME: 'relative' }, 'linux', fs)).toBe('.config/zed')
    expect(zedConfigDir({ XDG_CONFIG_HOME: '/xdg' }, 'darwin', fs)).toBe('.config/zed')
    // Windows: Roaming AppData, never %USERPROFILE%\.config.
    expect(zedConfigDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', fs)).toBe(
      'C:\\Users\\u\\AppData\\Roaming/Zed'
    )
    expect(zedConfigDir({}, 'win32', fs)).toBe(fs.absolute('AppData/Roaming/Zed'))
  })

  it('writes to %APPDATA%\\Zed on Windows', async () => {
    home = await makeAgentHome()
    const appData = `${home.path}/Roaming`
    await configureZed(agentInput(nodeConfigFs(home.path), { platform: 'win32', env: { APPDATA: appData } }))
    expect(Object.keys(await home.tree())).toEqual(['Roaming/Zed/settings.json'])
  })

  it('works from a home directory whose path contains a space', async () => {
    home = await makeAgentHome('atomic zed home-')
    await configureZed(agentInput(home.fs))
    expect(Object.keys(await home.tree())).toEqual([PATH])
  })
})
