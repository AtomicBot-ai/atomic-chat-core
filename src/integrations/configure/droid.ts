/**
 * Factory Droid keeps its BYOK providers in `~/.factory/settings.json` as a `customModels` array.
 * Twin of `droid_config.rs` in the app.
 *
 * Droid addresses a custom model by its `id`, `custom:<displayName with dashes>-<n>`; our entry
 * carries `id` and `index` explicitly so the selector cannot drift when other entries move, and we
 * upsert by `displayName` (our managed marker) so a rerun replaces it in place. The default for new
 * sessions lives in `sessionDefaultSettings.model`: Droid moves a legacy top-level `model` there only
 * when that key is empty, so the top-level value earlier releases wrote lost to any default the user
 * had. That one is removed; the default the user had before is kept in the backup sidecar for the
 * desktop's Disconnect.
 *
 * A known served window caps the reply at a quarter of it (8192 at most) and gives Droid the rest
 * as `maxContextLimit`; an unknown one writes neither, where earlier releases claimed 16384 output
 * tokens — the whole of a 16K window.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { JsonValue } from '../config-io.js'
import { canonicalJson, keyOr, parseJsonStrict } from '../config-io.js'
import { knownWindow, outputCap, readSidecar, sameJson, writeSidecar } from './backup.js'
import type { JsonObject } from './json-tree.js'
import { asJsonArray, asJsonObject } from './json-tree.js'
import type { ConfigureWriter } from './registry.js'
import { registerWriter } from './registry.js'

const DISPLAY_NAME = 'Atomic Chat'
/** `custom:` + the display name with whitespace runs turned into dashes. */
const SELECTOR_PREFIX = 'custom:Atomic-Chat-'
const SETTINGS_PATH = '.factory/settings.json'
const SESSION_DEFAULTS = 'sessionDefaultSettings'

const isOurSelector = (value: JsonValue | undefined): boolean =>
  typeof value === 'string' && value.startsWith(SELECTOR_PREFIX)

export const configureDroid: ConfigureWriter = async ({
  apiUrl,
  model,
  apiKey,
  fs,
  platform,
  contextLength,
}) => {
  const text = await fs.read(SETTINGS_PATH)
  const parsed = text === undefined ? {} : parseJsonStrict(text, fs.absolute(SETTINGS_PATH))
  const root = asJsonObject(parsed)
  if (!root) throw new AtomicCoreError('IO_ERROR', 'settings.json is not a JSON object')

  // What the desktop's Disconnect puts back: the default before the first Connect, kept across
  // reconnects while the file still has ours.
  const currentDefault = asJsonObject(root[SESSION_DEFAULTS])?.['model']
  const backup = await readSidecar(fs, SETTINGS_PATH)
  const previous: JsonValue =
    backup !== undefined &&
    currentDefault !== undefined &&
    sameJson(asJsonObject(backup['written'])?.['defaultModel'], currentDefault)
      ? (backup['previous'] ?? null)
      : {
          defaultModel: currentDefault ?? null,
          sessionDefaultSettings: Object.hasOwn(root, SESSION_DEFAULTS),
        }

  // A `customModels` that is not an array is unusable to Droid anyway, so it is replaced rather than
  // preserved — unlike the individual entries inside it, which are the user's own providers.
  const models = asJsonArray(root['customModels']) ?? []
  const found = models.findIndex((m) => asJsonObject(m)?.['displayName'] === DISPLAY_NAME)
  const index = found >= 0 ? found : models.length
  const selector = `${SELECTOR_PREFIX}${index}`
  const window = knownWindow(contextLength)
  const entry: JsonObject = {
    model,
    id: selector,
    index,
    displayName: DISPLAY_NAME,
    baseUrl: apiUrl,
    // Droid rejects an empty apiKey outright, so a keyless local server still needs a placeholder.
    apiKey: keyOr(apiKey, 'atomic'),
    provider: 'generic-chat-completion-api',
    ...(window !== undefined
      ? { maxOutputTokens: outputCap(window), maxContextLimit: window - outputCap(window) }
      : {}),
  }
  models[index] = entry
  root['customModels'] = models

  // Earlier releases selected us through the legacy top-level key.
  if (isOurSelector(root['model'])) delete root['model']
  const defaults = asJsonObject(root[SESSION_DEFAULTS]) ?? {}
  defaults['model'] = selector
  root[SESSION_DEFAULTS] = defaults

  await fs.write(SETTINGS_PATH, canonicalJson(root))
  await writeSidecar(fs, SETTINGS_PATH, { previous, written: { defaultModel: selector } }, platform)
}

registerWriter('droid', configureDroid)
