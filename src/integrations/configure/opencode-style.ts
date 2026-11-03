/**
 * The provider block three agents share: OpenCode, its fork MiMo Code, and Kilo Code.
 *
 * All three keep one JSON file whose `provider.<id>` map names an `@ai-sdk/openai-compatible`
 * endpoint, and all three are configured by upserting a single `atomic` entry into it and then
 * selecting `"<providerId>/<modelId>"` as the active model. Port of `opencode_family.rs` in the app,
 * byte for byte.
 *
 * Everything the user already had is preserved: other providers, unrelated top-level keys, and an
 * existing `$schema`. The active model is overwritten on purpose — pressing Run is an explicit
 * "use this one" — but what it replaces is kept in `<config file>.atomic-chat-backup.json` beside
 * the file, for the app's Disconnect to put back. A value that is already ours is not kept: a
 * reconnect keeps the one saved the first time.
 *
 * The files are read as JSON5 (comments, trailing commas), as the agents read them, and written
 * back as strict JSON, which drops the comments.
 */

import { basename, isAbsolute } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import { canonicalJson, expandTilde, keyOr, parseJsonLenient, parseJsonStrict } from '../config-io.js'
import type { ConfigFs, JsonValue } from '../config-io.js'
import { asJsonObject } from './json-tree.js'
import type { JsonObject } from './json-tree.js'
import type { ConfigureInput } from './registry.js'

export const PROVIDER_ID = 'atomic'
/** The display name of our provider entry, which is also how an entry is recognised as ours. */
export const PROVIDER_NAME = 'Atomic Chat'
const BACKUP_SUFFIX = '.atomic-chat-backup.json'
const BACKUP_ABOUT =
  'Atomic Chat keeps the settings its connection replaced here and puts them back on Disconnect.'
/** The longest reply an agent asks for: a quarter of the window, at most this. */
const OUTPUT_CAP = 8192

/** The output cap for a window of `contextLength` tokens. */
export function outputCap(contextLength: number): number {
  return Math.min(OUTPUT_CAP, Math.floor(contextLength / 4))
}

/** A known window, or `undefined` for none. */
export function knownWindow(contextLength: number | undefined): number | undefined {
  return contextLength !== undefined && contextLength > 0 ? Math.floor(contextLength) : undefined
}

// ── where the configs live ──────────────────────────────────────────────────────────────────────

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]
  return value !== undefined && value.trim() !== '' ? value : undefined
}

/** `$XDG_CONFIG_HOME`, else `.config` under the home — on every OS, as `xdg-basedir` resolves it. */
function xdgConfigHome(env: NodeJS.ProcessEnv): string {
  return envValue(env, 'XDG_CONFIG_HOME') ?? '.config'
}

/** One agent's config file, and the files beside it an earlier release may have written. */
export interface ConfigTarget {
  /** The file Connect writes (relative to the home, or absolute). */
  file: string
  /** Read before `file`: whatever of ours is left there is removed. */
  others: string[]
}

/** `<stem>.jsonc` when it exists — read after `<stem>.json`, so it wins — else `<stem>.json`. */
async function dirTarget(fs: ConfigFs, dir: string, stem: string): Promise<ConfigTarget> {
  const json = `${dir}/${stem}.json`
  const jsonc = `${dir}/${stem}.jsonc`
  return (await fs.exists(jsonc)) ? { file: jsonc, others: [json] } : { file: json, others: [] }
}

/** Kilo: `$KILO_CONFIG_DIR` (read after the global directory), else `<xdg>/kilo`; always `kilo.jsonc`. */
export function kiloTarget(env: NodeJS.ProcessEnv): ConfigTarget {
  const dir = envValue(env, 'KILO_CONFIG_DIR') ?? `${xdgConfigHome(env)}/kilo`
  return { file: `${dir}/kilo.jsonc`, others: [] }
}

/** OpenCode: `$OPENCODE_CONFIG_DIR` is read last, an `$OPENCODE_CONFIG` file after the global one. */
export async function opencodeTarget(fs: ConfigFs, env: NodeJS.ProcessEnv): Promise<ConfigTarget> {
  const dir = envValue(env, 'OPENCODE_CONFIG_DIR')
  if (dir) return dirTarget(fs, dir, 'opencode')
  const file = envValue(env, 'OPENCODE_CONFIG')
  if (file) return { file, others: [] }
  return dirTarget(fs, `${xdgConfigHome(env)}/opencode`, 'opencode')
}

