/**
 * DeepSeek Harness (`dsh`) reads `$DSH_HOME/settings.yaml` (default `~/.dsh`) live, so pointing it at
 * the local server is a single upsert of the `llm-pi-ai.providers.atomic` route — no restart needed.
 *
 * This is the only writer here that refuses its input, and the reason is blast radius: dsh rejects
 * the ENTIRE `llm-pi-ai` section when one route in it is invalid, taking the user's other providers
 * down with it. A route needs `api`, `baseURL` and a non-empty `models` list, so a blank URL or model
 * is refused before the tree is touched at all. The credential is validated for the same reason: an
 * unquoted dotenv value ends at whitespace or `#`, and a newline would inject a second assignment, so
 * a key carrying any of those is rejected — with a message that names the variable and never the
 * value, so a rejected key cannot leak into a log or a toast.
 *
 * Two more things are load-bearing. The route is replaced WHOLESALE rather than deep-merged: a merge
 * would let a stale `apiKeyEnv` from an earlier keyed run survive a keyless run and break every
 * request with MISSING_CREDENTIAL. And because the YAML round trip drops comments and expands
 * anchors, the pre-existing file is copied to `settings.yaml.atomic-backup` — once, so a later run
 * cannot overwrite the true pre-Atomic state with our own generated output.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { ConfigFs } from '../config-io.js'
import {
  ATOMIC_MANAGED_BEGIN,
  ATOMIC_MANAGED_END,
  canonicalYaml,
  expandTilde,
  parseYaml,
  stripAtomicManagedBlock,
} from '../config-io.js'
import type { ConfigureWriter } from './registry.js'
import { registerWriter } from './registry.js'

const SECTION = 'llm-pi-ai'
const ROUTE_ID = 'atomic'
/** The route names an env var, never the secret itself. */
const KEY_ENV = 'ATOMIC_API_KEY'
const CONTEXT_WINDOW = 65_536
const MAX_TOKENS = 8_192

type YamlMapping = Record<string, unknown>

function asMapping(value: unknown): YamlMapping | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as YamlMapping
}

/**
 * Borrow `parent[key]` as a mapping, creating it when absent. A bare `llm-pi-ai:` with nothing under
 * it parses to null, which is a hole to fill rather than data to protect. Anything else non-mapping
 * is real user content and errors out — `settings.yaml` is shared with every other harness plugin, so
 * a silent overwrite would delete config we do not own.
 */
function childMapping(parent: YamlMapping, key: string, label: string): YamlMapping {
  if (parent[key] === undefined || parent[key] === null) parent[key] = {}
  const child = asMapping(parent[key])
  if (!child) {
    throw new AtomicCoreError(
      'IO_ERROR',
      `\`${label}\` in settings.yaml is not a mapping. Fix or remove it and try again.`
    )
  }
  return child
}

/** Reject a value no dotenv line can carry. The message names the variable, never the value. */
export function dshValidateEnvValue(name: string, value: string): void {
  if (/[\n\r#"']/.test(value) || /\s/.test(value)) {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      `${name} contains characters that cannot be stored in a .env file`
    )
  }
}

/** The `llm-pi-ai.providers.atomic` node. Keyless omits `apiKeyEnv` rather than writing an empty one. */
export function dshRouteNode(apiUrl: string, model: string, withKey: boolean): YamlMapping {
  return {
    displayName: 'Atomic Chat',
    api: 'openai-completions',
    baseURL: apiUrl,
    ...(withKey ? { apiKeyEnv: KEY_ENV } : {}),
    models: [{ id: model, contextWindow: CONTEXT_WINDOW, maxTokens: MAX_TOKENS }],
  }
}

/**
 * Upsert our route into an already-parsed tree. Pure: no I/O, no environment. Everything outside
 * `llm-pi-ai.providers.atomic` is preserved, including relative order — assigning to an existing key
 * keeps its position, in JavaScript as in `serde_yaml`'s insertion-ordered mapping.
 */
