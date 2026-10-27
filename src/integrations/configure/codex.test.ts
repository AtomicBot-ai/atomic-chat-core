import { join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome } from '../../../test/helpers/agent-config-home.js'
import type { AgentHome } from '../../../test/helpers/agent-config-home.js'
import { ATOMIC_MANAGED_BEGIN as BEGIN, ATOMIC_MANAGED_END as END } from '../config-io.js'
import {
  CODEX_PROFILE,
  codexHome,
  codexProfilePath,
  configureCodex,
  isCodexTooOld,
  parseCodexVersion,
  renderCodexProfile,
  writeCodexProfile,
} from './codex.js'
import type { ConfigureInput } from './registry.js'
import { writerFor } from './registry.js'

const PROFILE = '.codex/atomic-chat.config.toml'
const CONFIG = '.codex/config.toml'

/** The contract's golden example: model, endpoint and key `sk-x`. */
const GOLDEN =
  '# Managed by Atomic Chat: `codex --profile atomic-chat` runs Codex on your local models.\n' +
  '# Atomic Chat rewrites this file when Codex is connected again and deletes it on disconnect.\n' +
  'model = "AtomicChat/Qwen3.5-9B-GGUF"\n' +
  'model_provider = "atomic-chat"\n' +
  '\n' +
  '[model_providers.atomic-chat]\n' +
  'name = "Atomic Chat"\n' +
  'base_url = "http://127.0.0.1:1337/v1"\n' +
  'env_key = "ATOMIC_CHAT_API_KEY"\n'
const GOLDEN_KEYLESS = GOLDEN.replace('env_key = "ATOMIC_CHAT_API_KEY"\n', '')

const LEGACY_V2 =
  `${BEGIN}\nmodel = "AtomicChat/Qwen3.5-9B-GGUF"\nmodel_provider = "atomic"\n${END}\n\n` +
  'model = "gpt-5.5"\n' +
  `${BEGIN}\n[model_providers.atomic]\nname = "Atomic Chat"\nbase_url = "http://127.0.0.1:1337/v1"\n${END}\n`

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

type Spawn = NonNullable<ConfigureInput['spawn']>
const answering =
  (stdout: string, code = 0, calls: Array<[string, string[]]> = []): Spawn =>
  async (program, args) => {
    calls.push([program, args])
    return { code, stdout, stderr: '' }
  }

