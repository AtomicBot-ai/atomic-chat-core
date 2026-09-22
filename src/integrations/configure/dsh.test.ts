import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome, type AgentHome } from '../../../test/helpers/agent-config-home.js'
import { applyDshProvider, configureDsh, dshRouteNode, dshValidateEnvValue } from './dsh.js'

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

  it('rejects the key before settings.yaml exists, so no route points at a stored nothing', async () => {
    home = await makeAgentHome()
    await expect(configureDsh(agentInput(home.fs, { apiKey: 'sk bad' }))).rejects.toThrow()
    expect(await home.tree()).toEqual({})
  })

  it('honours $DSH_HOME, expanding a literal ~ that a quoted rc value can carry', async () => {
    home = await makeAgentHome()
    await configureDsh(agentInput(home.fs, { env: { DSH_HOME: ' ~/dev/dsh ' } }))
    expect(Object.keys(await home.tree())).toEqual(['dev/dsh/.env', 'dev/dsh/settings.yaml'])
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
})
