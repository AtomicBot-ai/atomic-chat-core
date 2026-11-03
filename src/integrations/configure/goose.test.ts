import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome, type AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configureGoose, legacyGooseUserVars, stripLegacyGooseBlock } from './goose.js'
import type { ConfigureInput } from './registry.js'

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

type Spawn = NonNullable<ConfigureInput['spawn']>
type Run = Awaited<ReturnType<Spawn>>

/** What an earlier release left in the User environment with `setx`. */
const SETX: Readonly<Record<string, string>> = {
  GOOSE_PROVIDER: 'openai',
  GOOSE_MODEL: 'qwen3',
  OPENAI_HOST: 'http://localhost:1337',
  OPENAI_BASE_PATH: 'v1/chat/completions',
  OPENAI_API_KEY: 'atomic',
}
const ALL_VARS = Object.keys(SETX)

/**
 * The User environment as `reg query` and PowerShell see it: `reg` answers from `vars` (unless
 * `query` answers a name itself), and a PowerShell run that exits 0 deletes what its script names.
 */
function userEnvironment(
  initial: Readonly<Record<string, string>>,
  options: { query?: (name: string) => Promise<Run> | undefined; removal?: Run } = {}
): { vars: Map<string, string>; spawn: Spawn } {
  const vars = new Map(Object.entries(initial))
  const spawn: Spawn = async (program, args) => {
    if (program === 'powershell') {
      const removal = options.removal ?? { code: 0, stdout: '', stderr: '' }
      if (removal.code === 0) {
        const script = args.at(-1) as string
        for (const [, name] of script.matchAll(/SetEnvironmentVariable\('(\w+)', \$null, 'User'\)/g)) {
          vars.delete(name as string)
        }
      }
      return removal
    }
    const name = args[3] as string
    const answered = options.query?.(name)
    if (answered) return answered
    const value = vars.get(name)
    return value === undefined
      ? {
          code: 1,
          stdout: '',
          stderr: 'ERROR: The system was unable to find the specified registry key or value.',
        }
      : {
          code: 0,
          stdout: `\r\nHKEY_CURRENT_USER\\Environment\r\n    ${name}    REG_SZ    ${value}\r\n\r\n`,
          stderr: '',
        }
  }
  return { vars, spawn }
}

/** `legacyGooseUserVars` over a fixed set of User variables. */
const legacyOf = (vars: Readonly<Record<string, string>>, apiKey: string): string[] =>
  legacyGooseUserVars((name) => vars[name], apiKey)

const BLOCK = [
  '# Atomic Chat - Goose Config',
  "export GOOSE_PROVIDER='openai'",
  "export GOOSE_MODEL='qwen3'",
  "export OPENAI_HOST='http://127.0.0.1:1337'",
  "export OPENAI_BASE_PATH='v1/chat/completions'",
  "export OPENAI_API_KEY='atomic'",
  '',
  '# Atomic Chat - Goose Config',
  '',
].join('\n')