/** MiMo: an absolute `$MIMOCODE_HOME` holds `config/` (MiMo refuses a relative one). */
export async function mimoTarget(fs: ConfigFs, env: NodeJS.ProcessEnv): Promise<ConfigTarget> {
  const home = envValue(env, 'MIMOCODE_HOME')
  return dirTarget(
    fs,
    home !== undefined && isAbsolute(home) ? `${home}/config` : `${xdgConfigHome(env)}/mimocode`,
    'mimocode'
  )
}

/** pi's agent directory: `$PI_CODING_AGENT_DIR` (a leading `~` expanded), else `.pi/agent`. */
export function piDir(fs: ConfigFs, env: NodeJS.ProcessEnv): string {
  const dir = envValue(env, 'PI_CODING_AGENT_DIR')
  return dir ? expandTilde(dir, fs.home) : '.pi/agent'
}

// ── JSON in place ───────────────────────────────────────────────────────────────────────────────

/** The file as a JSON object (blank or missing is `{}`); anything else is refused. */
export async function readRoot(fs: ConfigFs, path: string, lenient: boolean): Promise<JsonObject> {
  const text = await fs.read(path)
  const parse = lenient ? parseJsonLenient : parseJsonStrict
  const parsed = text === undefined ? {} : parse(text, fs.absolute(path))
  const root = asJsonObject(parsed)
  if (!root) throw new AtomicCoreError('IO_ERROR', `${basename(path)} is not a JSON object`)
  return root
}

function at(root: JsonValue, keys: readonly string[]): JsonValue | undefined {
  let node: JsonValue | undefined = root
  for (const key of keys) {
    const obj = asJsonObject(node)
    if (!obj || !(key in obj)) return undefined
    node = obj[key]
  }
  return node
}

/** Set `keys` to `value`, making objects of whatever is missing or not an object on the way. */
export function setAt(root: JsonObject, keys: readonly string[], value: JsonValue): void {
  let node = root
  for (const key of keys.slice(0, -1)) {
    let next = asJsonObject(node[key])
    if (!next) {
      next = {}
      node[key] = next
    }
    node = next
  }
  node[keys[keys.length - 1] as string] = value
}

function removeAt(root: JsonObject, keys: readonly string[]): void {
  const parent = asJsonObject(at(root, keys.slice(0, -1)))
  if (parent) delete parent[keys[keys.length - 1] as string]
}

// ── backup of the replaced values ───────────────────────────────────────────────────────────────

/** A key Connect overwrites, and how to tell (from the whole root) that what it holds is ours. */
export interface Managed {
  keys: readonly string[]
  ours: (root: JsonObject) => boolean
}

export function backupPath(config: string): string {
  return `${config}${BACKUP_SUFFIX}`
}

async function savedValues(fs: ConfigFs, config: string): Promise<JsonObject> {
  const text = await fs.read(backupPath(config))
  if (text === undefined) return {}
  try {
    return asJsonObject(asJsonObject(JSON.parse(text))?.['previous']) ?? {}
  } catch {
    return {}
  }
}

/**
 * Before Connect writes `managed` into `root` (the file at `config` as it is now), save what they hold
 * that is not ours. Nothing to save removes an earlier backup.
 */
export async function saveReplaced(
  fs: ConfigFs,
  root: JsonObject,
  config: string,
  managed: readonly Managed[]
): Promise<void> {
  const saved = await savedValues(fs, config)
  const previous: JsonObject = {}
  for (const m of managed) {
    const current = at(root, m.keys)
    if (current === undefined) continue
    // Ours from an earlier Connect: what that one saved still stands.
    const kept = m.ours(root) ? at(saved, m.keys) : current
    if (kept !== undefined) setAt(previous, m.keys, kept)
  }
  if (Object.keys(previous).length === 0) {
    await fs.remove(backupPath(config))
    return
  }
  await fs.write(backupPath(config), canonicalJson({ about: BACKUP_ABOUT, previous }))
}

