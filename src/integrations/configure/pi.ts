/**
 * Pi — `~/.pi/agent/models.json` and `~/.pi/agent/settings.json`.
 *
 * Port of `configure_pi` in `src-tauri/src/core/system/commands.rs`. Pi splits the two halves of an
 * integration across two strict-JSON files: `models.json` declares the provider and the models it
 * serves, `settings.json` says which of them the agent opens on. Both are upserted, so other
 * providers and unrelated settings survive.
 *
 * The order matters on failure: `models.json` is written before `settings.json` is even read, so a
 * broken `settings.json` leaves a correctly updated `models.json` behind — the same half-applied
 * result the Rust writer produces.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import { canonicalJson, keyOr, parseJsonStrict } from '../config-io.js'
import { asJsonObject } from './json-tree.js'
import type { ConfigFs, JsonValue } from '../config-io.js'
import type { ConfigureInput } from './registry.js'
import { registerWriter } from './registry.js'

const DIR = '.pi/agent'

/** Read one of Pi's two files as a JSON object, treating missing/blank as `{}`. */
async function readObject(fs: ConfigFs, path: string, name: string): Promise<Record<string, JsonValue>> {
  const text = await fs.read(path)
  const parsed = text === undefined ? {} : parseJsonStrict(text, fs.absolute(path))
  const root = asJsonObject(parsed)
  if (!root) throw new AtomicCoreError('IO_ERROR', `${name} is not a JSON object`)
  return root
}

export async function configurePi(input: ConfigureInput): Promise<void> {
  const { fs, apiUrl, model, apiKey } = input
  await fs.mkdirp(DIR)
  const keyVal = keyOr(apiKey, 'atomic')

  const modelsPath = `${DIR}/models.json`
  const modelsRoot = await readObject(fs, modelsPath, 'models.json')
  const providers = asJsonObject(modelsRoot['providers']) ?? {}
  modelsRoot['providers'] = providers
  providers['atomic'] = {
    api: 'openai-completions',
    apiKey: keyVal,
    baseUrl: apiUrl,
    models: [{ id: model }],
  }
  await fs.write(modelsPath, canonicalJson(modelsRoot))

  const settingsPath = `${DIR}/settings.json`
  const settingsRoot = await readObject(fs, settingsPath, 'settings.json')
  settingsRoot['defaultProvider'] = 'atomic'
  settingsRoot['defaultModel'] = model
  await fs.write(settingsPath, canonicalJson(settingsRoot))
}

registerWriter('pi', configurePi)