describe('configuring Goose', () => {
  it('writes nothing for a connection', async () => {
    home = await makeAgentHome()
    await configureGoose(agentInput(home.fs, { platform: 'linux', shell: '/bin/bash' }))
    expect(await home.tree()).toEqual({})
  })

  it('takes out the block an earlier release wrote, from every rc file, and nothing else', async () => {
    home = await makeAgentHome()
    const user = "export OPENAI_API_KEY='sk-user-owned'\nexport EDITOR=nvim\n"
    await home.seed('.zshenv', `${user}${BLOCK}`)
    await home.seed('.bash_profile', BLOCK)
    await home.seed('.bashrc', "export GOOSE_MODEL='hand-written'\n")
    await configureGoose(agentInput(home.fs))
    expect(await home.tree()).toEqual({
      '.bash_profile': '',
      '.bashrc': "export GOOSE_MODEL='hand-written'\n",
      '.zshenv': user,
    })
  })

  it('keeps a line of the user inside the block, and a lone marker takes nothing with it', () => {
    const edited = BLOCK.replace("export GOOSE_MODEL='qwen3'\n", 'alias g=goose\n')
    expect(stripLegacyGooseBlock(`A=1\n${edited}`)).toBe('A=1\nalias g=goose\n')
    expect(stripLegacyGooseBlock("# Atomic Chat - Goose Config\nexport OPENAI_API_KEY='sk'\n")).toBe(
      "export OPENAI_API_KEY='sk'\n"
    )
    expect(stripLegacyGooseBlock('export A=1\n')).toBeUndefined()
  })

  it('recognises only the user variables an earlier release set with setx', () => {
    const ours: Record<string, string> = {
      GOOSE_PROVIDER: 'openai',
      GOOSE_MODEL: 'qwen3',
      OPENAI_HOST: 'http://127.0.0.1:1337',
      OPENAI_BASE_PATH: 'v1/chat/completions',
      OPENAI_API_KEY: 'sk-real-openai',
    }
    expect(legacyGooseUserVars((n) => ours[n], 'sk-server')).toEqual([
      'GOOSE_PROVIDER',
      'GOOSE_MODEL',
      'OPENAI_HOST',
      'OPENAI_BASE_PATH',
    ])
    expect(legacyGooseUserVars((n) => ours[n], 'sk-real-openai')).toHaveLength(5)
    const theirs: Record<string, string> = { ...ours, OPENAI_HOST: 'https://api.openai.com' }
    expect(legacyGooseUserVars((n) => theirs[n], '')).toEqual([])
  })

  it('deletes them on Windows through SetEnvironmentVariable, which tells Explorer', async () => {
    home = await makeAgentHome()
    const user: Record<string, string> = {
      GOOSE_PROVIDER: 'openai',
      GOOSE_MODEL: 'qwen3',
      OPENAI_HOST: 'http://localhost:1337',
      OPENAI_BASE_PATH: 'v1/chat/completions',
      OPENAI_API_KEY: 'atomic',
    }
    const ran: string[][] = []
    await configureGoose(
      agentInput(home.fs, {
        platform: 'win32',
        spawn: async (program, args) => {
          ran.push([program, ...args])
          if (program !== 'reg') return { code: 0, stdout: '', stderr: '' }
          const name = args[3] as string
          const value = user[name]
          return value === undefined
            ? { code: 1, stdout: '', stderr: 'ERROR: not found' }
            : {
                code: 0,
                stdout: `\r\nHKEY_CURRENT_USER\\Environment\r\n    ${name}    REG_SZ    ${value}\r\n`,
                stderr: '',
              }
        },
      })
    )
    const removal = ran.find(([program]) => program === 'powershell')
    expect(removal?.at(-1)).toBe(
      ['GOOSE_PROVIDER', 'GOOSE_MODEL', 'OPENAI_HOST', 'OPENAI_BASE_PATH', 'OPENAI_API_KEY']
        .map((n) => `[Environment]::SetEnvironmentVariable('${n}', $null, 'User')`)
        .join('; ')
    )
    expect(await home.tree()).toEqual({})
  })

  it('recognises every local host an earlier release could have saved, with or without a scheme', () => {
    const local = [
      'http://localhost:1337',
      'http://atomic.localhost:1337',
      'localhost:1337',
      '127.0.0.1:1337',
      'http://[::1]:1337',
      'http://[::]:1337',
      'http://[fd12:3456::1]:1337',
      'http://[FC00::1]:1337',
      'http://[fe80::1]:1337',
      'http://[febf::1]:1337',
      'http://10.0.0.5:1337',
      'http://0.0.0.0:1337',
      'http://172.16.0.1:1337',
      'http://172.31.255.254:1337',
      'http://192.168.1.20:1337',
      'http://169.254.10.1:1337',
    ]
    for (const host of local) {
      expect(legacyOf({ ...SETX, OPENAI_HOST: host }, ''), host).toEqual(ALL_VARS)
    }
  })

  it('leaves a host that is public, unparsable or missing to the user', () => {
    const elsewhere = [
      'http://172.15.0.1:1337',
      'http://172.32.0.1:1337',
      'http://192.169.0.1:1337',
      'http://169.253.0.1:1337',
      'http://8.8.8.8:1337',
      'http://11.0.0.1:1337',
      'http://[2001:db8::1]:1337',
      'http://[fec0::1]:1337',
      'http://my-server.lan:1337',
      'http://[::1',
      'not a url',
    ]
    for (const host of elsewhere) {
      expect(legacyOf({ ...SETX, OPENAI_HOST: host }, ''), host).toEqual([])
    }
    const { OPENAI_HOST: _host, ...hostless } = SETX
    expect(legacyOf(hostless, '')).toEqual([])
  })

  it('needs the openai provider and our base path, and lists only the variables that are set', () => {
    expect(legacyOf({ ...SETX, GOOSE_PROVIDER: 'anthropic' }, '')).toEqual([])
    expect(legacyOf({ ...SETX, OPENAI_BASE_PATH: 'v1/responses' }, '')).toEqual([])
    const { GOOSE_PROVIDER: _provider, ...providerless } = SETX
    expect(legacyOf(providerless, '')).toEqual([])
    const { GOOSE_MODEL: _model, ...modelless } = SETX
    expect(legacyOf({ ...modelless, GOOSE_PROVIDER: ' openai ' }, '')).toEqual([
      'GOOSE_PROVIDER',
      'OPENAI_HOST',
      'OPENAI_BASE_PATH',
      'OPENAI_API_KEY',
    ])
  })

  it('takes the key only when it is the placeholder or the server key, never on an empty server key', () => {
    const withoutKey = ALL_VARS.filter((name) => name !== 'OPENAI_API_KEY')
    expect(legacyOf(SETX, '')).toEqual(ALL_VARS)
    expect(legacyOf({ ...SETX, OPENAI_API_KEY: 'sk-server' }, 'sk-server')).toEqual(ALL_VARS)
    expect(legacyOf({ ...SETX, OPENAI_API_KEY: 'sk-real-openai' }, '')).toEqual(withoutKey)
    expect(legacyOf({ ...SETX, OPENAI_API_KEY: '' }, '')).toEqual(withoutKey)
  })

  it("leaves a Windows user's own OpenAI variables where they are", async () => {
    home = await makeAgentHome()
    const theirs = { ...SETX, OPENAI_HOST: 'https://api.openai.com', OPENAI_API_KEY: 'sk-real-openai' }
    const user = userEnvironment(theirs)
    await configureGoose(agentInput(home.fs, { platform: 'win32', spawn: user.spawn }))
    expect(Object.fromEntries(user.vars)).toEqual(theirs)
    expect(await home.tree()).toEqual({})
  })

  it('counts a variable reg cannot be run for as unset, and so removes nothing', async () => {
    home = await makeAgentHome()
    const user = userEnvironment(SETX, {
      query: () => Promise.reject(new Error('spawn reg ENOENT')),
    })
    await configureGoose(agentInput(home.fs, { platform: 'win32', spawn: user.spawn }))
    expect(Object.fromEntries(user.vars)).toEqual(SETX)
  })

  it("reads reg's answer line by line: an empty value or no value line counts as unset", async () => {
    home = await makeAgentHome()
    const user = userEnvironment(
      { ...SETX, OPENAI_API_KEY: '' },
      {
        query: (name) =>
          name === 'GOOSE_MODEL'
            ? Promise.resolve({ code: 0, stdout: '\r\nHKEY_CURRENT_USER\\Environment\r\n', stderr: '' })
            : undefined,
      }
    )
    await configureGoose(agentInput(home.fs, { platform: 'win32', spawn: user.spawn }))
    expect(Object.fromEntries(user.vars)).toEqual({ GOOSE_MODEL: 'qwen3', OPENAI_API_KEY: '' })
  })

  it('fails with IO_ERROR and what PowerShell said when the variables cannot be removed', async () => {
    home = await makeAgentHome()
    await home.seed('.bashrc', BLOCK)
    const user = userEnvironment(SETX, {
      removal: { code: 1, stdout: '', stderr: 'Requested registry access is not allowed.\r\n' },
    })
    await expect(
      configureGoose(agentInput(home.fs, { platform: 'win32', spawn: user.spawn }))
    ).rejects.toMatchObject({
      code: 'IO_ERROR',
      message:
        'Could not remove the Goose variables an earlier Atomic Chat set: Requested registry access is not allowed.',
    })
    expect(Object.fromEntries(user.vars)).toEqual(SETX)
    // The rc files are cleaned first, so a failed removal still leaves them clean.
    expect(await home.tree()).toEqual({ '.bashrc': '' })
  })

  it('on Windows without a way to run commands, cleans the rc files and stops there', async () => {
    home = await makeAgentHome()
    await home.seed('.zshenv', BLOCK)
    await configureGoose(agentInput(home.fs, { platform: 'win32' }))
    expect(await home.tree()).toEqual({ '.zshenv': '' })
  })
})