describe('configureCodex', () => {
  it('is the writer the registry hands out for "codex"', () => {
    expect(writerFor('codex')).toBe(configureCodex)
  })

  it('writes the profile, byte for byte, and nothing else', async () => {
    home = await makeAgentHome()
    await configureCodex(agentInput(home.fs, { apiKey: 'sk-x' }))
    expect(await home.tree()).toEqual({ [PROFILE]: GOLDEN })
  })

  it('omits env_key for a keyless server rather than writing a placeholder', async () => {
    home = await makeAgentHome()
    await configureCodex(agentInput(home.fs, { apiKey: '' }))
    expect(await home.read(PROFILE)).toBe(GOLDEN_KEYLESS)
  })

  it('escapes every character a TOML basic string forbids, so the profile always parses', async () => {
    home = await makeAgentHome()
    const model = 'a\\b"c\td\ne\u0001\u007f'
    const apiUrl = 'http://h/v1?q="x"\r\n'
    await configureCodex(agentInput(home.fs, { model, apiUrl }))
    const written = (await home.read(PROFILE)) ?? ''
    expect(written).toContain('model = "a\\\\b\\"c\\td\\ne\\u0001\\u007F"\n')
    expect(written).toContain('base_url = "http://h/v1?q=\\"x\\"\\r\\n"\n')
    const parsed = parseToml(written) as {
      model: string
      model_providers: Record<string, { base_url: string }>
    }
    expect(parsed.model).toBe(model)
    expect(parsed.model_providers[CODEX_PROFILE]?.base_url).toBe(apiUrl)
  })

  it('is idempotent, and rewrites its own profile with whatever changed', async () => {
    home = await makeAgentHome()
    await configureCodex(agentInput(home.fs, { apiKey: 'sk-x' }))
    await configureCodex(agentInput(home.fs, { apiKey: 'sk-x' }))
    expect(await home.tree()).toEqual({ [PROFILE]: GOLDEN })
    await configureCodex(agentInput(home.fs, { apiKey: '', model: 'other' }))
    expect(await home.read(PROFILE)).toBe(GOLDEN_KEYLESS.replace('AtomicChat/Qwen3.5-9B-GGUF', 'other'))
  })

  it('refuses to replace a profile of that name it did not write, and leaves it alone', async () => {
    home = await makeAgentHome()
    await home.seed(PROFILE, 'model = "theirs"\n')
    const path = join(home.path, '.codex', 'atomic-chat.config.toml')
    await expect(configureCodex(agentInput(home.fs))).rejects.toMatchObject({
      code: 'IO_ERROR',
      message: `${path} already exists and was not written by Atomic Chat. Rename or remove it, then connect Codex again.`,
    })
    expect(await home.tree()).toEqual({ [PROFILE]: 'model = "theirs"\n' })
  })

  it('does not take an unreadable profile for a missing one', async () => {
    home = await makeAgentHome()
    await home.seed(`${PROFILE}/not-a-file`, '')
    await expect(configureCodex(agentInput(home.fs))).rejects.toMatchObject({
      code: 'IO_ERROR',
      message: `Failed to read ${join(home.path, PROFILE)}`,
    })
  })

  it('writes into $CODEX_HOME when it is set, with a leading ~ meaning the home directory', async () => {
    home = await makeAgentHome()
    await configureCodex(agentInput(home.fs, { env: { CODEX_HOME: join(home.path, 'codex-home') } }))
    await configureCodex(agentInput(home.fs, { env: { CODEX_HOME: '~/tilde-home' } }))
    await configureCodex(agentInput(home.fs, { env: { CODEX_HOME: '' } }))
    expect(Object.keys(await home.tree())).toEqual([
      PROFILE,
      `codex-home/${CODEX_PROFILE}.config.toml`,
      `tilde-home/${CODEX_PROFILE}.config.toml`,
    ])
  })

  it('repairs a legacy config.toml in $CODEX_HOME, not the default one', async () => {
    home = await makeAgentHome()
    await home.seed(CONFIG, LEGACY_V2)
    await home.seed('elsewhere/config.toml', LEGACY_V2)
    await configureCodex(agentInput(home.fs, { env: { CODEX_HOME: join(home.path, 'elsewhere') } }))
    const tree = await home.tree()
    expect(tree[CONFIG], 'the default home is not Codex’s home here').toBe(LEGACY_V2)
    expect(tree['elsewhere/config.toml']).toBe('model = "gpt-5.5"\n')
    expect(tree['elsewhere/config.toml.atomic-chat-backup']).toBe(LEGACY_V2)
    expect(tree[`elsewhere/${CODEX_PROFILE}.config.toml`]).toContain('model = "AtomicChat/Qwen3.5-9B-GGUF"')
  })

  it('repairs a broken legacy config.toml first, then writes the profile', async () => {
    home = await makeAgentHome()
    await home.seed(CONFIG, LEGACY_V2)
    await configureCodex(agentInput(home.fs, { apiKey: 'sk-x' }))
    expect(await home.tree()).toEqual({
      [CONFIG]: 'model = "gpt-5.5"\n',
      [`${CONFIG}.atomic-chat-backup`]: LEGACY_V2,
      [PROFILE]: GOLDEN,
    })
  })

  it('never touches a config.toml with nothing of ours in it', async () => {
    home = await makeAgentHome()
    await home.seed(CONFIG, 'this is = not [valid toml\n')
    await configureCodex(agentInput(home.fs))
    expect(await home.read(CONFIG)).toBe('this is = not [valid toml\n')
    expect(Object.keys(await home.tree())).toEqual([PROFILE, CONFIG].sort())
  })

  it('fails with the reason when the legacy regions cannot be removed safely, writing nothing', async () => {
    home = await makeAgentHome()
    const tampered = `${BEGIN}\nmodel = "m"\nsandbox_mode = "danger-full-access"\n${END}\n`
    await home.seed(CONFIG, tampered)
    await expect(configureCodex(agentInput(home.fs))).rejects.toMatchObject({
      code: 'IO_ERROR',
      message: expect.stringContaining('has settings Atomic Chat never writes') as unknown as string,
    })
    expect(await home.tree()).toEqual({ [CONFIG]: tampered })
  })

  it('refuses a Codex older than 0.134 before touching anything', async () => {
    home = await makeAgentHome()
    await home.seed(CONFIG, LEGACY_V2)
    const input = { ...agentInput(home.fs), spawn: answering('codex-cli 0.133.0\n') }
    await expect(configureCodex(input)).rejects.toMatchObject({
      code: 'IO_ERROR',
      message: 'Codex CLI 0.133.0 is too old for Atomic Chat. Update it to 0.134 or newer and connect again.',
    })
    expect(await home.tree()).toEqual({ [CONFIG]: LEGACY_V2 })
  })

  it('asks the launcher detection found for its version, through cmd on Windows', async () => {
    home = await makeAgentHome()
    const calls: Array<[string, string[]]> = []
    await configureCodex({ ...agentInput(home.fs), spawn: answering('codex-cli 0.134.0\n', 0, calls) })
    await configureCodex({
      ...agentInput(home.fs),
      program: '/opt/codex/bin/codex',
      spawn: answering('codex-cli 0.146.0\n', 0, calls),
    })
    await configureCodex({
      ...agentInput(home.fs, { platform: 'win32' }),
      spawn: answering('0.140.1', 0, calls),
    })
    expect(calls).toEqual([
      ['codex', ['--version']],
      ['/opt/codex/bin/codex', ['--version']],
      ['cmd', ['/C', 'codex', '--version']],
    ])
    expect(await home.read(PROFILE)).toBeDefined()
  })

  it('goes ahead when the version cannot be told', async () => {
    const unknown: Array<[string, Spawn | undefined]> = [
      ['no process runner', undefined],
      ['a launcher that fails', answering('codex-cli 0.120.0\n', 1)],
      ['output without a version', answering('codex-cli dev\n')],
      [
        'a launcher that does not start',
        async () => {
          throw new Error('spawn codex ENOENT')
        },
      ],
    ]
    for (const [name, spawn] of unknown) {
      home = await makeAgentHome()
      await configureCodex({ ...agentInput(home.fs), ...(spawn ? { spawn } : {}) })
      expect(await home.read(PROFILE), name).toBeDefined()
      await home.cleanup()
    }
  })

  it('writes only inside .codex, from a home directory whose path contains a space', async () => {
    home = await makeAgentHome('atomic codex home-')
    await configureCodex(agentInput(home.fs))
    expect(Object.keys(await home.tree())).toEqual([PROFILE])
  })
})

