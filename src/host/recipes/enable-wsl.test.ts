import { describe, expect, it } from 'vitest'
import {
  ENABLE_WSL_PARAMETERS_DIGEST,
  ENABLE_WSL_RECIPE,
  ENABLE_WSL_RECIPE_DIGEST,
  ENABLE_WSL_RECIPE_ID,
  enableWslParametersDigest,
  validateEnableWslParameters,
} from './enable-wsl.js'
import { executeHostStep, type HostStepExecutorDeps } from './executor.js'
import type { HostStepResult } from './request-file.js'

const REQUEST = 'C:/Users/ada/AppData/Local/AtomicChat/host-steps/step-7.request.json'
const RESULT = 'C:/Users/ada/AppData/Local/AtomicChat/host-steps/step-7.result.json'

/** A Windows machine as the elevated executor sees it: what `wsl.exe` answers, and every call. */
class FakeWindows {
  calls: string[][] = []
  longRunning: string[] = []
  /** Commands run with the executor's own console instead of pipes. */
  withConsole: string[] = []
  /**
   * Whether the WSL package is installed. Without it `System32\wsl.exe` is the inbox stub, which
   * runs only a bare `wsl --install` and answers "not installed" to `--install --no-distribution` and
   * `--update` (live acceptance, build 26200).
   */
  packageInstalled = false
  /** `wsl --install`'s exit code; 3010 is ERROR_SUCCESS_REBOOT_REQUIRED. */
  installExit = 0
  installStderr = ''
  /** Whether `wsl --status` answers after the install (no restart needed). */
  readyAfterInstall = false
  /** CBS `RebootPending` after the install: `--status` still exits 0 then (live acceptance). */
  restartPendingAfterInstall = false
  /**
   * With no restart needed, `wsl --install` starts its Ubuntu and never exits: the first-run prompt
   * waits for a user name in a console nobody sees (live, 2026-10-05). Only `until` ends it here.
   */
  hangsInFirstRun = false
  /** A distribution runs (`wsl --list --running` exits 0). */
  distributionRunning = false
  written = new Map<string, string>()

  deps(request: Record<string, unknown>): HostStepExecutorDeps {
    return {
      readRequest: async () => JSON.stringify(request),
      writeResult: async (path, text) => {
        this.written.set(path, text)
      },
      readFile: async () => {
        throw new Error('the WSL recipe reads no file')
      },
      writeFile: async () => {
        throw new Error('the WSL recipe writes no file')
      },
      exec: async (argv, options) => {
        this.calls.push(argv)
        if (options?.longRunning) this.longRunning.push(argv.join(' '))
        if (options?.console) this.withConsole.push(argv.join(' '))
        const stubRefusal = {
          code: 1,
          stdout:
            "The Windows Subsystem for Linux is not installed. You can install by running 'wsl.exe --install'.\n",
          stderr: '',
        }
        if (argv.join(' ') === 'wsl.exe --install') {
          if (this.installExit === 0 || this.installExit === 3010) this.packageInstalled = true
          if (this.hangsInFirstRun) {
            this.distributionRunning = true
            // Ubuntu's first-run prompt: the install exits only when `until` ends it, or at the deadline.
            return options?.until !== undefined && (await options.until())
              ? { code: 0, stdout: '', stderr: '', cutShort: true }
              : { code: null, stdout: '', stderr: 'deadline' }
          }
          return {
            code: this.installExit,
            stdout: 'Installing: Windows Subsystem for Linux\n',
            stderr: this.installStderr,
          }
        }
        if (!this.packageInstalled && argv[0] === 'wsl.exe' && argv[1] !== '--status') return stubRefusal
        if (argv.join(' ') === 'wsl.exe --list --running') {
          return this.distributionRunning
            ? { code: 0, stdout: 'Ubuntu (Default)\n', stderr: '' }
            : { code: -1, stdout: 'There are no running distributions.\n', stderr: '' }
        }
        if (argv.join(' ') === 'wsl.exe --status') {
          return this.readyAfterInstall
            ? { code: 0, stdout: 'Default Version: 2\n', stderr: '' }
            : { code: 1, stdout: 'Please enable the Virtual Machine Platform Windows feature.\n', stderr: '' }
        }
        throw new Error(`unexpected command ${argv.join(' ')}`)
      },
      fetch: async () => {
        throw new Error('the WSL recipe fetches nothing')
      },
      rebootPending: async () => this.restartPendingAfterInstall,
      now: () => 1_000,
      invokingUid: null,
    }
  }
}

const request = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: 1,
  step_id: 'step-7',
  operation_id: 'op-1',
  action: ENABLE_WSL_RECIPE_ID,
  recipe_id: ENABLE_WSL_RECIPE_ID,
  recipe_digest: ENABLE_WSL_RECIPE_DIGEST,
  parameters_digest: ENABLE_WSL_PARAMETERS_DIGEST,
  nonce: 'once-7',
  expected_operation_revision: 4,
  data_folder: 'C:/Users/ada/AppData/Roaming/Atomic Chat/data',
  parameters: {},
  ...over,
})

const run = async (windows: FakeWindows, over: Record<string, unknown> = {}): Promise<HostStepResult> =>
  executeHostStep(REQUEST, windows.deps(request(over)))

