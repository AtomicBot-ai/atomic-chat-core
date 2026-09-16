import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome } from '../../../test/helpers/agent-config-home.js'
import type { AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configureOpenclaude } from './openclaude.js'
import { writerFor } from './registry.js'

const CONFIG = '.openclaude.json'
const PROFILE = '.openclaude/.openclaude-profile.json'

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const config = async (): Promise<any> => JSON.parse((await home.read(CONFIG)) ?? '{}')

describe('configureOpenclaude', () => {
  it('is the writer the registry hands out for "openclaude"', () => {
    expect(writerFor('openclaude')).toBe(configureOpenclaude)
  })

  it('writes exactly its two files', async () => {
    home = await makeAgentHome()
    await configureOpenclaude(agentInput(home.fs))
    expect(Object.keys(await home.tree())).toEqual([CONFIG, PROFILE])
  })

  it('stamps createdAt with a real RFC 3339 instant, not a placeholder', async () => {
    home = await makeAgentHome()
    const before = Date.now()
    await configureOpenclaude(agentInput(home.fs))
    const { createdAt } = JSON.parse((await home.read(PROFILE)) ?? '{}')
    expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(Date.parse(createdAt)).toBeGreaterThanOrEqual(before - 1000)
    expect(Date.parse(createdAt)).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('replaces the first match, whether it matched by id or by provider', async () => {
    home = await makeAgentHome()
    await home.seed(
      CONFIG,
      JSON.stringify({
        providerProfiles: [
          { id: 'renamed', provider: 'atomic-chat', stale: true },
          { id: 'provider_atomic_chat', provider: 'something-else' },
        ],
      })
    )
    await configureOpenclaude(agentInput(home.fs))
    const profiles = (await config()).providerProfiles
    // First match wins: the provider-matched entry is rewritten, the id-matched one is left as is,
    // which is how a config can end up holding two entries with our id.
    expect(profiles[0]).not.toHaveProperty('stale')
    expect(profiles[0].id).toBe('provider_atomic_chat')
    expect(profiles[1]).toEqual({ id: 'provider_atomic_chat', provider: 'something-else' })
  })

  it('skips over non-object entries in the profile list instead of crashing', async () => {
    home = await makeAgentHome()
    await home.seed(CONFIG, '{"providerProfiles": [null, 42, "x"]}')
    await configureOpenclaude(agentInput(home.fs))
    const profiles = (await config()).providerProfiles
    expect(profiles).toHaveLength(4)
    expect(profiles[3].id).toBe('provider_atomic_chat')
  })

  it('ignores the API key entirely — keyed and keyless produce the same bytes', async () => {
    home = await makeAgentHome()
    await configureOpenclaude(agentInput(home.fs, { apiKey: 'sk-secret' }))
    const keyed = await home.read(CONFIG)
    await configureOpenclaude(agentInput(home.fs, { apiKey: '' }))
    expect(await home.read(CONFIG)).toBe(keyed)
    expect(keyed).not.toContain('sk-secret')
  })

  it('writes neither file when the global config is unparsable', async () => {
    home = await makeAgentHome()
    await home.seed(CONFIG, '{"providerProfiles": [')
    await expect(configureOpenclaude(agentInput(home.fs))).rejects.toThrow(/Failed to parse/)
    expect(await home.tree()).toEqual({ [CONFIG]: '{"providerProfiles": [' })
  })

  it('rejects a global config whose root is not an object', async () => {
    home = await makeAgentHome()
    await home.seed(CONFIG, '[]')
    await expect(configureOpenclaude(agentInput(home.fs))).rejects.toThrow(/is not a JSON object/)
  })

  it('works from a home directory whose path contains a space', async () => {
    home = await makeAgentHome('atomic openclaude home-')
    await configureOpenclaude(agentInput(home.fs))
    expect(Object.keys(await home.tree())).toEqual([CONFIG, PROFILE])
  })
})