describe('codexHome', () => {
  it('is $CODEX_HOME when set and non-empty, else .codex in the home directory', () => {
    expect(codexHome({}, '/home/u')).toBe(join('/home/u', '.codex'))
    expect(codexHome({ CODEX_HOME: '' }, '/home/u')).toBe(join('/home/u', '.codex'))
    expect(codexHome({ CODEX_HOME: '/srv/codex' }, '/home/u')).toBe(resolve('/srv/codex'))
    expect(codexHome({ CODEX_HOME: '~' }, '/home/u')).toBe(resolve('/home/u'))
    expect(codexHome({ CODEX_HOME: '~/codex' }, '/home/u')).toBe(resolve('/home/u', 'codex'))
    // Codex resolves a relative one against its working directory, which `launch` shares.
    expect(codexHome({ CODEX_HOME: 'rel/codex' }, '/home/u')).toBe(resolve('rel/codex'))
  })

  it('names the profile after the profile', () => {
    expect(codexProfilePath('/c')).toBe(join('/c', 'atomic-chat.config.toml'))
  })
})

describe('renderCodexProfile', () => {
  it('is the contract’s golden bytes, with env_key only for a keyed server', () => {
    expect(renderCodexProfile('http://127.0.0.1:1337/v1', 'AtomicChat/Qwen3.5-9B-GGUF', 'sk-x')).toBe(GOLDEN)
    expect(renderCodexProfile('http://127.0.0.1:1337/v1', 'AtomicChat/Qwen3.5-9B-GGUF', '')).toBe(
      GOLDEN_KEYLESS
    )
  })
})

describe('writeCodexProfile', () => {
  it('returns the path it wrote', async () => {
    home = await makeAgentHome()
    const dir = join(home.path, 'c')
    expect(await writeCodexProfile(home.fs, dir, 'http://h/v1', 'm', '')).toBe(codexProfilePath(dir))
    expect(await home.read(`c/${CODEX_PROFILE}.config.toml`)).toContain('base_url = "http://h/v1"')
  })
})

describe('the version gate', () => {
  it.each([
    ['codex-cli 0.146.0', [0, 146, 0]],
    ['codex-cli 0.134.0-alpha.2\n', [0, 134, 0]],
    ['1.2.3', [1, 2, 3]],
    ['codex-cli', undefined],
    ['', undefined],
  ])('reads %j', (output, version) => {
    expect(parseCodexVersion(output)).toEqual(version)
  })

  it.each([
    [[0, 133, 9], true],
    [[0, 134, 0], false],
    [[0, 134, 1], false],
    [[0, 135, 0], false],
    [[1, 0, 0], false],
  ] as const)('%j too old: %s', (version, old) => {
    expect(isCodexTooOld(version)).toBe(old)
  })
})
