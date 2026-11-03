import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome } from '../../../test/helpers/agent-config-home.js'
import type { AgentHome } from '../../../test/helpers/agent-config-home.js'
import { clineAuthCommand, clineProvidersPath, configureCline, spawnProcess } from './cline.js'
import { writerFor } from './registry.js'

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

const recorder = (result: { code: number; stdout: string; stderr: string }) => {
  const calls: Array<{ program: string; args: string[] }> = []
  return {
    calls,
    spawn: async (program: string, args: string[]) => {
      calls.push({ program, args })
      return result
    },
  }
}

const ok = { code: 0, stdout: '', stderr: '' }
const PROVIDER = 'openai-compatible'
const PROVIDERS = '.cline/data/settings/providers.json'

/** What `cline auth` does to providers.json: the entry merged over the old one, made last used. */
const fakeAuth = (h: AgentHome) => async (_program: string, args: string[]) => {
  const root = JSON.parse((await h.read(PROVIDERS)) ?? '{"version":1,"providers":{}}')
  const old = root.providers[PROVIDER]?.settings ?? {}
  const at = (flag: string) => args[args.indexOf(flag) + 1]
  root.providers[PROVIDER] = {
    settings: {
      ...old,
      provider: PROVIDER,
      apiKey: at('--apikey'),
      model: at('--modelid'),
      baseUrl: at('--baseurl'),
    },
  }
  root.lastUsedProvider = PROVIDER
  await h.seed(PROVIDERS, JSON.stringify(root))
  return ok
}

describe('clineAuthCommand', () => {
  it('spawns `cline` directly off Windows', () => {
    const { program, args } = clineAuthCommand('http://h/v1', 'm', 'k', 'darwin')
    expect(program).toBe('cline')
    expect(args).toEqual([
      'auth',
      '--provider',
      'openai-compatible',
      '--apikey',
      'k',
      '--modelid',
      'm',
      '--baseurl',
      'http://h/v1',
    ])
  })

  it('routes through `cmd /C` on Windows, where the npm shim is a .cmd batch file', () => {
    const { program, args } = clineAuthCommand('http://h/v1', 'm', 'k', 'win32')
    expect(program).toBe('cmd')
    expect(args.slice(0, 3)).toEqual(['/C', 'cline', 'auth'])
  })

  it('substitutes "local" for an empty key — not the "atomic" the file writers use', () => {
    // Cline rejects an empty --apikey outright, and its placeholder differs from every other agent's.
    expect(clineAuthCommand('u', 'm', '', 'linux').args).toContain('local')
    expect(clineAuthCommand('u', 'm', '', 'linux').args).not.toContain('atomic')
  })
})

