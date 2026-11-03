/**
 * Cline — configured by its own `cline auth` subcommand.
 *
 * Port of `configure_cline` in `src-tauri/src/core/system/commands.rs` and `cline_config.rs`. The
 * supported way in is `cline auth --provider openai-compatible …`, which saves the provider into
 * Cline's `providers.json` (`<CLINE_DIR>/data/settings/providers.json`) and makes it
 * `lastUsedProvider`, so configuring it means running a process and reporting what it said. It has
 * no flag for the context window, which Cline 3.x reads from the entry's `contextWindow` (and the
 * reply cap from `maxTokens`): both are set on the saved entry afterwards, and removed when the
 * window is unknown. The entry and `lastUsedProvider` from before are kept in the backup sidecar for
 * the desktop's Disconnect, read before `cline auth` rewrites them.
 *
 * On Windows the npm-installed `cline` is a batch shim (`cline.cmd`), which `CreateProcessW` refuses
 * to execute directly, so the call is routed through `cmd /C`.
 */

import { execFile } from 'node:child_process'
import { AtomicCoreError } from '../../contracts/index.js'
import type { ConfigFs, JsonValue } from '../config-io.js'
import { canonicalJson, expandTilde, keyOr, parseJsonStrict } from '../config-io.js'
import { knownWindow, outputCap, readSidecar, sameJson, writeSidecar } from './backup.js'
import type { JsonObject } from './json-tree.js'
import { asJsonObject } from './json-tree.js'
import type { ConfigureInput } from './registry.js'
import { registerWriter } from './registry.js'

const PROVIDER = 'openai-compatible'

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
    PROVIDER,
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

/**
 * `providers.json` where Cline resolves it: `$CLINE_PROVIDER_SETTINGS_PATH`, else
 * `$CLINE_DATA_DIR/settings`, else `$CLINE_DIR/data/settings`, else `~/.cline/data/settings`.
 */
export function clineProvidersPath(env: NodeJS.ProcessEnv, home: string): string {
  const value = (name: string) => {
    const raw = env[name]?.trim()
    return raw ? expandTilde(raw, home) : undefined
  }
  const file = value('CLINE_PROVIDER_SETTINGS_PATH')
  if (file !== undefined) return file
  const data = value('CLINE_DATA_DIR') ?? `${value('CLINE_DIR') ?? '.cline'}/data`
  return `${data}/settings/providers.json`
}

async function readProviders(fs: ConfigFs, path: string): Promise<JsonObject> {
  const text = await fs.read(path)
  const parsed = text === undefined ? {} : parseJsonStrict(text, fs.absolute(path))
  const root = asJsonObject(parsed)
  if (!root) throw new AtomicCoreError('IO_ERROR', `${fs.absolute(path)} is not a JSON object`)
  return root
}

const entrySettings = (root: JsonObject): JsonObject | undefined =>
  asJsonObject(asJsonObject(asJsonObject(root['providers'])?.[PROVIDER])?.['settings'])

/** Whether the entry still points where we pointed it. */
function holdsOurs(root: JsonObject, written: JsonValue | undefined): boolean {
  const settings = entrySettings(root)
  const ours = asJsonObject(written)
  return (
    settings !== undefined &&
    ours !== undefined &&
    sameJson(settings['baseUrl'], ours['baseUrl']) &&
    sameJson(settings['model'], ours['model'])
  )
}

export async function configureCline(input: ConfigureInput): Promise<void> {
  const { program, args } = clineAuthCommand(input.apiUrl, input.model, input.apiKey, input.platform)
  const spawn = input.spawn ?? spawnProcess

  // What the desktop's Disconnect restores, read before `cline auth` rewrites it — and kept as it
  // is across reconnects while the file still holds ours.
  const path = clineProvidersPath(input.env, input.fs.home)
  const before = await readProviders(input.fs, path)
  const backup = await readSidecar(input.fs, path)
  const kept = backup !== undefined && holdsOurs(before, backup['written']) ? backup['previous'] : undefined
  const previous: JsonValue = kept ?? {
    lastUsedProvider: before['lastUsedProvider'] ?? null,
    entry: asJsonObject(before['providers'])?.[PROVIDER] ?? null,
  }

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

  // `cline auth` has no flag for the window; set it on the entry it saved, or clear what the entry
  // carried for the endpoint it pointed at before.
  const after = await readProviders(input.fs, path)
  const settings = entrySettings(after)
  if (settings !== undefined) {
    const was = canonicalJson(settings)
    const window = knownWindow(input.contextLength)
    if (window !== undefined) {
      settings['contextWindow'] = window
      settings['maxTokens'] = outputCap(window)
    } else {
      delete settings['contextWindow']
      delete settings['maxTokens']
    }
    // Cline keeps the file owner-only: it holds every provider's key.
    if (canonicalJson(settings) !== was) {
      await input.fs.write(path, canonicalJson(after), input.platform === 'win32' ? {} : { mode: 0o600 })
    }
  }
  await writeSidecar(
    input.fs,
    path,
    { previous, written: { baseUrl: input.apiUrl, model: input.model } },
    input.platform
  )
}

registerWriter('cline', configureCline)
