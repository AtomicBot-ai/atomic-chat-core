/**
 * GitHub Copilot CLI — an `atomic-chat` provider and its model in Copilot's `providers.json`.
 * Twin of `copilot_config.rs` in the app.
 *
 * Earlier releases persisted `COPILOT_PROVIDER_*`, `COPILOT_MODEL` and `COPILOT_OFFLINE=true`
 * user-wide (a marked block in the shell rc, `setx` on Windows), which put every `copilot` the user
 * ran on the local server — and a `providers.json` with any provider in it overrides those
 * variables anyway. The file is Copilot's documented home for named providers, holds the window
 * limits the variables could not, and lists the model beside the user's own; `launch` selects it for
 * the run through `COPILOT_MODEL=atomic-chat/<model>` (catalog `childEnv`), which Copilot reads like
 * `--model`. Our entries are replaced in place; every other provider and model is kept.
 *
 * Copilot reads `apiKey` literally (no variable references), so a keyed server's key is written into
 * the owner-only file, and a keyless one gets no key at all, as Copilot allows for a local server.
 *
 * Connect also removes exactly the rc blocks an earlier release wrote: a block must open and close
 * with our marker and hold only `export COPILOT_…` and blank lines, or the file stays as it is. The
 * Windows variables are removed by the desktop app.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { JsonValue } from '../config-io.js'
import { canonicalJson, expandTilde, parseJsonStrict } from '../config-io.js'
import { knownWindow, outputCap } from './backup.js'
import type { JsonObject } from './json-tree.js'
import { asJsonObject } from './json-tree.js'
import type { ConfigureWriter } from './registry.js'
import { registerWriter } from './registry.js'

/** Our provider's `name`; Copilot addresses the model as `atomic-chat/<model id>`. */
export const COPILOT_PROVIDER_NAME = 'atomic-chat'
const LEGACY_MARKER = '# Atomic Chat - Copilot CLI Config'
/** Every rc file an earlier release could have written to. */
const LEGACY_RC_FILES = ['.zshenv', '.bash_profile', '.bashrc']

/**
 * `providers.json` where Copilot reads it: `$COPILOT_PROVIDERS_CONFIG`, else
 * `$COPILOT_HOME/providers.json`, else `~/.copilot/providers.json`.
 */
export function copilotProvidersPath(env: NodeJS.ProcessEnv, home: string): string {
  const value = (name: string) => {
    const raw = env[name]?.trim()
    return raw ? expandTilde(raw, home) : undefined
  }
  return value('COPILOT_PROVIDERS_CONFIG') ?? `${value('COPILOT_HOME') ?? '.copilot'}/providers.json`
}

const named = (entry: JsonValue | undefined, field: string): boolean =>
  asJsonObject(entry)?.[field] === COPILOT_PROVIDER_NAME

/** `root[key]` as a list, created when absent or null (Copilot reads both as empty). */
function list(root: JsonObject, key: string, path: string): JsonValue[] {
  const value = root[key]
  if (value === undefined || value === null) root[key] = []
  const out = root[key]
  if (!Array.isArray(out)) {
    throw new AtomicCoreError(
      'IO_ERROR',
      `\`${key}\` in ${path} is not a list. Fix or remove it and try again.`
    )
  }
  return out
}

/**
 * `text` without the blocks an earlier release wrote, or `undefined` when there is nothing it can
 * vouch for.
 */
export function stripLegacyCopilotBlock(text: string): string | undefined {
  const isMarker = (line: string) => line.replace(/[\r\n]+$/, '') === LEGACY_MARKER
  const lines = text.split(/(?<=\n)/)
  if (!lines.some(isMarker)) return undefined
  const kept: string[] = []
  let open = false
  for (const line of lines) {
    if (isMarker(line)) {
      open = !open
      continue
    }
    if (open) {
      const bare = line.replace(/[\r\n]+$/, '')
      if (bare.trim() !== '' && !bare.startsWith('export COPILOT_')) return undefined
      continue
    }
    kept.push(line)
  }
  return open ? undefined : kept.join('')
}

export const configureCopilot: ConfigureWriter = async ({
  apiUrl,
  model,
  apiKey,
  fs,
  env,
  platform,
  contextLength,
}) => {
  const path = copilotProvidersPath(env, fs.home)
  const text = await fs.read(path)
  const root = asJsonObject(text === undefined ? {} : parseJsonStrict(text, fs.absolute(path)))
  if (!root) throw new AtomicCoreError('IO_ERROR', `${fs.absolute(path)} is not a JSON object`)

  const providers = list(root, 'providers', fs.absolute(path))
  const provider: JsonObject = {
    name: COPILOT_PROVIDER_NAME,
    type: 'openai',
    baseUrl: apiUrl,
    ...(apiKey ? { apiKey } : {}),
  }
  const at = providers.findIndex((p) => named(p, 'name'))
  if (at >= 0) {
    providers[at] = provider
    root['providers'] = providers.filter((p, i) => i <= at || !named(p, 'name'))
  } else {
    providers.push(provider)
  }

  const models = list(root, 'models', fs.absolute(path))
  const first = models.findIndex((m) => named(m, 'provider'))
  const others = models.filter((m) => !named(m, 'provider'))
  // A known window becomes Copilot's limits: the reply capped at a quarter of it (8192 at most) and
  // the prompt given the rest. Unknown, Copilot assumes 128K for a model it does not know.
  const window = knownWindow(contextLength)
  const ours: JsonObject = {
    id: model,
    provider: COPILOT_PROVIDER_NAME,
    ...(window !== undefined
      ? {
          maxContextWindowTokens: window,
          maxPromptTokens: window - outputCap(window),
          maxOutputTokens: outputCap(window),
        }
      : {}),
  }
  others.splice(first >= 0 ? Math.min(first, others.length) : others.length, 0, ours)
  root['models'] = others

  // Plain text keys, the user's own among them.
  await fs.write(path, canonicalJson(root), platform === 'win32' ? {} : { mode: 0o600 })

  for (const rc of LEGACY_RC_FILES) {
    const existing = await fs.read(rc)
    const stripped = existing === undefined ? undefined : stripLegacyCopilotBlock(existing)
    // Written through a symbolic link (dotfile managers link rc files), never over it.
    if (stripped !== undefined) await fs.write(await fs.linkTarget(rc), stripped)
  }
}

registerWriter('copilot', configureCopilot)
