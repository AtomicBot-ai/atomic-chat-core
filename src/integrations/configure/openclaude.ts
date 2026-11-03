/**
 * OpenClaude — its global config (`~/.openclaude.json`) plus the startup profile
 * (`~/.openclaude/.openclaude-profile.json`).
 *
 * Port of `configure_openclaude` / `connect_openclaude` in the app (`src-tauri/src/core/system/
 * claude_config.rs`). OpenClaude keeps a list of provider profiles in its global config and a
 * separate startup-profile file that carries the environment its launcher exports; both have to
 * agree, so both are written. Paths follow OpenClaude 0.34: the config home is
 * `$OPENCLAUDE_CONFIG_DIR`, else `~/.openclaude`; a `.config.json` there is the global config, else
 * `.openclaude.json` in `$OPENCLAUDE_CONFIG_DIR` or the home directory.
 *
 * OpenClaude routes us through its OpenAI-compatible shim and sends the profile's `apiKey` as a
 * bearer token, so the server's key goes into the profile (`atomic` for a keyless server) — without
 * it a keyed server answers 401. Our profile is matched by its id only: one the user made from
 * OpenClaude's own Atomic Chat preset is theirs. With a known window the profile carries
 * `maxContextLength`, and the global `env` an output cap for the model (a profile has no output
 * setting). The global `env` also gets empty values for the shell variables that would make
 * OpenClaude skip its active profile: it applies that `env` before deciding. What every key held
 * before is kept in the sidecars `json-backup.ts` describes, for the app's Disconnect.
 */

