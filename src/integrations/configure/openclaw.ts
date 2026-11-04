/**
 * OpenClaw keeps one config for the CLI and the macOS app in `~/.openclaw/openclaw.json`
 * (overridable with `OPENCLAW_CONFIG_PATH`); its Gateway watches the file and hot-reloads, so one
 * write covers everything with no restart.
 *
 * The merge has two tiers. Keys that express a decision the user may have made deliberately are
 * SEEDED only when absent — `models.mode`, `gateway.mode`, `gateway.auth.mode` (and that one only
 * when the Gateway has no token or password to expect), and the per-model settings entry. Keys that
 * say "run this model now" are always OVERWRITTEN — our provider block and
 * `agents.defaults.model.primary`. What the keys held before is recorded in
 * `openclaw.json.atomic-chat-backup.json` for the app's Disconnect.
 *
 * The one non-obvious rule is `modelPolicy.allow`. When it is non-empty it gates model selection
 * entirely, so a user restricted to a cloud provider would watch Run "succeed" and then be told our
 * model is not allowed — hence the `atomic/*` widening. But an absent key or `[]` already means
 * "allow anything", so writing into it would INTRODUCE a restriction nobody asked for. Those are
 * left exactly as they are.
 *
 * Mirrors `configure_openclaw_at` in the app's `core/system/commands.rs`, byte for byte.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { JsonValue } from '../config-io.js'
import { canonicalJson, keyOr, parseJsonLenient } from '../config-io.js'
import { readBackup, renderBackup, trackKeys, writeBackupText } from './json-key-backup.js'
import type { JsonObject } from './json-tree.js'
import { asJsonArray, asJsonObject } from './json-tree.js'
import type { ConfigureInput, ConfigureWriter } from './registry.js'
import { registerWriter } from './registry.js'

const PROVIDER_ID = 'atomic'
const DEFAULT_PATH = '.openclaw/openclaw.json'
/**
 * Per-request budget on our provider: it covers connecting, the headers and streaming the body, and
 * raises the ~120 s idle watchdog for this provider only — a long prompt on a slow machine needs
 * more before the first token. Unlike `agents.defaults.timeoutSeconds`, it leaves every other model
 * alone.
 */
const PROVIDER_TIMEOUT_SECONDS = 600
/** `agents.defaults.timeoutSeconds` older releases seeded, capping every model's attempt. */
const LEGACY_AGENT_TIMEOUT_SECONDS = 240

/** The output cap written next to a known window: a quarter of it, at most 8192 tokens. */
export function outputCapFor(contextLength: number): number {
  return Math.min(8192, Math.floor(contextLength / 4))
}

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

/**
 * Bring a parsed `openclaw.json` into the shape the merge works on without changing what it means:
 * a plain-string `agents.defaults.model` becomes `{ primary: <it> }`, and the
 * `agents.defaults.timeoutSeconds: 240` older releases seeded goes.
 */
export function openclawNormalize(parsed: JsonValue): void {
  const defaults = asJsonObject(asJsonObject(asJsonObject(parsed)?.['agents'])?.['defaults'])
  if (!defaults) return
  if (defaults['timeoutSeconds'] === LEGACY_AGENT_TIMEOUT_SECONDS) delete defaults['timeoutSeconds']
  const model = defaults['model']
  if (typeof model === 'string') defaults['model'] = { primary: model }
}

/** The keys Connect may overwrite besides our own provider entry. */
export function openclawTrackedPaths(modelRef: string): string[][] {
  return [
    ['models', 'mode'],
    ['gateway', 'mode'],
    ['gateway', 'auth', 'mode'],
    ['agents', 'defaults', 'model', 'primary'],
    ['agents', 'defaults', 'models', modelRef],
    ['agents', 'defaults', 'modelPolicy', 'allow'],
  ]
}

/** The whole merge, with no I/O, so every rule above is testable against a plain object. */
export function openclawPatchConfig(
  parsed: JsonValue,
  apiUrl: string,
  model: string,
  apiKey: string,
  contextLength?: number,
  gatewaySecretInEnv = false
): JsonObject {
  const root = asJsonObject(parsed)
  if (!root) throw new AtomicCoreError('IO_ERROR', 'openclaw.json is not a JSON object')

  const modelRef = `${PROVIDER_ID}/${model}`

  const models = childObject(root, 'models', 'models')
  if (models['mode'] === undefined) models['mode'] = 'merge'
  const providers = childObject(models, 'providers', 'models.providers')
  // The catalog entry's `id` is the bare model id our /v1 server reports; OpenClaw builds the ref as
  // `<providerId>/<id>`, so prefixing here would double it to `atomic/atomic/…` and break lookup. A
  // known window lets OpenClaw compact before the server refuses; an unknown one is not invented.
  const modelEntry: JsonObject = { id: model, name: model }
  if (contextLength !== undefined) {
    modelEntry['contextWindow'] = contextLength
    modelEntry['maxTokens'] = outputCapFor(contextLength)
  }
  providers[PROVIDER_ID] = {
    baseUrl: apiUrl,
    apiKey: keyOr(apiKey, 'atomic'),
    api: 'openai-completions',
    timeoutSeconds: PROVIDER_TIMEOUT_SECONDS,
    models: [modelEntry],
  }

  const gateway = childObject(root, 'gateway', 'gateway')
  if (gateway['mode'] === undefined) gateway['mode'] = 'local'
  // The local Gateway refuses its websocket without connection auth and, with no mode set, expects a
  // token. With no token or password to expect, "none" (private-ingress open auth) makes it
  // reachable; with one, "none" would switch token auth off.
  const auth = asJsonObject(gateway['auth'])
  const authIsSet = ['mode', 'token', 'password'].some((key) => {
    const value = auth?.[key]
    return value !== undefined && value !== null && value !== ''
  })
  if (!authIsSet && !gatewaySecretInEnv) childObject(gateway, 'auth', 'gateway.auth')['mode'] = 'none'

  const agents = childObject(root, 'agents', 'agents')
  const defaults = childObject(agents, 'defaults', 'agents.defaults')

  if (asJsonObject(defaults['model']) === undefined) defaults['model'] = {}
  const primary = asJsonObject(defaults['model']) as JsonObject
  primary['primary'] = modelRef

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
  contextLength,
}: ConfigureInput) => {
  const override = env['OPENCLAW_CONFIG_PATH']
  const path = override && override.length > 0 ? override : DEFAULT_PATH
  const gatewaySecretInEnv = ['OPENCLAW_GATEWAY_TOKEN', 'OPENCLAW_GATEWAY_PASSWORD'].some(
    (name) => (env[name] ?? '').trim() !== ''
  )

  // OpenClaw reads this file as JSON5, so we must parse with the same leniency or we reject configs
  // it happily accepts. Comments are dropped on write; every setting is preserved.
  const text = await fs.read(path)
  const base = text === undefined ? {} : parseJsonLenient(text, fs.absolute(path))
  openclawNormalize(base)
  const patched = openclawPatchConfig(
    JSON.parse(JSON.stringify(base)) as JsonValue,
    apiUrl,
    model,
    apiKey,
    contextLength,
    gatewaySecretInEnv
  )
  const previous = await readBackup(fs, path)
  const keys = trackKeys(base, patched, openclawTrackedPaths(`${PROVIDER_ID}/${model}`), previous?.keys ?? [])
  await fs.write(path, canonicalJson(patched))
  await writeBackupText(fs, path, renderBackup({ keys, seeded: [] }))
}

registerWriter('openclaw', configureOpenclaw)
