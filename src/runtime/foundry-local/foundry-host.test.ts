import { afterEach, describe, expect, it, vi } from 'vitest'
import { runFoundryHostMain } from './foundry-host.js'

afterEach(() => vi.restoreAllMocks())

describe('runFoundryHostMain', () => {
  it('writes the usage line to this process stderr and returns 2 for a mode the protocol lacks', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await runFoundryHostMain(['nope'])).toBe(2)
    expect(stderr.mock.calls.map(([chunk]) => String(chunk))).toEqual([
      'foundry-host: unknown mode "nope" (probe, prepare, serve)\n',
    ])
    expect(stdout).not.toHaveBeenCalled()
  })

  it('takes injected streams, and under Node the library cannot load: 3, naming the folder and why', async () => {
    const lines: string[] = []
    const code = await runFoundryHostMain(
      ['probe', '--lib', '/nowhere', '--app-data', '/nowhere/rt', '--logs', '/nowhere/l'],
      { stdout: (text) => lines.push(`out:${text}`), stderr: (text) => lines.push(`err:${text}`) }
    )
    expect(code).toBe(3)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(
      /^err:foundry_local does not load from \/nowhere: load: foundry-host runs only inside a compiled binary \(.*\)\n$/
    )
  })
})