describe('configureCline', () => {
  it('is the writer the registry hands out for "cline"', () => {
    expect(writerFor('cline')).toBe(configureCline)
  })

  it('writes only the backup when `cline auth` saved nothing to set a window on', async () => {
    home = await makeAgentHome()
    const rec = recorder(ok)
    await configureCline(agentInput(home.fs, { spawn: rec.spawn }))
    expect(Object.keys(await home.tree())).toEqual([`${PROVIDERS}.atomic-chat-backup.json`])
    expect(JSON.parse((await home.read(`${PROVIDERS}.atomic-chat-backup.json`)) as string)).toEqual({
      previous: { entry: null, lastUsedProvider: null },
      written: { baseUrl: 'http://127.0.0.1:1337/v1', model: 'AtomicChat/Qwen3.5-9B-GGUF' },
    })
    expect(rec.calls).toHaveLength(1)
  })

  it('sets the window on the entry `cline auth` saved, and clears it when unknown', async () => {
    home = await makeAgentHome()
    const theirs = {
      settings: { provider: PROVIDER, baseUrl: 'http://127.0.0.1:1234/v1', model: 'q', contextWindow: 4096 },
    }
    await home.seed(
      PROVIDERS,
      JSON.stringify({ version: 1, lastUsedProvider: 'anthropic', providers: { [PROVIDER]: theirs } })
    )
    const auth = fakeAuth(home)
    await configureCline({ ...agentInput(home.fs, { spawn: auth }), contextLength: 32768 })
    let saved = JSON.parse((await home.read(PROVIDERS)) as string)
    expect(saved.providers[PROVIDER].settings).toMatchObject({ contextWindow: 32768, maxTokens: 8192 })
    expect(saved.lastUsedProvider).toBe(PROVIDER)

    await configureCline(agentInput(home.fs, { spawn: auth }))
    saved = JSON.parse((await home.read(PROVIDERS)) as string)
    expect(saved.providers[PROVIDER].settings).not.toHaveProperty('contextWindow')
    expect(saved.providers[PROVIDER].settings).not.toHaveProperty('maxTokens')
    // The backup still holds what the user had before the first Connect.
    expect(JSON.parse((await home.read(`${PROVIDERS}.atomic-chat-backup.json`)) as string).previous).toEqual({
      lastUsedProvider: 'anthropic',
      entry: theirs,
    })
  })

  it('finds providers.json where Cline does', () => {
    expect(clineProvidersPath({}, '/h')).toBe('.cline/data/settings/providers.json')
    expect(clineProvidersPath({ CLINE_DIR: '/c' }, '/h')).toBe('/c/data/settings/providers.json')
    expect(clineProvidersPath({ CLINE_DIR: '/c', CLINE_DATA_DIR: '/d' }, '/h')).toBe(
      '/d/settings/providers.json'
    )
    expect(clineProvidersPath({ CLINE_PROVIDER_SETTINGS_PATH: '/p.json', CLINE_DIR: '/c' }, '/h')).toBe(
      '/p.json'
    )
  })

  it('refuses a providers.json it cannot read, before running anything', async () => {
    home = await makeAgentHome()
    await home.seed(PROVIDERS, '[1]')
    const rec = recorder(ok)
    await expect(configureCline(agentInput(home.fs, { spawn: rec.spawn }))).rejects.toThrow(
      'not a JSON object'
    )
    expect(rec.calls).toHaveLength(0)
  })

  it('surfaces stderr when `cline auth` exits non-zero', async () => {
    home = await makeAgentHome()
    const rec = recorder({ code: 1, stdout: 'ignored\n', stderr: '  rejected the credentials\n' })
    await expect(configureCline(agentInput(home.fs, { spawn: rec.spawn }))).rejects.toThrow(
      '`cline auth` failed: rejected the credentials'
    )
  })

  it('falls back to stdout when a failing run said nothing on stderr', async () => {
    home = await makeAgentHome()
    const rec = recorder({ code: 2, stdout: ' only on stdout \n', stderr: '   \n' })
    await expect(configureCline(agentInput(home.fs, { spawn: rec.spawn }))).rejects.toThrow(
      '`cline auth` failed: only on stdout'
    )
  })

  it('reports a launcher that cannot be started as a spawn failure', async () => {
    home = await makeAgentHome()
    const spawn = async () => {
      throw new Error('spawn cline ENOENT')
    }
    await expect(configureCline(agentInput(home.fs, { spawn }))).rejects.toThrow(
      "Failed to spawn 'cline': spawn cline ENOENT"
    )
  })

  it('passes the platform through, so a Windows run is wrapped in cmd', async () => {
    home = await makeAgentHome()
    const rec = recorder(ok)
    await configureCline(agentInput(home.fs, { platform: 'win32', spawn: rec.spawn }))
    expect(rec.calls[0]?.program).toBe('cmd')
  })
})

describe('spawnProcess', () => {
  // The default runner, exercised on a harmless program: running the real `cline` from a test
  // would rewrite whatever provider the developer has authenticated on this machine.
  it('reports a clean exit', async () => {
    expect(await spawnProcess(process.execPath, ['-e', 'process.stdout.write("hi")'])).toEqual({
      code: 0,
      stdout: 'hi',
      stderr: '',
    })
  })

  it('reports a non-zero exit with both streams instead of throwing', async () => {
    const result = await spawnProcess(process.execPath, [
      '-e',
      'process.stderr.write("boom"); process.exit(3)',
    ])
    expect(result).toEqual({ code: 3, stdout: '', stderr: 'boom' })
  })

  it('rejects when the program cannot be started at all', async () => {
    await expect(spawnProcess('atomic-no-such-program-xyz', [])).rejects.toThrow(/ENOENT/)
  })
})
