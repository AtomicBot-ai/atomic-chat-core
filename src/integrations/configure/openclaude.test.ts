import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome } from '../../../test/helpers/agent-config-home.js'
import type { AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configureOpenclaude } from './openclaude.js'
import { writerFor } from './registry.js'

const CONFIG = '.openclaude.json'
const PROFILE = '.openclaude/.openclaude-profile.json'
const SIDECAR = '.atomic-chat-backup.json'
const ALL_FILES = [CONFIG, `${CONFIG}${SIDECAR}`, PROFILE, `${PROFILE}${SIDECAR}`]

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

  it('writes exactly its two files and their backups', async () => {
    home = await makeAgentHome()
    await configureOpenclaude(agentInput(home.fs))
    expect(Object.keys(await home.tree())).toEqual(ALL_FILES)
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

  it("replaces our profile by its id and leaves the user's own Atomic Chat profile alone", async () => {
    home = await makeAgentHome()
    await home.seed(
      CONFIG,
      JSON.stringify({
        providerProfiles: [
          { id: 'mine', provider: 'atomic-chat', model: 'theirs' },
          { id: 'provider_atomic_chat', provider: 'something-else' },
        ],
      })
    )
    await configureOpenclaude(agentInput(home.fs))
    const profiles = (await config()).providerProfiles
    expect(profiles).toHaveLength(2)
    expect(profiles[0]).toEqual({ id: 'mine', provider: 'atomic-chat', model: 'theirs' })
    expect(profiles[1].provider).toBe('atomic-chat')
    expect(profiles[1].model).toBe('AtomicChat/Qwen3.5-9B-GGUF')
  })

  it('tells OpenClaude the window and an output cap, and keeps shell leftovers out', async () => {
    home = await makeAgentHome()
    await configureOpenclaude({ ...agentInput(home.fs), contextLength: 16384 })
    const root = await config()
    expect(root.providerProfiles[0].maxContextLength).toBe(16384)
    expect(JSON.parse(root.env['CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS'])).toEqual({
      'AtomicChat/Qwen3.5-9B-GGUF': 4096,
    })
    for (const name of ['CLAUDE_CODE_USE_OPENAI', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'OPENAI_MODEL']) {
      expect(root.env[name]).toBe('')
    }
    await configureOpenclaude(agentInput(home.fs))
    const again = await config()
    expect(again.providerProfiles[0]).not.toHaveProperty('maxContextLength')
    expect(again.env).not.toHaveProperty('CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS')
  })

  it("records the user's active profile and startup profile once, across reconnects", async () => {
    home = await makeAgentHome()
    const startup = { profile: 'openai', env: { OPENAI_MODEL: 'gpt-5' }, createdAt: 'x' }
    await home.seed(CONFIG, JSON.stringify({ activeProviderProfileId: 'personal', providerProfiles: [] }))
    await home.seed(PROFILE, JSON.stringify(startup))
    await configureOpenclaude(agentInput(home.fs))
    await configureOpenclaude(agentInput(home.fs, { model: 'other' }))
    const backup = JSON.parse((await home.read(`${CONFIG}${SIDECAR}`)) ?? '{}')
    expect(backup.entries[1]).toEqual({
      path: ['activeProviderProfileId'],
      existed: true,
      previous: 'personal',
      written: 'provider_atomic_chat',
    })
    const profileBackup = JSON.parse((await home.read(`${PROFILE}${SIDECAR}`)) ?? '{}')
    expect(profileBackup.entries[0].previous).toEqual(startup)
    expect(profileBackup.entries[0].written.env.OPENAI_MODEL).toBe('other')
  })

  it('follows $OPENCLAUDE_CONFIG_DIR, and its legacy .config.json when that exists', async () => {
    home = await makeAgentHome()
    const env = { OPENCLAUDE_CONFIG_DIR: `${home.path}/oc` }
    await configureOpenclaude(agentInput(home.fs, { env }))
    expect(Object.keys(await home.tree())).toEqual(
      ['oc/.openclaude.json', 'oc/.openclaude-profile.json'].flatMap((p) => [p, `${p}${SIDECAR}`]).sort()
    )
    await home.cleanup()
    home = await makeAgentHome()
    await home.seed('.openclaude/.config.json', '{"theme": "dark"}')
    await configureOpenclaude(agentInput(home.fs))
    const legacy = JSON.parse((await home.read('.openclaude/.config.json')) ?? '{}')
    expect(legacy.activeProviderProfileId).toBe('provider_atomic_chat')
    expect(await home.read(CONFIG)).toBeUndefined()
  })

  it('skips over non-object entries in the profile list instead of crashing', async () => {
    home = await makeAgentHome()
    await home.seed(CONFIG, '{"providerProfiles": [null, 42, "x"]}')
    await configureOpenclaude(agentInput(home.fs))
    const profiles = (await config()).providerProfiles
    expect(profiles).toHaveLength(4)
    expect(profiles[3].id).toBe('provider_atomic_chat')
  })

  it("sends the server's key — a keyed server would answer 401 without it", async () => {
    home = await makeAgentHome()
    await configureOpenclaude(agentInput(home.fs, { apiKey: 'sk-secret' }))
    expect((await config()).providerProfiles[0].apiKey).toBe('sk-secret')
    const startup = JSON.parse((await home.read(PROFILE)) ?? '{}')
    expect(startup.env.OPENAI_API_KEY).toBe('sk-secret')
    await configureOpenclaude(agentInput(home.fs, { apiKey: '' }))
    expect((await config()).providerProfiles[0].apiKey).toBe('atomic')
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
    expect(Object.keys(await home.tree())).toEqual(ALL_FILES)
  })
})
