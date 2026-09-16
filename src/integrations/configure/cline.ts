/**
 * Cline — no config file at all.
 *
 * Port of `configure_cline` in `src-tauri/src/core/system/commands.rs`. Cline stores its provider
 * settings itself; the supported way in is its own `cline auth` subcommand, so configuring it means
 * running a process and reporting what it said. Nothing is written to disk by us.
 *
 * On Windows the npm-installed `cline` is a batch shim (`cline.cmd`), which `CreateProcessW` refuses
 * to execute directly, so the call is routed through `cmd /C`.
 */

import { execFile } from 'node:child_process'
import { AtomicCoreError } from '../../contracts/index.js'
import { keyOr } from '../config-io.js'
import type { ConfigureInput } from './registry.js'
import { registerWriter } from './registry.js'

export interface SpawnResult {
  code: number
  stdout: string
  stderr: string
}

/** Argv for `cline auth`, split out so both the writer and its tests can name the exact command. */
export function clineAuthCommand(
  apiUrl: string,
  model: string,
  apiKey: string,
  platform: NodeJS.Platform
): { program: string; args: string[] } {
  // Cline rejects an empty `--apikey` (and an empty `--modelid`), so a keyless local server gets a
  // non-empty placeholder. Note it is `local` here, not the `atomic` the file-writing agents use.
  const args = [
    'auth',
    '--provider',
    'openai-compatible',
    '--apikey',
    keyOr(apiKey, 'local'),
    '--modelid',
    model,
    '--baseurl',
    apiUrl,
  ]
  return platform === 'win32'
    ? { program: 'cmd', args: ['/C', 'cline', ...args] }
    : { program: 'cline', args }
}

/**
 * The runner used when the caller injects none. A process that ran and failed is a result, not an
 * exception — only a process that could not be started at all rejects, because those are the two
 * outcomes Cline's caller has to report differently.
 */
export function spawnProcess(program: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    execFile(program, args, { windowsHide: true }, (error, stdout, stderr) => {
      // `execFile` reports a non-zero exit and a failure to start the same way; only the latter has
      // no exit code, and only the latter is a spawn error as far as the message goes.
      const code = error && typeof error.code === 'number' ? error.code : error ? -1 : 0
      if (error && typeof error.code !== 'number') reject(error)
      else resolve({ code, stdout, stderr })
    })
  })
}

export async function configureCline(input: ConfigureInput): Promise<void> {
  const { program, args } = clineAuthCommand(input.apiUrl, input.model, input.apiKey, input.platform)
  const spawn = input.spawn ?? spawnProcess

  let result: SpawnResult
  try {
    result = await spawn(program, args)
  } catch (e) {
    throw new AtomicCoreError('IO_ERROR', `Failed to spawn 'cline': ${(e as Error).message}`)
  }

  if (result.code !== 0) {
    // The stream split for `cline auth` is undocumented, so prefer stderr and fall back to stdout.
    const stderr = result.stderr.trim()
    const detail = stderr === '' ? result.stdout.trim() : stderr
    throw new AtomicCoreError('INTERNAL_ERROR', `\`cline auth\` failed: ${detail}`)
  }
}

registerWriter('cline', configureCline)
