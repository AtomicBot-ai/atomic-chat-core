/**
 * Pi — `models.json` and `settings.json` in `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`.
 *
 * Port of `configure_pi` in `src-tauri/src/core/system/commands.rs` (`opencode_family.rs`). Pi splits
 * the two halves of an integration across two strict-JSON files: `models.json` declares the provider
 * and the models it serves, `settings.json` says which of them the agent opens on. Both are upserted,
 * so other providers and unrelated settings survive; the default model a connection replaces is kept
 * beside `settings.json` for the app's Disconnect.
 *
 * The order matters on failure: `models.json` is written before `settings.json` is even read, so a
 * broken `settings.json` leaves a correctly updated `models.json` behind — the same half-applied
 * result the Rust writer produces.
 */

import { canonicalJson, keyOr } from '../config-io.js'
import type { JsonObject } from './json-tree.js'
import { asJsonObject } from './json-tree.js'
import {
  PROVIDER_ID,
  PROVIDER_NAME,
  knownWindow,
  outputCap,
  piDir,
  readRoot,
  saveReplaced,
  setAt,
  type Managed,
} from './opencode-style.js'
import type { ConfigureInput } from './registry.js'
import { registerWriter } from './registry.js'

/** Pi summarizes no more than its default 20K most recent tokens. */
const KEEP_RECENT_TOKENS = 20_000

/** Ours by name, or the exact shape releases before the name wrote. */
function providerIsOurs(root: JsonObject): boolean {
  const entry = asJsonObject(asJsonObject(root['providers'])?.[PROVIDER_ID])
  if (!entry) return false
  if ('name' in entry) return entry['name'] === PROVIDER_NAME
  return Object.keys(entry).sort().join(',') === 'api,apiKey,baseUrl,models'
}

const defaultIsOurs = (root: JsonObject): boolean => root['defaultProvider'] === PROVIDER_ID

const MODELS_MANAGED: readonly Managed[] = [{ keys: ['providers', PROVIDER_ID], ours: providerIsOurs }]
/** The default model is a provider/model pair, judged by its provider. */
const SETTINGS_MANAGED: readonly Managed[] = [
  { keys: ['defaultProvider'], ours: defaultIsOurs },
  { keys: ['defaultModel'], ours: defaultIsOurs },
]

/**
 * Drop every `atomic/…` compaction override (ours, from any connection), then add the one for `model`
 * when its window is known: compaction starts with a quarter of the window left, and keeps no more
 * recent history than that quarter, or a small window would have nothing to summarize.
 */
function setCompaction(settings: JsonObject, model: string, contextLength: number | undefined): void {
  const compaction = asJsonObject(settings['compaction'])
  const overrides = asJsonObject(compaction?.['modelOverrides'])
  let removed = false
  if (overrides) {
    for (const key of Object.keys(overrides)) {
      if (key.startsWith(`${PROVIDER_ID}/`)) {
        delete overrides[key]
        removed = true
      }
    }
  }
  const ctx = knownWindow(contextLength)
  if (ctx === undefined) {
    if (removed && overrides && Object.keys(overrides).length === 0 && compaction) {
      delete compaction['modelOverrides']
      if (Object.keys(compaction).length === 0) delete settings['compaction']
    }
    return
  }
  const quarter = Math.floor(ctx / 4)
  setAt(settings, ['compaction', 'modelOverrides', `${PROVIDER_ID}/${model}`], {
    reserveTokens: quarter,
    keepRecentTokens: Math.min(quarter, KEEP_RECENT_TOKENS),
  })
}

export async function configurePi(input: ConfigureInput): Promise<void> {
  const { fs, apiUrl, model, apiKey, contextLength } = input
  const dir = piDir(fs, input.env)
  await fs.mkdirp(dir)

  const modelsPath = `${dir}/models.json`
  const modelsRoot = await readRoot(fs, modelsPath, false)
  await saveReplaced(fs, modelsRoot, modelsPath, MODELS_MANAGED)
  const entry: JsonObject = { id: model }
  const ctx = knownWindow(contextLength)
  if (ctx !== undefined) {
    entry['contextWindow'] = ctx
    entry['maxTokens'] = outputCap(ctx)
  }
  setAt(modelsRoot, ['providers', PROVIDER_ID], {
    name: PROVIDER_NAME,
    api: 'openai-completions',
    apiKey: keyOr(apiKey, 'atomic'),
    baseUrl: apiUrl,
    models: [entry],
  })
  await fs.write(modelsPath, canonicalJson(modelsRoot))

  const settingsPath = `${dir}/settings.json`
  const settingsRoot = await readRoot(fs, settingsPath, false)
  await saveReplaced(fs, settingsRoot, settingsPath, SETTINGS_MANAGED)
  settingsRoot['defaultProvider'] = PROVIDER_ID
  settingsRoot['defaultModel'] = model
  setCompaction(settingsRoot, model, contextLength)
  await fs.write(settingsPath, canonicalJson(settingsRoot))
}

registerWriter('pi', configurePi)
