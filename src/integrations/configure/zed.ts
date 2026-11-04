/**
 * Zed — `settings.json` in Zed's config directory (`zedConfigDir`).
 *
 * Port of `configure_zed` in `src-tauri/src/core/system/commands.rs`. Zed keeps custom endpoints
 * under `language_models.openai_compatible.<provider name>`, and the provider name doubles as the
 * id the agent's default-model selector refers to, hence the space in `"Atomic Chat"`.
 *
 * Three things are deliberate:
 *  - The API key is never persisted. Zed reads it from its keychain or from `ATOMIC_CHAT_API_KEY`,
 *    so `apiKey` is accepted for call-site symmetry and ignored.
 *  - Zed has no model discovery for these providers, so the running model is advertised
 *    explicitly, with the served window when it is known. With no model loaded the provider is
 *    still registered, with an empty model list, so it shows up in Zed's UI — but
 *    `agent.default_model` is then left untouched.
 *  - A default model of the user's that we replace is kept in a sidecar next to `settings.json`,
 *    so the app's Disconnect can put it back.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { ConfigFs, JsonValue } from '../config-io.js'
import { canonicalJson, parseJsonLenient } from '../config-io.js'
import { asJsonObject } from './json-tree.js'
import type { ConfigureInput } from './registry.js'
import { registerWriter } from './registry.js'

/** Map key under `openai_compatible`, and the provider id `agent.default_model` names. */
const ZED_PROVIDER_ID = 'Atomic Chat'
/** Zed requires a `max_tokens` per model; with the served window unknown, what it always got. */
const ZED_FALLBACK_CONTEXT = 32_768
const ZED_MAX_OUTPUT_TOKENS = 8_192
/** Sidecar (`<config>.atomic-chat-backup.json`) key for the default model a Connect replaced. */
export const ZED_DEFAULT_MODEL_KEY = 'agent.default_model'

/**
 * Zed's config directory, resolved the way Zed's own `paths::config_dir` does: `%APPDATA%\Zed` on
 * Windows, `$XDG_CONFIG_HOME/zed` (else `~/.config/zed`) on Linux, `~/.config/zed` on macOS.
 * Relative to the home directory when it lies under it.
 */
export function zedConfigDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, fs: ConfigFs): string {
  const set = (name: string) => {
    const value = env[name]
    return value && value.trim() !== '' ? value : undefined
  }
  if (platform === 'win32') {
    const appData = set('APPDATA')
    return appData ? `${appData}/Zed` : fs.absolute('AppData/Roaming/Zed')
  }
  if (platform !== 'darwin') {
    const xdg = set('XDG_CONFIG_HOME')
    if (xdg?.startsWith('/')) return `${xdg}/zed`
  }
  return '.config/zed'
}

/** The served window, and a quarter of it for output (at most 8192). */
function modelLimits(contextLength: number | undefined): { maxTokens: number; maxOutputTokens: number } {
  const context = contextLength && contextLength > 0 ? contextLength : ZED_FALLBACK_CONTEXT
  return {
    maxTokens: context,
    maxOutputTokens: Math.max(1, Math.min(ZED_MAX_OUTPUT_TOKENS, Math.floor(context / 4))),
  }
}

const isOurSelection = (value: JsonValue | undefined) => asJsonObject(value)?.['provider'] === ZED_PROVIDER_ID

export async function configureZed(input: ConfigureInput): Promise<void> {
  const { fs, apiUrl, model } = input
  const dir = zedConfigDir(input.env, input.platform, fs)
  const path = `${dir}/settings.json`
  await fs.mkdirp(dir)

  // Zed's settings.json allows comments and trailing commas, so read it the same way Zed does.
  const text = await fs.read(path)
  const parsed = text === undefined ? {} : parseJsonLenient(text, fs.absolute(path))
  const root = asJsonObject(parsed)
  if (!root) throw new AtomicCoreError('IO_ERROR', 'settings.json is not a JSON object')

  const languageModels = asJsonObject(root['language_models']) ?? {}
  root['language_models'] = languageModels
  const compatible = asJsonObject(languageModels['openai_compatible']) ?? {}
  languageModels['openai_compatible'] = compatible

  const { maxTokens, maxOutputTokens } = modelLimits(input.contextLength)
  const availableModels =
    model === ''
      ? []
      : [
          {
            name: model,
            display_name: model,
            max_tokens: maxTokens,
            max_output_tokens: maxOutputTokens,
            capabilities: {
              tools: true,
              // Zed's own default: whether the served model takes images is not known here.
              images: false,
              parallel_tool_calls: false,
              prompt_cache_key: false,
            },
          },
        ]
  compatible[ZED_PROVIDER_ID] = { api_url: apiUrl, available_models: availableModels }

  if (model !== '') {
    const agent = asJsonObject(root['agent']) ?? {}
    root['agent'] = agent
    const previous = agent['default_model']
    if (!isOurSelection(previous)) {
      const sidecar = `${path}.atomic-chat-backup.json`
      if (previous === undefined) await fs.remove(sidecar)
      else await fs.write(sidecar, canonicalJson({ [ZED_DEFAULT_MODEL_KEY]: previous }))
    }
    agent['default_model'] = { provider: ZED_PROVIDER_ID, model }
  }

  await fs.write(path, canonicalJson(root))
}

registerWriter('zed', configureZed)
