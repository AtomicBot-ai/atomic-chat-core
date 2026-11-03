import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome } from '../../../test/helpers/agent-config-home.js'
import type { AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configureClaudeCode } from './claude-code.js'
import { writerFor } from './registry.js'

const PATH = '.claude/settings.json'
const BACKUP = `${PATH}.atomic-chat-backup.json`
const MODEL_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
]

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

const settings = async (): Promise<Record<string, Record<string, string>>> =>
  JSON.parse((await home.read(PATH)) ?? '{}')

describe('configureClaudeCode', () => {
  it('is the writer the registry hands out for "claude-code"', () => {
    expect(writerFor('claude-code')).toBe(configureClaudeCode)
  })

  it('writes only ~/.claude/settings.json and its backup', async () => {
    home = await makeAgentHome()
    await configureClaudeCode(agentInput(home.fs))
    expect(Object.keys(await home.tree())).toEqual([PATH, BACKUP])
  })

  it('writes the window, an output cap, the provider switches and the title switch', async () => {
    home = await makeAgentHome()
    await configureClaudeCode({ ...agentInput(home.fs), contextLength: 32768 })
    let env = (await settings())['env']!
    expect(env['CLAUDE_CODE_MAX_CONTEXT_TOKENS']).toBe('32768')
    expect(env['CLAUDE_CODE_MAX_OUTPUT_TOKENS']).toBe('8192')
    expect(env['CLAUDE_CODE_DISABLE_TERMINAL_TITLE']).toBe('1')
    for (const name of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
      expect(env[name]).toBe('')
    }

    await configureClaudeCode({ ...agentInput(home.fs), contextLength: 16384 })
    expect((await settings())['env']?.['CLAUDE_CODE_MAX_OUTPUT_TOKENS']).toBe('4096')

    // An unknown window is not invented, and the earlier one does not linger.
    await configureClaudeCode(agentInput(home.fs))
    env = (await settings())['env']!
    expect(env).not.toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS')
    expect(env).not.toHaveProperty('CLAUDE_CODE_MAX_OUTPUT_TOKENS')
  })

  it("keeps the user's own values in the backup across reconnects", async () => {
    home = await makeAgentHome()
    await home.seed(PATH, JSON.stringify({ model: 'opus', env: { CLAUDE_CODE_USE_BEDROCK: '1' } }))
    await configureClaudeCode(agentInput(home.fs))
    await configureClaudeCode(agentInput(home.fs, { model: 'other' }))
    const backup = JSON.parse((await home.read(BACKUP)) ?? '{}')
    const entry = (key: string) =>
      backup.entries.find((e: { path: string[] }) => e.path[e.path.length - 1] === key)
    expect(entry('model')).toMatchObject({ existed: true, previous: 'opus', written: 'other' })
    expect(entry('CLAUDE_CODE_USE_BEDROCK')).toMatchObject({ existed: true, previous: '1', written: '' })
    expect(entry('ANTHROPIC_BASE_URL')).toEqual({
      path: ['env', 'ANTHROPIC_BASE_URL'],
      existed: false,
      written: 'http://127.0.0.1:1337/v1',
    })
    expect(backup.fileExisted).toBe(true)
  })

  it("takes an earlier release's values out instead of recording them as the user's", async () => {
    home = await makeAgentHome()
    await home.seed(
      PATH,
      JSON.stringify({
        model: 'old',
        env: {
          ANTHROPIC_BASE_URL: 'http://localhost:1337',
          ANTHROPIC_AUTH_TOKEN: 'atomic',
          ANTHROPIC_MODEL: 'old',
        },
      })
    )
    await configureClaudeCode(agentInput(home.fs, { apiUrl: 'http://127.0.0.1:1337' }))
    const backup = JSON.parse((await home.read(BACKUP)) ?? '{}')
    for (const entry of backup.entries) expect(entry.existed, JSON.stringify(entry.path)).toBe(false)
  })

  it('writes into $CLAUDE_CONFIG_DIR and reads past a byte-order mark', async () => {
    home = await makeAgentHome()
    await home.seed('cc/settings.json', '\uFEFF{"theme": "dark"}')
    await configureClaudeCode(agentInput(home.fs, { env: { CLAUDE_CONFIG_DIR: `${home.path}/cc` } }))
    expect(Object.keys(await home.tree())).toEqual([
      'cc/settings.json',
      'cc/settings.json.atomic-chat-backup.json',
    ])
    const root = JSON.parse((await home.read('cc/settings.json')) ?? '{}')
    expect(root['theme']).toBe('dark')
    expect(root['env']['ANTHROPIC_AUTH_TOKEN']).toBe('sk-atomic-fixture-key')
  })

  it('writes no model key at all on a fresh home when no model is loaded', async () => {
    home = await makeAgentHome()
    await configureClaudeCode(agentInput(home.fs, { model: '' }))
    const root = await settings()
    for (const key of MODEL_KEYS) expect(root['env']).not.toHaveProperty(key)
    expect(root).not.toHaveProperty('model')
  })

  it('leaves a user-written model key alone when no model is loaded', async () => {
    // "No model" means "do not touch the model", not "clear it" — a rerun must not orphan Claude
    // Code on a model name that no longer resolves.
    home = await makeAgentHome()
    await home.seed(PATH, JSON.stringify({ model: 'opus', env: { ANTHROPIC_MODEL: 'opus' } }))
    await configureClaudeCode(agentInput(home.fs, { model: '' }))
    const root = await settings()
    expect(root['model']).toBe('opus')
    expect(root['env']?.['ANTHROPIC_MODEL']).toBe('opus')
    expect(root['env']?.['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:1337/v1')
  })

  it('replaces an env value that is null, not just one that is a string', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, '{"env": null, "keep": true}')
    await configureClaudeCode(agentInput(home.fs))
    const root = await settings()
    expect(root['env']?.['ANTHROPIC_AUTH_TOKEN']).toBe('sk-atomic-fixture-key')
    expect(root['keep']).toBe(true)
  })

  it('falls back to the "atomic" placeholder token for a keyless server', async () => {
    home = await makeAgentHome()
    await configureClaudeCode(agentInput(home.fs, { apiKey: '' }))
    expect((await settings())['env']?.['ANTHROPIC_AUTH_TOKEN']).toBe('atomic')
  })

  it('reports a broken settings.json and writes nothing', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, '{"env": {,}}')
    await expect(configureClaudeCode(agentInput(home.fs))).rejects.toThrow(/Failed to parse/)
    expect(await home.tree()).toEqual({ [PATH]: '{"env": {,}}' })
  })

  it('rejects a settings file whose root is not an object', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, '[]')
    await expect(configureClaudeCode(agentInput(home.fs))).rejects.toThrow(
      'settings.json is not a JSON object'
    )
  })

  it('works from a home directory whose path contains a space', async () => {
    home = await makeAgentHome('atomic claude home-')
    await configureClaudeCode(agentInput(home.fs))
    expect(Object.keys(await home.tree())).toEqual([PATH, BACKUP])
  })
})
