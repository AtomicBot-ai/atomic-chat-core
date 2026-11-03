import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome, type AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configureGoose, legacyGooseUserVars, stripLegacyGooseBlock } from './goose.js'

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

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
})
