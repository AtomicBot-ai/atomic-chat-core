import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome } from '../../../test/helpers/agent-config-home.js'
import type { AgentHome } from '../../../test/helpers/agent-config-home.js'
import { clineAuthCommand, configureCline, spawnProcess } from './cline.js'
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

  it('writes no file at all — the whole integration is the subprocess', async () => {
    home = await makeAgentHome()
    const rec = recorder(ok)
    await configureCline(agentInput(home.fs, { spawn: rec.spawn }))
    expect(await home.tree()).toEqual({})
    expect(rec.calls).toHaveLength(1)
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
