import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome, type AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configureEnvAgent, envAgentVars } from './env-agent.js'

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

const GOOSE = { agentId: 'goose', marker: '# Atomic Chat - Goose Config', prefix: 'GOOSE_' }

describe('the env-var agents', () => {
  it('picks the rc file from $SHELL and the platform', async () => {
    // The fixtures were emitted on macOS, so the Linux half of the bash branch is only checked here.
    const cases: Array<[NodeJS.Platform, string | undefined, string]> = [
      ['linux', '/bin/bash', '.bashrc'],
      ['darwin', '/bin/bash', '.bash_profile'],
      ['linux', '/usr/bin/fish', '.zshenv'],
      ['darwin', undefined, '.zshenv'],
    ]
    for (const [platform, shell, expected] of cases) {
      home = await makeAgentHome()
      await configureEnvAgent(agentInput(home.fs, { platform, shell }), GOOSE)
      expect(Object.keys(await home.tree()), `${platform} ${String(shell)}`).toEqual([expected])
      await home.cleanup()
    }
    home = await makeAgentHome()
  })

  it('sets the variables through setx on Windows and writes no file at all', async () => {
    home = await makeAgentHome()
    const spawned: string[][] = []
    await configureEnvAgent(
      agentInput(home.fs, {
        platform: 'win32',
        spawn: async (program, args) => {
          spawned.push([program, ...args])
          return { code: 0, stdout: '', stderr: '' }
        },
      }),
      GOOSE
    )
    expect(await home.tree()).toEqual({})
    expect(spawned).toEqual([
      ['setx', 'GOOSE_PROVIDER', 'openai'],
      ['setx', 'GOOSE_MODEL', 'AtomicChat/Qwen3.5-9B-GGUF'],
      ['setx', 'OPENAI_HOST', 'http://127.0.0.1:1337/v1'],
      ['setx', 'OPENAI_BASE_PATH', 'v1/chat/completions'],
      ['setx', 'OPENAI_API_KEY', 'sk-atomic-fixture-key'],
    ])
  })

  it('reports the variable that setx refused, and stops there', async () => {
    home = await makeAgentHome()
    let calls = 0
    const run = configureEnvAgent(
      agentInput(home.fs, {
        platform: 'win32',
        spawn: async () => {
          calls++
          return { code: 1, stdout: '', stderr: 'ACCESS DENIED' }
        },
      }),
      GOOSE
    )
    await expect(run).rejects.toThrow('Failed to set env var GOOSE_PROVIDER: ACCESS DENIED')
    expect(calls).toBe(1)
  })

  it('needs a command runner on Windows, and says so', async () => {
    home = await makeAgentHome()
    await expect(configureEnvAgent(agentInput(home.fs, { platform: 'win32' }), GOOSE)).rejects.toThrow(
      /command runner/
    )
  })

  it('refuses an agent that is not in the catalog', () => {
    expect(() => envAgentVars('nope', 'u', 'm', 'k')).toThrow('Unknown agent: nope')
  })
})