/** Put back what Connect replaced, for each key that is still ours. Whether anything changed. */
export async function restoreReplaced(
  fs: ConfigFs,
  root: JsonObject,
  config: string,
  managed: readonly Managed[]
): Promise<boolean> {
  const saved = await savedValues(fs, config)
  // Judge every key before touching any: a pair is judged together.
  const ours = managed.map((m) => at(root, m.keys) !== undefined && m.ours(root))
  let changed = false
  managed.forEach((m, i) => {
    if (!ours[i]) return
    const previous = at(saved, m.keys)
    if (previous !== undefined) setAt(root, m.keys, previous)
    else removeAt(root, m.keys)
    changed = true
  })
  return changed
}

// ── Kilo Code, OpenCode, MiMo Code ──────────────────────────────────────────────────────────────

export interface OpencodeStyleSpec {
  /** `$schema` seeded into a config that does not carry one yet. */
  schema: string
  /** A `$schema` an earlier release wrote by mistake; replaced by `schema`. */
  staleSchema?: string
}

const OPENCODE_MANAGED: readonly Managed[] = [
  {
    keys: ['model'],
    ours: (root) => typeof root['model'] === 'string' && root['model'].startsWith(`${PROVIDER_ID}/`),
  },
  {
    keys: ['provider', PROVIDER_ID],
    ours: (root) => at(root, ['provider', PROVIDER_ID, 'name']) === PROVIDER_NAME,
  },
]

/**
 * The `models.<id>` entry: thinking models answer in `reasoning_content`, which the agent then shows
 * as thoughts and sends back within a tool loop (a model that does not think sends an empty one,
 * which servers drop); the window and output cap when known, without which the agent never compacts
 * and asks for 32K tokens per reply.
 */
function modelEntry(model: string, contextLength: number | undefined): JsonObject {
  const entry: JsonObject = { name: model, reasoning: true, interleaved: { field: 'reasoning_content' } }
  const ctx = knownWindow(contextLength)
  if (ctx !== undefined) entry['limit'] = { context: ctx, output: outputCap(ctx) }
  return entry
}

export function opencodeProviderEntry(input: ConfigureInput): JsonObject {
  const { apiUrl, model, apiKey, contextLength } = input
  return {
    name: PROVIDER_NAME,
    npm: '@ai-sdk/openai-compatible',
    // A local model can read a long prompt for longer than the 5 minutes these agents wait for the
    // first byte, and then they give up.
    options: { baseURL: apiUrl, apiKey: keyOr(apiKey, 'atomic'), timeout: false, headerTimeout: false },
    models: { [model]: modelEntry(model, contextLength) },
  }
}

export async function writeOpencodeStyleConfig(
  input: ConfigureInput,
  target: ConfigTarget,
  spec: OpencodeStyleSpec
): Promise<void> {
  const { fs, model } = input
  const path = target.file
  // The directory is created before the file is read, so a parse failure below still leaves it —
  // matching `create_dir_all` sitting above the read in the Rust writer.
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (slash > 0) await fs.mkdirp(path.slice(0, slash))

  const root = await readRoot(fs, path, true)
  await saveReplaced(fs, root, path, OPENCODE_MANAGED)

  const schema = root['$schema']
  if (!('$schema' in root) || (spec.staleSchema !== undefined && schema === spec.staleSchema)) {
    root['$schema'] = spec.schema
  }
  setAt(root, ['provider', PROVIDER_ID], opencodeProviderEntry(input))
  root['model'] = `${PROVIDER_ID}/${model}`
  await fs.write(path, canonicalJson(root))

  for (const other of target.others) await removeOurs(fs, other)
}

/** Take our entries out of a file Connect does not write; one it cannot read is left as it is. */
async function removeOurs(fs: ConfigFs, path: string): Promise<void> {
  if ((await fs.read(path)) === undefined) return
  let root: JsonObject
  try {
    root = await readRoot(fs, path, true)
  } catch {
    return
  }
  if (await restoreReplaced(fs, root, path, OPENCODE_MANAGED)) await fs.write(path, canonicalJson(root))
}
