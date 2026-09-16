import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome } from '../../../test/helpers/agent-config-home.js'
import type { AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configureClaudeCode } from './claude-code.js'
import { writerFor } from './registry.js'

const PATH = '.claude/settings.json'
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

  it('writes only ~/.claude/settings.json', async () => {
    home = await makeAgentHome()
    await configureClaudeCode(agentInput(home.fs))
    expect(Object.keys(await home.tree())).toEqual([PATH])
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
    expect(Object.keys(await home.tree())).toEqual([PATH])
  })
})
