import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome, type AgentHome } from '../../../test/helpers/agent-config-home.js'
import { applyDshProvider, configureDsh, dshRouteNode, dshValidateEnvValue, hasYamlTag } from './dsh.js'

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

describe('validating what can go in a dotenv line', () => {
  it.each(['sk with space', 'sk\nOTHER=1', 'sk#c', 'sk"q', "sk'q", 'sk\tt'])('rejects %j', (value) => {
    // The message must name the variable and never the value, or a rejected key leaks into a log.
    expect(() => dshValidateEnvValue('ATOMIC_API_KEY', value)).toThrow(
      'ATOMIC_API_KEY contains characters that cannot be stored in a .env file'
    )
    try {
      dshValidateEnvValue('ATOMIC_API_KEY', value)
    } catch (e) {
      expect((e as Error).message).not.toContain('sk')
    }
  })

  it('accepts an ordinary key', () => {
    expect(() => dshValidateEnvValue('ATOMIC_API_KEY', 'sk-abc_123.def')).not.toThrow()
  })
})

describe('the route node', () => {
  it('omits apiKeyEnv entirely when keyless, rather than writing an empty reference', () => {
    expect(dshRouteNode('http://u', 'm', false)).not.toHaveProperty('apiKeyEnv')
    expect(dshRouteNode('http://u', 'm', true)).toHaveProperty('apiKeyEnv', 'ATOMIC_API_KEY')
  })
})

describe('applying the route to a parsed tree', () => {
  it('heals a bare `llm-pi-ai:` with nothing under it', () => {
    const out = applyDshProvider({ 'llm-pi-ai': null }, 'http://u', 'm', false) as Record<string, never>
    expect(out['llm-pi-ai']).toHaveProperty('providers')
  })

  it('refuses to overwrite a section that holds real user content', () => {
    expect(() => applyDshProvider({ 'llm-pi-ai': 'mine' }, 'http://u', 'm', false)).toThrow(
      '`llm-pi-ai` in settings.yaml is not a mapping. Fix or remove it and try again.'
    )
  })

  it('refuses a top level that is not a mapping', () => {
    expect(() => applyDshProvider([1], 'http://u', 'm', false)).toThrow('not a YAML mapping')
  })
})

