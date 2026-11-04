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
    expect(Object.keys(await home.tree())).toEqual([
      'elsewhere/oc.json',
      'elsewhere/oc.json.atomic-chat-backup.json',
    ])
  })

  it('records what it overwrote, keeping the first original across reconnects', async () => {
    home = await makeAgentHome()
    await home.seed(
      '.openclaw/openclaw.json',
      JSON.stringify({ agents: { defaults: { model: 'openai/gpt-5.4', timeoutSeconds: 240 } } })
    )
    await configureOpenclaw({ ...agentInput(home.fs, { model: 'a' }), contextLength: 32768 })
    await configureOpenclaw(agentInput(home.fs, { model: 'b' }))
    const config = JSON.parse((await home.read('.openclaw/openclaw.json')) as string)
    // The 240 s cap older releases put on every model is gone, not restored.
    expect(config.agents.defaults).not.toHaveProperty('timeoutSeconds')
    expect(config.models.providers.atomic.timeoutSeconds).toBe(600)
    const backup = JSON.parse((await home.read('.openclaw/openclaw.json.atomic-chat-backup.json')) as string)
    expect(backup.keys).toEqual([
      { path: ['models', 'mode'], ours: 'merge' },
      { path: ['gateway', 'mode'], ours: 'local' },
      { path: ['gateway', 'auth', 'mode'], ours: 'none' },
      { path: ['agents', 'defaults', 'model', 'primary'], before: 'openai/gpt-5.4', ours: 'atomic/b' },
      { path: ['agents', 'defaults', 'models', 'atomic/b'], ours: {} },
      { path: ['agents', 'defaults', 'models', 'atomic/a'], ours: {} },
    ])
  })
})

describe('the model entry and the Gateway', () => {
  it('carries the served window and an output cap only when the window is known', () => {
    const entry = (ctx?: number) =>
      (
        openclawPatchConfig({}, 'u', 'm', 'k', ctx) as never as {
          models: { providers: { atomic: { models: Array<Record<string, unknown>> } } }
        }
      ).models.providers.atomic.models[0]
    expect(entry(65536)).toMatchObject({ contextWindow: 65536, maxTokens: 8192 })
    expect(entry(16384)).toMatchObject({ contextWindow: 16384, maxTokens: 4096 })
    expect(entry()).toEqual({ id: 'm', name: 'm' })
  })

  it('opens Gateway auth only when there is no secret to expect', () => {
    const auth = (root: object, envSecret = false) =>
      (
        openclawPatchConfig(root as never, 'u', 'm', 'k', undefined, envSecret) as never as {
          gateway: { auth?: Record<string, unknown> }
        }
      ).gateway.auth
    expect(auth({})).toEqual({ mode: 'none' })
    expect(auth({ gateway: { auth: { token: 't' } } })).toEqual({ token: 't' })
    expect(auth({}, true)).toBeUndefined()
  })
})