import { join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import { canonicalJson, keyOr, parseJsonStrict } from '../config-io.js'
import type { ConfigFs, JsonValue } from '../config-io.js'
import {
  configDirFrom,
  getAt,
  isOurServerUrl,
  jsonEqual,
  ourServerFromUrl,
  outputCap,
  readBackup,
  redo,
  wholeFileBackup,
  writeBackup,
  writeConfigFile,
} from './json-backup.js'
import type { JsonPath, JsonWrite, OurServer } from './json-backup.js'
import { asJsonArray, asJsonObject } from './json-tree.js'
import type { JsonObject } from './json-tree.js'
import type { ConfigureInput } from './registry.js'
import { registerWriter } from './registry.js'

const ATOMIC_PROFILE_ID = 'provider_atomic_chat'
const PROVIDER = 'atomic-chat'
/**
 * With `CLAUDE_CODE_USE_OPENAI` plus a base URL or model (or a complete `ANTHROPIC_*` trio) in the
 * environment, OpenClaude treats the shell as the user's choice and skips its active profile
 * (`hasCompleteProviderSelection`). Empty values in the global config's `env` take a shell's
 * leftovers out of that decision; once our profile applies, OpenClaude clears and sets them itself.
 */
const SHELL_OVERRIDES = [
  'CLAUDE_CODE_USE_OPENAI',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_MODEL',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_GEMINI_VERTEX',
] as const

const PROFILE_PATH: JsonPath = ['providerProfiles', { id: ATOMIC_PROFILE_ID }]

export interface OpenclaudePaths {
  config: string
  profile: string
}

export async function openclaudePaths(fs: ConfigFs, env: NodeJS.ProcessEnv): Promise<OpenclaudePaths> {
  const dir = configDirFrom(env['OPENCLAUDE_CONFIG_DIR'], fs.home)
  const configHome = dir ?? '.openclaude'
  const legacy = dir === undefined ? `${configHome}/.config.json` : join(configHome, '.config.json')
  const config = (await fs.exists(legacy))
    ? legacy
    : dir === undefined
      ? '.openclaude.json'
      : join(dir, '.openclaude.json')
  const profile =
    dir === undefined ? `${configHome}/.openclaude-profile.json` : join(dir, '.openclaude-profile.json')
  return { config, profile }
}

function writesFor(input: ConfigureInput): JsonWrite[] {
  const { apiUrl, model, apiKey, contextLength } = input
  const window = contextLength !== undefined && contextLength > 0 ? contextLength : undefined
  const profile: JsonObject = {
    id: ATOMIC_PROFILE_ID,
    name: 'Atomic Chat',
    provider: PROVIDER,
    apiKey: keyOr(apiKey, 'atomic'),
    baseUrl: apiUrl,
    model,
  }
  if (window !== undefined) profile['maxContextLength'] = window
  const writes: JsonWrite[] = [
    [PROFILE_PATH, profile],
    [['activeProviderProfileId'], ATOMIC_PROFILE_ID],
  ]
  for (const name of SHELL_OVERRIDES) writes.push([['env', name], ''])
  if (window !== undefined) {
    writes.push([
      ['env', 'CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS'],
      JSON.stringify({ [model]: outputCap(window) }),
    ])
  }
  return writes
}

/** What an earlier release wrote without a backup: our profile and the active pointer at it. */
function forgetLegacy(root: JsonObject): void {
  const profiles = asJsonArray(root['providerProfiles'])
  if (profiles) {
    for (let i = profiles.length - 1; i >= 0; i--) {
      if (asJsonObject(profiles[i])?.['id'] === ATOMIC_PROFILE_ID) profiles.splice(i, 1)
    }
  }
  if (root['activeProviderProfileId'] === ATOMIC_PROFILE_ID) delete root['activeProviderProfileId']
}

function startupProfileIsOurs(doc: JsonValue, server: OurServer | undefined): boolean {
  const base = getAt(doc, ['env', 'OPENAI_BASE_URL'])
  return (
    asJsonObject(doc)?.['profile'] === PROVIDER && typeof base === 'string' && isOurServerUrl(server, base)
  )
}

/** A startup profile that cannot be parsed counts as absent: OpenClaude ignores it too. */
async function readStartupProfile(fs: ConfigFs, path: string): Promise<JsonValue | undefined> {
  const text = await fs.read(path)
  if (text === undefined) return undefined
  try {
    return parseJsonStrict(text, fs.absolute(path))
  } catch {
    return undefined
  }
}

export async function configureOpenclaude(input: ConfigureInput): Promise<void> {
  const { fs, apiUrl, model, apiKey } = input
  const paths = await openclaudePaths(fs, input.env)

  const text = await fs.read(paths.config)
  const parsed = text === undefined ? {} : parseJsonStrict(text, fs.absolute(paths.config))
  const root = asJsonObject(parsed)
  if (!root) throw new AtomicCoreError('IO_ERROR', `${fs.absolute(paths.config)} is not a JSON object`)

  const backup = redo(
    root,
    await readBackup(fs, paths.config),
    text !== undefined,
    writesFor(input),
    [],
    forgetLegacy
  )
  // Sidecar first: a crash between the two leaves a backup whose values simply do not match yet.
  await writeBackup(fs, paths.config, backup)
  await writeConfigFile(fs, paths.config, canonicalJson(root))

  const doc: JsonObject = {
    profile: PROVIDER,
    env: { OPENAI_BASE_URL: apiUrl, OPENAI_MODEL: model, OPENAI_API_KEY: keyOr(apiKey, 'atomic') },
    createdAt: new Date().toISOString(),
  }
  const current = await readStartupProfile(fs, paths.profile)
  const previous = await readBackup(fs, paths.profile)
  const entry = previous?.entries[0]
  let existed: boolean
  let before: JsonValue | undefined
  if (entry && current !== undefined && jsonEqual(entry.written, current)) {
    existed = entry.existed
    before = entry.previous
  } else if (current !== undefined && !startupProfileIsOurs(current, ourServerFromUrl(apiUrl))) {
    existed = true
    before = current
  } else {
    existed = false
    before = undefined
  }
  await writeBackup(fs, paths.profile, wholeFileBackup(existed, before, doc))
  await writeConfigFile(fs, paths.profile, canonicalJson(doc))
}

registerWriter('openclaude', configureOpenclaude)
