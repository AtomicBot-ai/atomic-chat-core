/**
 * Factory Droid keeps its BYOK providers in `~/.factory/settings.json` as a `customModels` array,
 * and selects one with a top-level `model` string.
 *
 * The selector is the awkward part: Droid addresses a custom model by its POSITION in the array
 * (`custom:<displayName with spaces->dashes>-<index>`), not by name. So the value we write depends
 * on where our entry lands — seeding other models first shifts it. We upsert by `displayName`
 * (our managed marker) precisely so a rerun replaces our entry in place and the selector stays valid
 * instead of appending a duplicate and renumbering the user's models.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import { canonicalJson, keyOr, parseJsonStrict } from '../config-io.js'
import type { JsonObject } from './json-tree.js'
import { asJsonArray, asJsonObject } from './json-tree.js'
import type { ConfigureWriter } from './registry.js'
import { registerWriter } from './registry.js'

const DISPLAY_NAME = 'Atomic Chat'
const SETTINGS_PATH = '.factory/settings.json'
/** Droid's own ceiling for a generic chat-completions provider; lower values truncate long edits. */
const MAX_OUTPUT_TOKENS = 16_384

export const configureDroid: ConfigureWriter = async ({ apiUrl, model, apiKey, fs }) => {
  const text = await fs.read(SETTINGS_PATH)
  const parsed = text === undefined ? {} : parseJsonStrict(text, fs.absolute(SETTINGS_PATH))
  const root = asJsonObject(parsed)
  if (!root) throw new AtomicCoreError('IO_ERROR', 'settings.json is not a JSON object')

  // A `customModels` that is not an array is unusable to Droid anyway, so it is replaced rather than
  // preserved — unlike the individual entries inside it, which are the user's own providers.
  const models = asJsonArray(root['customModels']) ?? []
  const entry: JsonObject = {
    model,
    displayName: DISPLAY_NAME,
    baseUrl: apiUrl,
    // Droid rejects an empty apiKey outright, so a keyless local server still needs a placeholder.
    apiKey: keyOr(apiKey, 'atomic'),
    provider: 'generic-chat-completion-api',
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  }

  let index = models.findIndex((m) => asJsonObject(m)?.['displayName'] === DISPLAY_NAME)
  if (index >= 0) models[index] = entry
  else index = models.push(entry) - 1

  root['customModels'] = models
  root['model'] = `custom:${DISPLAY_NAME.split(' ').join('-')}-${index}`

  await fs.write(SETTINGS_PATH, canonicalJson(root))
}

registerWriter('droid', configureDroid)
