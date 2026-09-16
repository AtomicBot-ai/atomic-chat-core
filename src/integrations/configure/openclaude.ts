/**
 * OpenClaude — `~/.openclaude.json` plus `~/.openclaude/.openclaude-profile.json`.
 *
 * Port of `configure_openclaude` in `src-tauri/src/core/system/commands.rs`. OpenClaude keeps a
 * list of provider profiles in its global config and a separate startup-profile file that carries
 * the environment its launcher exports; both have to agree, so both are written.
 *
 * OpenClaude routes us through its OpenAI-compatible shim and a local Atomic Chat needs no key, so
 * `apiKey` is accepted for call-site symmetry and ignored — which is why the keyed and keyless
 * cases produce byte-identical files.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import { canonicalJson, parseJsonStrict } from '../config-io.js'
import { asJsonArray, asJsonObject } from './json-tree.js'
import type { ConfigureInput } from './registry.js'
import { registerWriter } from './registry.js'

const CONFIG_PATH = '.openclaude.json'
const CONFIG_HOME = '.openclaude'
const PROFILE_PATH = `${CONFIG_HOME}/.openclaude-profile.json`
const ATOMIC_PROFILE_ID = 'provider_atomic_chat'

export async function configureOpenclaude(input: ConfigureInput): Promise<void> {
  const { fs, apiUrl, model } = input
  await fs.mkdirp(CONFIG_HOME)

  const text = await fs.read(CONFIG_PATH)
  const parsed = text === undefined ? {} : parseJsonStrict(text, fs.absolute(CONFIG_PATH))
  const root = asJsonObject(parsed)
  if (!root) throw new AtomicCoreError('IO_ERROR', `${fs.absolute(CONFIG_PATH)} is not a JSON object`)

  const entry = {
    id: ATOMIC_PROFILE_ID,
    name: 'Atomic Chat',
    provider: 'atomic-chat',
    baseUrl: apiUrl,
    model,
  }

  const profiles = asJsonArray(root['providerProfiles']) ?? []
  root['providerProfiles'] = profiles
  // Match on either identifier so a profile written by an older build — or one the user renamed —
  // is replaced rather than duplicated. The whole entry goes, extra keys included.
  const index = profiles.findIndex((candidate) => {
    const object = asJsonObject(candidate)
    return object?.['id'] === ATOMIC_PROFILE_ID || object?.['provider'] === 'atomic-chat'
  })
  if (index >= 0) profiles[index] = entry
  else profiles.push(entry)

  root['activeProviderProfileId'] = ATOMIC_PROFILE_ID
  await fs.write(CONFIG_PATH, canonicalJson(root))

  await fs.write(
    PROFILE_PATH,
    canonicalJson({
      profile: 'atomic-chat',
      env: { OPENAI_BASE_URL: apiUrl, OPENAI_MODEL: model },
      createdAt: new Date().toISOString(),
    })
  )
}

registerWriter('openclaude', configureOpenclaude)
