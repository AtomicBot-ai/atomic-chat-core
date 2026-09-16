/**
 * Zed — `~/.config/zed/settings.json`.
 *
 * Port of `configure_zed` in `src-tauri/src/core/system/commands.rs`. Zed keeps custom endpoints
 * under `language_models.openai_compatible.<provider name>`, and the provider name doubles as the
 * id the agent's default-model selector refers to, hence the space in `"Atomic Chat"`.
 *
 * Two things are deliberate:
 *  - The API key is never persisted. Zed reads it from its keychain or from `ATOMIC_CHAT_API_KEY`,
 *    so `apiKey` is accepted for call-site symmetry and ignored.
 *  - Zed has no model discovery for these providers, so the running model is advertised
 *    explicitly. With no model loaded the provider is still registered, with an empty model list,
 *    so it shows up in Zed's UI — but `agent.default_model` is then left untouched.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import { canonicalJson, parseJsonLenient } from '../config-io.js'
import { asJsonObject } from './json-tree.js'
import type { ConfigureInput } from './registry.js'
import { registerWriter } from './registry.js'

const DIR = '.config/zed'
const PATH = `${DIR}/settings.json`
/** Map key under `openai_compatible`, and the provider id `agent.default_model` names. */
const ZED_PROVIDER_ID = 'Atomic Chat'

export async function configureZed(input: ConfigureInput): Promise<void> {
  const { fs, apiUrl, model } = input
  await fs.mkdirp(DIR)

  // Zed's settings.json allows comments and trailing commas, so read it the same way Zed does.
  const text = await fs.read(PATH)
  const parsed = text === undefined ? {} : parseJsonLenient(text, fs.absolute(PATH))
  const root = asJsonObject(parsed)
  if (!root) throw new AtomicCoreError('IO_ERROR', 'settings.json is not a JSON object')

  const languageModels = asJsonObject(root['language_models']) ?? {}
  root['language_models'] = languageModels
  const compatible = asJsonObject(languageModels['openai_compatible']) ?? {}
  languageModels['openai_compatible'] = compatible

  const availableModels =
    model === ''
      ? []
      : [
          {
            name: model,
            display_name: model,
            max_tokens: 32768,
            max_output_tokens: 8192,
            capabilities: {
              tools: true,
              images: true,
              parallel_tool_calls: false,
              prompt_cache_key: false,
            },
          },
        ]
  compatible[ZED_PROVIDER_ID] = { api_url: apiUrl, available_models: availableModels }

  if (model !== '') {
    const agent = asJsonObject(root['agent']) ?? {}
    root['agent'] = agent
    agent['default_model'] = { provider: ZED_PROVIDER_ID, model }
  }

  await fs.write(PATH, canonicalJson(root))
}

registerWriter('zed', configureZed)
