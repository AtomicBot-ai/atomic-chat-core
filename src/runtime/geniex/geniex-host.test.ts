import { afterEach, describe, expect, it, vi } from 'vitest'
import { runGeniexHostMain } from './geniex-host.js'

afterEach(() => vi.restoreAllMocks())

describe('runGeniexHostMain', () => {
  it('writes the usage line to this process stderr and returns 2 for a mode the protocol lacks', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await runGeniexHostMain(['nope'])).toBe(2)
    expect(stderr.mock.calls.map(([chunk]) => String(chunk))).toEqual([
      'geniex-host: unknown mode "nope" (probe, inspect, serve)\n',
    ])
    expect(stdout).not.toHaveBeenCalled()
  })

  it('goes quiet instead of crashing when its stream is gone (EPIPE)', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    })
    expect(await runGeniexHostMain(['nope'])).toBe(2)
  })

  it('takes injected streams, and under Node the library cannot load: 3, naming the folder and why', async () => {
    const lines: string[] = []
    const code = await runGeniexHostMain(['probe', '--lib', '/nowhere'], {
      stdout: (text) => lines.push(`out:${text}`),
      stderr: (text) => lines.push(`err:${text}`),
    })
    expect(code).toBe(3)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(
      /^err:GenieX does not load from \/nowhere: load: geniex-host runs only inside a compiled binary \(no Worker\)\n$/
    )
  })
})