export function applyDshProvider(root: unknown, apiUrl: string, model: string, withKey: boolean): unknown {
  if (apiUrl.trim() === '') {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      'No local server URL. Start the local API server and try again.'
    )
  }
  if (model.trim() === '') {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      'No model selected. DeepSeek Harness rejects a provider with an empty model list, which would ' +
        'also disable any other provider configured in that section.'
    )
  }
  // An empty, whitespace-only or comment-only document parses to null; one heal covers all three.
  const healed = root === null || root === undefined ? {} : root
  const map = asMapping(healed)
  if (!map) throw new AtomicCoreError('IO_ERROR', 'settings.yaml top level is not a YAML mapping')

  const section = childMapping(map, SECTION, SECTION)
  const providers = childMapping(section, 'providers', `${SECTION}.providers`)
  providers[ROUTE_ID] = dshRouteNode(apiUrl, model, withKey)
  return map
}

/**
 * Upsert — or, with no vars, remove — our managed block in a dotenv file, preserving every line
 * outside it. Deliberately not the shell-rc writer: that one emits `export K='V'`, uses a different
 * marker scheme, and always appends a fresh block, so it cannot express "remove the block and write
 * nothing", which is exactly what the keyless path needs.
 */
async function writeManagedEnv(
  fs: ConfigFs,
  path: string,
  vars: Array<{ name: string; value: string }>,
  unix: boolean
): Promise<void> {
  for (const v of vars) dshValidateEnvValue(v.name, v.value)

  const found = await fs.read(path)
  // Nothing to clear: do not create the file just to leave it empty.
  if (found === undefined && vars.length === 0) return
  const kept = stripAtomicManagedBlock(found ?? '').trimEnd()

  let out: string
  if (vars.length === 0) {
    out = kept === '' ? '' : `${kept}\n`
  } else {
    const body = vars.map((v) => `${v.name}=${v.value}\n`).join('')
    const block = `${ATOMIC_MANAGED_BEGIN}\n${body}${ATOMIC_MANAGED_END}\n`
    out = kept === '' ? block : `${kept}\n\n${block}`
  }
  await fs.write(path, out, unix ? { mode: 0o600 } : {})
}

/** `$DSH_HOME` when set, else `~/.dsh`. A literal `~` can reach us from a quoted rc-file value. */
export function dshHome(env: NodeJS.ProcessEnv, home: string): string {
  const raw = env['DSH_HOME']?.trim()
  return raw ? expandTilde(raw, home) : '.dsh'
}

export const configureDsh: ConfigureWriter = async ({ apiUrl, model, apiKey, fs, env, platform }) => {
  const dir = dshHome(env, fs.home)
  const settingsPath = `${dir}/settings.yaml`

  const trimmed = apiKey.trim()
  const key = trimmed === '' ? undefined : trimmed
  // Validate the credential before settings.yaml, so an unusable key cannot leave a route pointing at
  // a reference we then failed to store.
  if (key !== undefined) dshValidateEnvValue(KEY_ENV, key)

  // Parse before creating anything, so a malformed file leaves no debris.
  const text = (await fs.read(settingsPath)) ?? ''
  const root = parseYaml(text, fs.absolute(settingsPath))
  const patched = applyDshProvider(root, apiUrl, model, key !== undefined)

  const serialized = canonicalYaml(patched)

  if (text !== '') {
    const backup = `${dir}/settings.yaml.atomic-backup`
    if (!(await fs.exists(backup))) await fs.write(backup, text)
  }
  await fs.write(settingsPath, serialized.endsWith('\n') ? serialized : `${serialized}\n`)

  // The secret never enters settings.yaml. dsh resolves the reference from the inherited environment,
  // then `$DSH_HOME/.credentials.yaml`, then the invoking directory's `.env`, then this file — the
  // lowest-precedence layer, so anything the user sets deliberately still wins.
  const unix = platform !== 'win32'
  await writeManagedEnv(
    fs,
    `${dir}/.env`,
    // Keyless: the route carries no `apiKeyEnv`, so a leftover value would outlive its use.
    key === undefined ? [] : [{ name: KEY_ENV, value: key }],
    unix
  )
}

registerWriter('dsh', configureDsh)
