import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome } from '../../../test/helpers/agent-config-home.js'
import type { AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configurePi } from './pi.js'
import { writerFor } from './registry.js'

const MODELS = '.pi/agent/models.json'
const SETTINGS = '.pi/agent/settings.json'

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

describe('configurePi', () => {
  it('is the writer the registry hands out for "pi"', () => {
    expect(writerFor('pi')).toBe(configurePi)
  })

  it('writes exactly its two files', async () => {
    home = await makeAgentHome()
    await configurePi(agentInput(home.fs))
    expect(Object.keys(await home.tree())).toEqual([MODELS, SETTINGS])
  })

  it('still updates models.json when settings.json is unparsable', async () => {
    // models.json is written before settings.json is even read, so the failure is half-applied.
    // Recording that here means a future refactor to "write both or neither" is a visible change.
    home = await makeAgentHome()
    await home.seed(SETTINGS, '{ "theme": ')
    await expect(configurePi(agentInput(home.fs))).rejects.toThrow(/Failed to parse/)
    const tree = await home.tree()
    expect(JSON.parse(tree[MODELS] ?? '').providers.atomic.baseUrl).toBe('http://127.0.0.1:1337/v1')
    expect(tree[SETTINGS]).toBe('{ "theme": ')
  })

  it('writes neither file when models.json is unparsable', async () => {
    home = await makeAgentHome()
    await home.seed(MODELS, 'not json at all')
    await expect(configurePi(agentInput(home.fs))).rejects.toThrow(/Failed to parse/)
    expect(await home.tree()).toEqual({ [MODELS]: 'not json at all' })
  })

  it('names each broken file in its own error', async () => {
    home = await makeAgentHome()
    await home.seed(MODELS, '[]')
    await expect(configurePi(agentInput(home.fs))).rejects.toThrow('models.json is not a JSON object')
    await home.seed(MODELS, '{}')
    await home.seed(SETTINGS, '[]')
    await expect(configurePi(agentInput(home.fs))).rejects.toThrow('settings.json is not a JSON object')
  })

  it('falls back to the "atomic" placeholder key for a keyless server', async () => {
    home = await makeAgentHome()
    await configurePi(agentInput(home.fs, { apiKey: '' }))
    expect(JSON.parse((await home.read(MODELS)) ?? '').providers.atomic.apiKey).toBe('atomic')
  })

  it('replaces a providers map that is not an object and keeps other settings', async () => {
    home = await makeAgentHome()
    await home.seed(MODELS, '{"providers": 1}')
    await home.seed(SETTINGS, '{"theme": "nord"}')
    await configurePi(agentInput(home.fs))
    expect(Object.keys(JSON.parse((await home.read(MODELS)) ?? '').providers)).toEqual(['atomic'])
    expect(JSON.parse((await home.read(SETTINGS)) ?? '').theme).toBe('nord')
  })

  it('works from a home directory whose path contains a space', async () => {
    home = await makeAgentHome('atomic pi home-')
    await configurePi(agentInput(home.fs))
    expect(Object.keys(await home.tree())).toEqual([MODELS, SETTINGS])
  })
})
