import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome } from '../../../test/helpers/agent-config-home.js'
import type { AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configureCodex } from './codex.js'
import { writerFor } from './registry.js'

const PATH = '.codex/config.toml'

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

describe('configureCodex', () => {
  it('is the writer the registry hands out for "codex"', () => {
    expect(writerFor('codex')).toBe(configureCodex)
  })

  it('puts the bare root keys above everything, as TOML requires', async () => {
    // `model` / `model_provider` are bare keys; TOML only accepts those before the first [table],
    // so the head block has to be the very first thing in the file.
    home = await makeAgentHome()
    await home.seed(PATH, '[model_providers.openai]\nname = "OpenAI"\n')
    await configureCodex(agentInput(home.fs))
    const written = (await home.read(PATH)) ?? ''
    expect(written.indexOf('model = "')).toBeLessThan(written.indexOf('[model_providers.openai]'))
  })

  it("preserves the user's leading blank lines and trims only the end", async () => {
    home = await makeAgentHome()
    await home.seed(PATH, '\n\n  approval_policy = "never"\n\n\n')
    await configureCodex(agentInput(home.fs))
    const written = (await home.read(PATH)) ?? ''
    expect(written).toContain('# <<< Atomic Chat (managed) <<<\n\n\n\n  approval_policy = "never"\n# >>>')
  })

  it('is idempotent across repeated runs', async () => {
    home = await makeAgentHome()
    await configureCodex(agentInput(home.fs))
    const once = await home.read(PATH)
    await configureCodex(agentInput(home.fs))
    await configureCodex(agentInput(home.fs))
    expect(await home.read(PATH)).toBe(once)
  })

  it('escapes only backslashes and double quotes, the two TOML basic strings care about', async () => {
    home = await makeAgentHome()
    await configureCodex(agentInput(home.fs, { model: 'a\\b"c\td', apiUrl: 'http://h/v1?q="x"' }))
    const written = (await home.read(PATH)) ?? ''
    expect(written).toContain('model = "a\\\\b\\"c\td"')
    expect(written).toContain('base_url = "http://h/v1?q=\\"x\\""')
  })

  it('omits env_key entirely for a keyless server rather than writing a placeholder', async () => {
    home = await makeAgentHome()
    await configureCodex(agentInput(home.fs, { apiKey: '' }))
    expect(await home.read(PATH)).not.toContain('env_key')
  })

  it('drops the env_key line again when a keyed run is followed by a keyless one', async () => {
    home = await makeAgentHome()
    await configureCodex(agentInput(home.fs))
    expect(await home.read(PATH)).toContain('env_key')
    await configureCodex(agentInput(home.fs, { apiKey: '' }))
    expect(await home.read(PATH)).not.toContain('env_key')
  })

  it('treats a file of nothing but whitespace as empty', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, '\n \t\n')
    await configureCodex(agentInput(home.fs))
    const fresh = await makeAgentHome()
    await configureCodex(agentInput(fresh.fs))
    expect(await home.read(PATH)).toBe(await fresh.read(PATH))
    await fresh.cleanup()
  })

  it('never parses the TOML, so content it cannot understand survives untouched', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, 'this is = not [valid toml\n')
    await configureCodex(agentInput(home.fs))
    expect(await home.read(PATH)).toContain('this is = not [valid toml')
  })

  it('writes only config.toml, from a home directory whose path contains a space', async () => {
    home = await makeAgentHome('atomic codex home-')
    await configureCodex(agentInput(home.fs))
    expect(Object.keys(await home.tree())).toEqual([PATH])
  })
})