describe('the windows.enable-wsl recipe', () => {
  it('is three fixed commands with no parameter at all, and the digests bind exactly that', () => {
    expect(ENABLE_WSL_RECIPE.install).toEqual(['wsl.exe', '--install'])
    expect(ENABLE_WSL_RECIPE.watch).toEqual(['wsl.exe', '--list', '--running'])
    expect(ENABLE_WSL_RECIPE.verify).toEqual(['wsl.exe', '--status'])
    expect(ENABLE_WSL_RECIPE_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(enableWslParametersDigest({})).toBe(ENABLE_WSL_PARAMETERS_DIGEST)
    expect(validateEnableWslParameters({})).toEqual({ ok: true, parameters: {} })
    expect(validateEnableWslParameters({ distribution: 'Ubuntu' })).toMatchObject({ ok: false })
  })
})

describe('executeHostStep — windows.enable-wsl', () => {
  it('installs WSL, finds it cannot start a VM yet, and reports reboot-required', async () => {
    const windows = new FakeWindows()
    const result = await run(windows)

    expect(result.outcome).toBe('reboot-required')
    expect(result.exit_code).toBe(0)
    expect(result.nonce).toBe('once-7')
    expect(result.parameters_digest).toBe(ENABLE_WSL_PARAMETERS_DIGEST)
    expect(windows.calls).toEqual([
      ['wsl.exe', '--list', '--running'],
      ['wsl.exe', '--install'],
      ['wsl.exe', '--status'],
    ])
    expect(windows.longRunning).toEqual(['wsl.exe --install'])
    // The inbox stub installs only with a console; with piped output it answers "not installed".
    expect(windows.withConsole).toEqual(['wsl.exe --install'])
    expect(JSON.parse(windows.written.get(RESULT) ?? '{}')).toMatchObject({ outcome: 'reboot-required' })
  })

  it('reports completed when WSL starts right away (only the package was missing)', async () => {
    const windows = new FakeWindows()
    windows.readyAfterInstall = true
    expect((await run(windows)).outcome).toBe('completed')
  })

  it('reports reboot-required when --status exits 0 but Windows waits for a restart', async () => {
    const windows = new FakeWindows()
    windows.readyAfterInstall = true
    windows.restartPendingAfterInstall = true
    expect((await run(windows)).outcome).toBe('reboot-required')
  })

  it('reads 3010 (ERROR_SUCCESS_REBOOT_REQUIRED) as success that needs a restart, whatever --status says', async () => {
    const windows = new FakeWindows()
    windows.installExit = 3010
    windows.readyAfterInstall = true
    const result = await run(windows)
    expect(result.outcome).toBe('reboot-required')
  })

  it('ends an install stuck in its Ubuntu first-run prompt once a distribution runs, and reports completed', async () => {
    const windows = new FakeWindows()
    windows.hangsInFirstRun = true
    windows.readyAfterInstall = true
    // CBS can keep an empty RebootPending that no restart clears; a VM that ran outweighs it.
    windows.restartPendingAfterInstall = true
    const result = await run(windows)

    expect(result.outcome).toBe('completed')
    expect(result.steps[0]).toMatchObject({ id: 'install-wsl', status: 'applied', exit_code: 0 })
    expect(result.steps[0]?.detail).toContain('first-run prompt')
  })

  it('does not end the install early when a distribution already ran before it', async () => {
    const windows = new FakeWindows()
    windows.packageInstalled = true
    windows.distributionRunning = true
    windows.hangsInFirstRun = true
    const result = await run(windows)
    // No `until` was given: the install ran to its deadline and failed, as before.
    expect(result.outcome).toBe('failed')
  })

  it('reports a failed install with its exit code and stderr, and asks nothing more', async () => {
    const windows = new FakeWindows()
    windows.installExit = 1
    windows.installStderr = 'Error code: Wsl/InstallDistro/E_ACCESSDENIED'
    const result = await run(windows)

    expect(result.outcome).toBe('failed')
    expect(result.exit_code).toBe(1)
    expect(result.log_tail).toContain('E_ACCESSDENIED')
    // Only a diagnostic `--status` follows, to say what WSL thinks is wrong.
    expect(windows.calls).toEqual([
      ['wsl.exe', '--list', '--running'],
      ['wsl.exe', '--install'],
      ['wsl.exe', '--status'],
    ])
  })

  it('uses the one form the inbox stub runs: a bare --install, which installs the package', async () => {
    const windows = new FakeWindows()
    const result = await run(windows)
    expect(result.outcome).not.toBe('failed')
    expect(windows.calls[1]).toEqual(['wsl.exe', '--install'])
    expect(windows.packageInstalled).toBe(true)
  })

  it.each([
    ['another recipe digest', { recipe_digest: `sha256:${'e'.repeat(64)}` }],
    ['a parameter', { parameters: { distribution: 'Ubuntu' } }],
    ['another parameters digest', { parameters_digest: `sha256:${'e'.repeat(64)}` }],
    ['the Linux action', { action: 'linux.install-container-runtime' }],
  ])('refuses a request with %s before running anything', async (_label, over) => {
    const windows = new FakeWindows()
    const result = await run(windows, over)
    expect(result.outcome).toBe('failed')
    expect(result.error_code).toBe('MANAGED_HOST_STEP_INVALID')
    expect(windows.calls).toEqual([])
  })

  it('never enters, imports or changes a distribution', async () => {
    const windows = new FakeWindows()
    await run(windows)
    const flat = windows.calls.flat()
    for (const forbidden of ['-d', '--exec', '--import', '--unregister', '--set-default']) {
      expect(flat).not.toContain(forbidden)
    }
  })
})
