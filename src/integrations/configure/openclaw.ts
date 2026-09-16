/**
 * OpenClaw keeps one config for the CLI and both desktop apps in `~/.openclaw/openclaw.json`
 * (overridable with `OPENCLAW_CONFIG_PATH`); its Gateway watches the file and hot-reloads, so one
 * write covers everything with no restart.
 *
 * The merge has two tiers. Keys that express a decision the user may have made deliberately are
 * SEEDED only when absent — `models.mode`, `gateway.mode`, `gateway.auth.mode`,
 * `agents.defaults.timeoutSeconds`, and the per-model settings entry. Keys that say "run this model
 * now" are always OVERWRITTEN — our provider block and `agents.defaults.model.primary`.
 *
 * The one non-obvious rule is `modelPolicy.allow`. When it is non-empty it gates model selection
 * entirely, so a user restricted to a cloud provider would watch Run "succeed" and then be told our
 * model is not allowed — hence the `atomic/*` widening. But an absent key or `[]` already means
 * "allow anything", so writing into it would INTRODUCE a restriction nobody asked for. Those are
 * left exactly as they are.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { JsonValue } from '../config-io.js'
import { canonicalJson, keyOr, parseJsonLenient } from '../config-io.js'
import type { JsonObject } from './json-tree.js'
import { asJsonArray, asJsonObject } from './json-tree.js'
import type { ConfigureInput, ConfigureWriter } from './registry.js'
import { registerWriter } from './registry.js'

const PROVIDER_ID = 'atomic'
const DEFAULT_PATH = '.openclaw/openclaw.json'
/** Small local models blow past OpenClaw's short default once wrapped in the agent prompt + tools. */
const DEFAULT_TIMEOUT_SECONDS = 240

/** Read `<parent>[key]` as an object, creating it when absent; anything else is a hard error. */
function childObject(parent: JsonObject, key: string, label: string): JsonObject {
  if (parent[key] === undefined) parent[key] = {}
  const child = asJsonObject(parent[key])
  if (!child) throw new AtomicCoreError('IO_ERROR', `${label} is not a JSON object`)
  return child
}

/** Whether an allow-list already covers `modelRef`. A trailing `*` makes the entry a prefix match. */
export function modelPolicyAllows(list: JsonValue[], modelRef: string): boolean {
  return list.some((entry) => {
    if (typeof entry !== 'string') return false
    return entry.endsWith('*') ? modelRef.startsWith(entry.slice(0, -1)) : entry === modelRef
  })
}

/** The whole merge, with no I/O, so every rule above is testable against a plain object. */
export function openclawPatchConfig(
  parsed: JsonValue,
  apiUrl: string,
  model: string,
  apiKey: string
): JsonObject {
  const root = asJsonObject(parsed)
  if (!root) throw new AtomicCoreError('IO_ERROR', 'openclaw.json is not a JSON object')

  const modelRef = `${PROVIDER_ID}/${model}`

  const models = childObject(root, 'models', 'models')
  if (models['mode'] === undefined) models['mode'] = 'merge'
  const providers = childObject(models, 'providers', 'models.providers')
  // The catalog entry's `id` is the bare model id our /v1 server reports; OpenClaw builds the ref as
  // `<providerId>/<id>`, so prefixing here would double it to `atomic/atomic/…` and break lookup.
  providers[PROVIDER_ID] = {
    baseUrl: apiUrl,
    apiKey: keyOr(apiKey, 'atomic'),
    api: 'openai-completions',
    models: [{ id: model, name: model }],
  }

  // The local gateway refuses to open its websocket without connection auth; for a loopback-only
  // setup "none" (private-ingress open auth) is what makes the agent reachable with no token.
  const gateway = childObject(root, 'gateway', 'gateway')
  if (gateway['mode'] === undefined) gateway['mode'] = 'local'
  const auth = childObject(gateway, 'auth', 'gateway.auth')
  if (auth['mode'] === undefined) auth['mode'] = 'none'

  const agents = childObject(root, 'agents', 'agents')
  const defaults = childObject(agents, 'defaults', 'agents.defaults')
  if (defaults['timeoutSeconds'] === undefined) defaults['timeoutSeconds'] = DEFAULT_TIMEOUT_SECONDS

  // Both a plain string and an object are accepted here, but only the object form has room for the
  // fallbacks OpenClaw writes itself, so a string is normalised rather than extended.
  if (asJsonObject(defaults['model']) === undefined) defaults['model'] = {}
  const modelEntry = asJsonObject(defaults['model']) as JsonObject
  modelEntry['primary'] = modelRef

  // `agents.defaults.models` holds aliases and per-model settings. Pre-migration builds also read it
  // as an allowlist, so the entry is still seeded; on current builds it restricts nothing.
  const settings = childObject(defaults, 'models', 'agents.defaults.models')
  if (settings[modelRef] === undefined) settings[modelRef] = {}

  const allow = asJsonArray(asJsonObject(defaults['modelPolicy'])?.['allow'])
  if (allow && allow.length > 0 && !modelPolicyAllows(allow, modelRef)) {
    allow.push(`${PROVIDER_ID}/*`)
  }

  return root
}

export const configureOpenclaw: ConfigureWriter = async ({
  apiUrl,
  model,
  apiKey,
  fs,
  env,
}: ConfigureInput) => {
  const override = env['OPENCLAW_CONFIG_PATH']
  const path = override && override.length > 0 ? override : DEFAULT_PATH

  // OpenClaw reads this file as JSON5, so we must parse with the same leniency or we reject configs
  // it happily accepts. Comments are dropped on write; every setting is preserved.
  const text = await fs.read(path)
  const parsed = text === undefined ? {} : parseJsonLenient(text, fs.absolute(path))
  await fs.write(path, canonicalJson(openclawPatchConfig(parsed, apiUrl, model, apiKey)))
}

registerWriter('openclaw', configureOpenclaw)
