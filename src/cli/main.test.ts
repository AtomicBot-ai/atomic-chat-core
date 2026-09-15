import { describe, expect, it } from 'vitest'
import { CORE_VERSION } from '../version.js'
import { runCli, USAGE } from './main.js'

describe('runCli', () => {
  it('prints the version for --version and -v', () => {
    expect(runCli(['--version'])).toEqual({ exitCode: 0, stdout: `${CORE_VERSION}\n` })
    expect(runCli(['-v'])).toEqual({ exitCode: 0, stdout: `${CORE_VERSION}\n` })
  })

  it('prints usage with exit 0 for --help and exit 2 with no command', () => {
    expect(runCli(['--help'])).toEqual({ exitCode: 0, stdout: USAGE })
    expect(runCli([])).toEqual({ exitCode: 2, stdout: USAGE })
  })

  it('rejects unknown commands with exit 2 and the usage on stderr', () => {
    const result = runCli(['frobnicate'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('frobnicate')
    expect(result.stderr).toContain('Usage:')
  })
})