describe('configuring dsh', () => {
  it('writes nothing when the URL or the model is blank', async () => {
    for (const over of [{ apiUrl: '   ' }, { model: '' }]) {
      home = await makeAgentHome()
      await expect(configureDsh(agentInput(home.fs, over))).rejects.toThrow()
      expect(await home.tree(), JSON.stringify(over)).toEqual({})
      await home.cleanup()
    }
    home = await makeAgentHome()
  })

  it('rejects the key before anything is written, so no route points at a stored nothing', async () => {
    home = await makeAgentHome()
    await expect(configureDsh(agentInput(home.fs, { apiKey: 'sk bad' }))).rejects.toThrow()
    expect(await home.tree()).toEqual({})
  })

  it('honours $DSH_HOME, expanding a literal ~ that a quoted rc value can carry', async () => {
    home = await makeAgentHome()
    await configureDsh(agentInput(home.fs, { env: { DSH_HOME: ' ~/dev/dsh ' } }))
    expect(Object.keys(await home.tree())).toEqual([
      'dev/dsh/.env',
      'dev/dsh/profiles/web/cordis.patch.yml',
      'dev/dsh/profiles/web/cordis.patch.yml.atomic-chat-backup.json',
    ])
  })

  // NTFS has no POSIX modes: chmod there only toggles read-only.
  it.skipIf(process.platform === 'win32')('restricts the credential file to its owner on unix', async () => {
    home = await makeAgentHome()
    await configureDsh(agentInput(home.fs, { platform: 'linux' }))
    const mode = (await stat(join(home.path, '.dsh', '.env'))).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('preserves the user lines around our managed block in .env', async () => {
    home = await makeAgentHome()
    await home.seed('.dsh/.env', 'OTHER=1\n')
    await configureDsh(agentInput(home.fs))
    expect(await home.read('.dsh/.env')).toBe(
      'OTHER=1\n\n# >>> Atomic Chat (managed) >>>\nATOMIC_API_KEY=sk-atomic-fixture-key\n' +
        '# <<< Atomic Chat (managed) <<<\n'
    )
    // Keyless: our block goes, the user's line stays.
    await configureDsh(agentInput(home.fs, { apiKey: '' }))
    expect(await home.read('.dsh/.env')).toBe('OTHER=1\n')
  })

  it('declares a known window on the model, and leaves dsh its defaults otherwise', () => {
    expect(dshRouteNode('http://u', 'm', false, 16384)['models']).toEqual([
      { id: 'm', contextWindow: 16384, maxTokens: 4096 },
    ])
    expect(dshRouteNode('http://u', 'm', false)['models']).toEqual([{ id: 'm' }])
  })
})

const PATCH = '.dsh/profiles/web/cordis.patch.yml'
const TEMPLATE =
  '# Your patch layer for this dsh profile, applied after every bundle layer:\n' +
  '# a top-level YAML array of loader patch entries (id-targeted config\n' +
  '# overrides, disables, and insert lists; `!!js` expressions allowed).\n' +
  '[]\n'
const ROUTE_ROW =
  "- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n  config:\n    providers:\n      atomic:\n" +
  '        displayName: Atomic Chat\n        api: openai-completions\n        baseURL: http://127.0.0.1:1337/v1\n' +
  '        apiKeyEnv: ATOMIC_API_KEY\n        models:\n        - id: AtomicChat/Qwen3.5-9B-GGUF\n' +
  '          contextWindow: 32768\n          maxTokens: 8192\n'
const DEFAULT_ROW =
  "- id: agent-default-model\n  name: '@deepseek-ai/dsh-agent-default-model'\n  config:\n" +
  '    provider: atomic\n    model: AtomicChat/Qwen3.5-9B-GGUF\n'

describe('the profile patch', () => {
  it('replaces the empty list of a new profile, keeping its comment', async () => {
    home = await makeAgentHome()
    await home.seed(PATCH, TEMPLATE)
    await configureDsh({ ...agentInput(home.fs), contextLength: 32768 })
    expect(await home.read(PATCH)).toBe(TEMPLATE.replace('[]\n', '') + ROUTE_ROW + DEFAULT_ROW)
    expect(JSON.parse((await home.read(`${PATCH}.atomic-chat-backup.json`)) as string)).toEqual({
      previous: { defaultModel: null },
      written: { defaultModel: { model: 'AtomicChat/Qwen3.5-9B-GGUF', provider: 'atomic' } },
    })
  })

  it('edits only our rows, keeping other rows, comments and !!js expressions byte for byte', async () => {
    home = await makeAgentHome()
    const mine =
      '# mine\n- id: session-persistence-jsonl\n  config:\n    root: !!js dshHomePath("elsewhere")\n\n# my gateway\n'
    await home.seed(
      PATCH,
      mine +
        '- id: llm-pi-ai\n  config:\n    providers:\n      gw:\n        api: openai-completions\n' +
        '        baseURL: https://gw.example/v1\n        models:\n          - id: x\n' +
        '- id: agent-default-model\n  config:\n    provider: gw\n    model: x\n'
    )
    await configureDsh(agentInput(home.fs))
    await configureDsh(agentInput(home.fs, { model: 'other' }))
    const text = (await home.read(PATCH)) as string
    expect(text.startsWith(mine)).toBe(true)
    expect(text).toContain('      gw:\n')
    expect(text).toContain('    provider: atomic\n    model: other\n')
    expect(JSON.parse((await home.read(`${PATCH}.atomic-chat-backup.json`)) as string).previous).toEqual({
      defaultModel: { provider: 'gw', model: 'x' },
    })
  })

  it('rewrites a flow list whole, and refuses !!js it would lose', async () => {
    home = await makeAgentHome()
    await home.seed(PATCH, '[{id: web-app, config: {port: 4000}}]\n')
    await configureDsh(agentInput(home.fs, { apiKey: '' }))
    expect(
      ((await home.read(PATCH)) as string).startsWith(
        '- id: web-app\n  config:\n    port: 4000\n- id: llm-pi-ai\n'
      )
    ).toBe(true)
    for (const bad of [
      '[{id: x, config: {root: !!js f()}}]\n',
      '- id: llm-pi-ai\n  config:\n    providers:\n      gw:\n        baseURL: !!js env.GW\n',
    ]) {
      await home.seed(PATCH, bad)
      await expect(configureDsh(agentInput(home.fs)), bad).rejects.toThrow('!!js')
      expect(await home.read(PATCH)).toBe(bad)
    }
  })

  it('refuses a patch that is not a list of mappings', async () => {
    home = await makeAgentHome()
    for (const bad of ['web-app: {}\n', '- 1\n']) {
      await home.seed(PATCH, bad)
      await expect(configureDsh(agentInput(home.fs)), bad).rejects.toThrow()
      expect(await home.read(PATCH)).toBe(bad)
    }
    await home.seed(PATCH, '- id: llm-pi-ai\n  config: [1]\n')
    await expect(configureDsh(agentInput(home.fs))).rejects.toThrow('is not a mapping')
  })

  it('refuses a patch that is not YAML, untouched', async () => {
    home = await makeAgentHome()
    await home.seed(PATCH, '- id: [\n')
    await expect(configureDsh(agentInput(home.fs))).rejects.toThrow('Failed to parse')
    expect(await home.read(PATCH)).toBe('- id: [\n')
  })

  it('rewrites a patch whole when its rows only parse together', async () => {
    home = await makeAgentHome()
    // The alias in the second row needs the anchor in the first.
    await home.seed(PATCH, '- id: a\n  config: &c {x: 1}\n- id: b\n  config: *c\n')
    await configureDsh(agentInput(home.fs))
    const text = (await home.read(PATCH)) as string
    expect(
      text.startsWith('- id: a\n  config:\n    x: 1\n- id: b\n  config:\n    x: 1\n- id: llm-pi-ai\n')
    ).toBe(true)
  })

  it('tells tags from text', () => {
    expect(hasYamlTag("  root: !!js dshHomePath('x')")).toBe(true)
    expect(hasYamlTag("# `!!js` allowed\nname: 'hi!'")).toBe(false)
  })
})

describe('a legacy settings.yaml', () => {
  it('is kept in step while it exists, and settings.yaml.imported is never touched', async () => {
    home = await makeAgentHome()
    await home.seed(
      '.dsh/settings.yaml',
      'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-flash\n'
    )
    await home.seed('.dsh/settings.yaml.imported', 'llm-pi-ai: {}\n')
    await configureDsh(agentInput(home.fs))
    await configureDsh(agentInput(home.fs))
    const settings = (await home.read('.dsh/settings.yaml')) as string
    expect(settings).toContain('agent-default-model:\n  provider: atomic\n')
    expect(settings).toContain('baseURL: http://127.0.0.1:1337/v1')
    expect(await home.read('.dsh/settings.yaml.imported')).toBe('llm-pi-ai: {}\n')
    expect(JSON.parse((await home.read('.dsh/settings.yaml.atomic-chat-backup.json')) as string)).toEqual({
      previous: { defaultModel: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    })
  })
})
