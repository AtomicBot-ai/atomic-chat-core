import { lstat, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome, type AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configureCopilot, copilotProvidersPath, stripLegacyCopilotBlock } from './copilot.js'

const PROVIDERS = '.copilot/providers.json'
const URL = 'http://127.0.0.1:1337/v1'
const MODEL = 'AtomicChat/Qwen3.5-9B-GGUF'
const LEGACY_BLOCK =
  '# Atomic Chat - Copilot CLI Config\n' +
  "export COPILOT_PROVIDER_BASE_URL='http://127.0.0.1:1337/v1'\n" +
  "export COPILOT_PROVIDER_TYPE='openai'\n" +
  "export COPILOT_MODEL='m'\n" +
  "export COPILOT_OFFLINE='true'\n" +
  '\n' +
  '# Atomic Chat - Copilot CLI Config\n'

let home: AgentHome
afterEach(async () => {
  await home.cleanup()
})

const read = async () => JSON.parse((await home.read(PROVIDERS)) as string)

describe('configuring Copilot CLI', () => {
  it('writes our provider and a model limited to the served window', async () => {
    home = await makeAgentHome()
    await configureCopilot({ ...agentInput(home.fs, { apiKey: 'sk' }), contextLength: 16384 })
    expect(await read()).toEqual({
      providers: [{ name: 'atomic-chat', type: 'openai', baseUrl: URL, apiKey: 'sk' }],
      models: [
        {
          id: MODEL,
          provider: 'atomic-chat',
          maxContextWindowTokens: 16384,
          maxPromptTokens: 12288,
          maxOutputTokens: 4096,
        },
      ],
    })
    // Nothing user-wide: no shell rc is written.
    expect(Object.keys(await home.tree())).toEqual([PROVIDERS])
  })

  it('replaces only our entries on a rerun and keeps the user’s', async () => {
    home = await makeAgentHome()
    const theirs = {
      providers: [{ name: 'ollama', baseUrl: 'http://localhost:11434/v1' }],
      models: [{ id: 'qwen3:8b', provider: 'ollama' }],
    }
    await home.seed(PROVIDERS, JSON.stringify(theirs))
    await configureCopilot(agentInput(home.fs, { apiKey: 'sk' }))
    await configureCopilot({ ...agentInput(home.fs, { apiKey: '', model: 'other' }), platform: 'win32' })
    const written = await read()
    expect(written.providers).toEqual([
      ...theirs.providers,
      { name: 'atomic-chat', type: 'openai', baseUrl: URL },
    ])
    expect(written.models).toEqual([...theirs.models, { id: 'other', provider: 'atomic-chat' }])
  })

  it('collapses duplicate entries of ours into one, in the place of the first', async () => {
    home = await makeAgentHome()
    await home.seed(
      PROVIDERS,
      JSON.stringify({
        providers: [{ name: 'atomic-chat' }, { name: 'x' }, { name: 'atomic-chat' }],
        models: [
          { id: 'a', provider: 'atomic-chat' },
          { id: 'b', provider: 'x' },
          { id: 'c', provider: 'atomic-chat' },
        ],
        version: 2,
      })
    )
    await configureCopilot(agentInput(home.fs))
    const written = await read()
    expect(written.providers.map((p: { name: string }) => p.name)).toEqual(['atomic-chat', 'x'])
    expect(written.models.map((m: { id: string }) => m.id)).toEqual([MODEL, 'b'])
    expect(written.version).toBe(2)
  })

  it('refuses lists that are not lists, and files that are not objects, untouched', async () => {
    for (const bad of ['{"providers": {"a": 1}}', '{"models": "x"}', '[1]']) {
      home = await makeAgentHome()
      await home.seed(PROVIDERS, bad)
      await expect(configureCopilot(agentInput(home.fs)), bad).rejects.toThrow()
      expect(await home.read(PROVIDERS)).toBe(bad)
      await home.cleanup()
    }
    home = await makeAgentHome()
  })

  it('takes out exactly the rc block an earlier release wrote, through a link', async () => {
    home = await makeAgentHome()
    await home.seed('.zshenv', `export EDITOR=nvim\n${LEGACY_BLOCK}export COPILOT_MODEL='mine'\n`)
    const dotfiles = await makeAgentHome('atomic-copilot-dotfiles-')
    try {
      await dotfiles.seed('bashrc', LEGACY_BLOCK)
      await symlink(join(dotfiles.path, 'bashrc'), join(home.path, '.bashrc'))
      await home.seed('.bash_profile', 'export B=2\n')
      await configureCopilot(agentInput(home.fs))
      expect(await home.read('.zshenv')).toBe("export EDITOR=nvim\nexport COPILOT_MODEL='mine'\n")
      expect((await lstat(join(home.path, '.bashrc'))).isSymbolicLink()).toBe(true)
      expect(await readFile(join(dotfiles.path, 'bashrc'), 'utf8')).toBe('')
      expect(await home.read('.bash_profile')).toBe('export B=2\n')
    } finally {
      await dotfiles.cleanup()
    }
  })
})

describe('the legacy block', () => {
  it('is left alone when it holds anything else, or never closes', () => {
    expect(stripLegacyCopilotBlock('export A=1\n')).toBeUndefined()
    expect(
      stripLegacyCopilotBlock(LEGACY_BLOCK.replace("export COPILOT_MODEL='m'", 'alias c=copilot'))
    ).toBeUndefined()
    expect(
      stripLegacyCopilotBlock("# Atomic Chat - Copilot CLI Config\nexport COPILOT_MODEL='m'\n")
    ).toBeUndefined()
    expect(stripLegacyCopilotBlock(LEGACY_BLOCK.replace(/\n/g, '\r\n'))).toBe('')
  })
})

describe('copilotProvidersPath', () => {
  it('follows Copilot’s variables', () => {
    expect(copilotProvidersPath({}, '/h')).toBe('.copilot/providers.json')
    expect(copilotProvidersPath({ COPILOT_HOME: '/c' }, '/h')).toBe('/c/providers.json')
    expect(copilotProvidersPath({ COPILOT_HOME: '/c', COPILOT_PROVIDERS_CONFIG: '/p.json' }, '/h')).toBe(
      '/p.json'
    )
  })
})
