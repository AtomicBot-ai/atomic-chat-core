/**
 * DeepSeek Harness (`dsh`). Twin of `configure_dsh_at` in the app's `commands.rs` and `dsh_config.rs`.
 *
 * dsh 0.2 dropped the live `$DSH_HOME/settings.yaml` (default `~/.dsh`): settings now live in the
 * active profile's `cordis.patch.yml`, a YAML list of entry overrides (`- id: llm-pi-ai` /
 * `config: …`), and a leftover `settings.yaml` is merged into that profile once and renamed
 * `settings.yaml.imported`. `dsh web`, which `launch` runs, boots the `web` profile, so the `atomic`
 * route goes under its `llm-pi-ai` row's `providers` and its `agent-default-model` row is set to it,
 * so new sessions open on the local model instead of DeepSeek's. dsh picks both up without a restart.
 *
 * The profile patch is the user's (dsh's Settings page edits it, keeping comments and `!!js`
 * expressions), so only our two rows are re-serialized; every other row, comment and blank line is
 * kept byte for byte. A file whose rows cannot be told apart that way is rewritten whole only when
 * nothing but comments would be lost, and refused when it holds `!!js` expressions. The default the
 * user had is kept in the backup sidecar for the desktop's Disconnect.
 *
 * A `settings.yaml` that is still there is read live by dsh before 0.2 and merged over the profile
 * by 0.2+, so it gets the route too (and our default, when it names one); one is never created, and
 * `settings.yaml.imported` is never touched.
 *
 * This writer refuses its input when it would do harm: dsh rejects the ENTIRE `llm-pi-ai` section
 * when one route in it is invalid, taking the user's other providers down with it. A route needs
 * `api`, `baseURL` and a non-empty `models` list, so a blank URL or model is refused before anything
 * is touched. The credential is validated for the same reason: an unquoted dotenv value ends at
 * whitespace or `#`, and a newline would inject a second assignment, so a key carrying any of those
 * is rejected — with a message that names the variable and never the value. The route is replaced
 * WHOLESALE rather than deep-merged: a merge would let a stale `apiKeyEnv` from an earlier keyed run
 * survive a keyless run and break every request with MISSING_CREDENTIAL.
 */

import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import { AtomicCoreError } from '../../contracts/index.js'
import type { ConfigFs, JsonValue } from '../config-io.js'
import {
  ATOMIC_MANAGED_BEGIN,
  ATOMIC_MANAGED_END,
  canonicalYaml,
  expandTilde,
  parseYaml,
  stripAtomicManagedBlock,
} from '../config-io.js'
import { knownWindow, outputCap, readSidecar, sameJson, writeSidecar } from './backup.js'
import type { ConfigureWriter } from './registry.js'
import { registerWriter } from './registry.js'

const SECTION = 'llm-pi-ai'
const SECTION_NAME = '@deepseek-ai/dsh-llm-pi-ai'
const DEFAULT_SECTION = 'agent-default-model'
const DEFAULT_NAME = '@deepseek-ai/dsh-agent-default-model'
const ROUTE_ID = 'atomic'
/** The route names an env var, never the secret itself. */
const KEY_ENV = 'ATOMIC_API_KEY'
/** The profile `dsh web` boots. */
const PROFILE = 'web'

type YamlMapping = Record<string, unknown>

function asMapping(value: unknown): YamlMapping | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as YamlMapping
}

/**
 * Borrow `parent[key]` as a mapping, creating it when absent. A bare `llm-pi-ai:` with nothing under
 * it parses to null, which is a hole to fill rather than data to protect. Anything else non-mapping
 * is real user content and errors out — a silent overwrite would delete config we do not own.
 */
function childMapping(parent: YamlMapping, key: string, label: string, file = 'settings.yaml'): YamlMapping {
  if (parent[key] === undefined || parent[key] === null) parent[key] = {}
  const child = asMapping(parent[key])
  if (!child) {
    throw new AtomicCoreError(
      'IO_ERROR',
      `\`${label}\` in ${file} is not a mapping. Fix or remove it and try again.`
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

function validateRoute(apiUrl: string, model: string): void {
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
}

/**
 * The `atomic` route node. Keyless omits `apiKeyEnv` rather than writing an empty one. A model the
 * pi-ai catalog does not ship falls back to a 262144 window and 32768 output tokens; a known served
 * window is declared instead, with a reply of a quarter of it (8192 at most).
 */
export function dshRouteNode(
  apiUrl: string,
  model: string,
  withKey: boolean,
  contextLength?: number
): YamlMapping {
  const window = knownWindow(contextLength)
  return {
    displayName: 'Atomic Chat',
    api: 'openai-completions',
    baseURL: apiUrl,
    ...(withKey ? { apiKeyEnv: KEY_ENV } : {}),
    models: [
      { id: model, ...(window !== undefined ? { contextWindow: window, maxTokens: outputCap(window) } : {}) },
    ],
  }
}

/**
 * Upsert our route into an already-parsed legacy `settings.yaml` tree. Pure: no I/O, no environment.
 * Everything outside `llm-pi-ai.providers.atomic` is preserved, including relative order.
 */
export function applyDshProvider(
  root: unknown,
  apiUrl: string,
  model: string,
  withKey: boolean,
  contextLength?: number
): unknown {
  validateRoute(apiUrl, model)
  // An empty, whitespace-only or comment-only document parses to null; one heal covers all three.
  const healed = root === null || root === undefined ? {} : root
  const map = asMapping(healed)
  if (!map) throw new AtomicCoreError('IO_ERROR', 'settings.yaml top level is not a YAML mapping')

  const section = childMapping(map, SECTION, SECTION)
  const providers = childMapping(section, 'providers', `${SECTION}.providers`)
  providers[ROUTE_ID] = dshRouteNode(apiUrl, model, withKey, contextLength)
  return map
}

// ── the profile patch ───────────────────────────────────────────────────────────────────────────

const JS_TAG = [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }]

function parseYamlText(text: string, path: string): unknown {
  try {
    return yamlParse(text, { customTags: JS_TAG, logLevel: 'error' })
  } catch (e) {
    throw new AtomicCoreError('IO_ERROR', `Failed to parse ${path}`, (e as Error).message)
  }
}

/** `serde_yaml` 0.9's shape: single quotes, and aliases expanded rather than re-anchored. */
function rowsYaml(rows: YamlMapping[]): string {
  return yamlStringify(rows, {
    indentSeq: false,
    lineWidth: 0,
    nullStr: 'null',
    singleQuote: true,
    aliasDuplicateObjects: false,
  })
}

/** A YAML tag such as `!!js`, which a re-serialization would drop. */
export function hasYamlTag(text: string): boolean {
  return text.split('\n').some((line) => {
    const trimmed = line.trimStart()
    return !trimmed.startsWith('#') && trimmed.split(/[\s[{,]+/).some((token) => token.startsWith('!'))
  })
}

const isRowStart = (line: string) =>
  line === '-' || line.startsWith('- ') || line.startsWith('-\n') || line.startsWith('-\r')
const isGap = (line: string) => line.trim() === '' || line.startsWith('#')

interface Row {
  /** Its own lines; `undefined` for a row this edit created. */
  text: string | undefined
  /** Comment and blank lines after it, before the next row. */
  trailer: string
  value: YamlMapping
  touched: boolean
}

interface PatchDoc {
  head: string
  rows: Row[]
  /** The text could not be split into rows; it is rewritten whole. */
  whole: boolean
}

function parsePatch(text: string, path: string): PatchDoc {
  const parsed = parseYamlText(text, path)
  if (parsed !== null && parsed !== undefined && !Array.isArray(parsed)) {
    throw new AtomicCoreError(
      'IO_ERROR',
      `${path} is not a YAML list of patches. Fix or remove it and try again.`
    )
  }
  const items = (parsed ?? []) as unknown[]
  const mappings = (): YamlMapping[] =>
    items.map((item) => {
      const mapping = asMapping(item)
      if (!mapping) {
        throw new AtomicCoreError(
          'IO_ERROR',
          `${path} has a patch that is not a mapping. Fix or remove it and try again.`
        )
      }
      return mapping
    })
  const rewriteWhole = (): PatchDoc => {
    if (hasYamlTag(text)) {
      throw new AtomicCoreError(
        'IO_ERROR',
        `${path} uses \`!!js\` expressions in a layout Atomic Chat cannot edit without losing them. ` +
          "Add the Atomic Chat provider in DeepSeek Harness's Settings → Models instead."
      )
    }
    return {
      head: '',
      rows: mappings().map((value) => ({ text: undefined, trailer: '', value, touched: true })),
      whole: true,
    }
  }

  const lines = text.split(/(?<=\n)/).filter((line) => line !== '')
  const starts = lines.flatMap((line, i) => (isRowStart(line) ? [i] : []))
  const first = starts[0] ?? lines.length
  let head = ''
  for (const line of lines.slice(0, first)) {
    const trimmed = line.trim()
    if (trimmed === '[]' && items.length === 0) continue
    if (!isGap(line) && trimmed !== '---') return rewriteWhole()
    head += line
  }
  if (starts.length !== items.length) return rewriteWhole()
  const rows: Row[] = []
  for (const [n, start] of starts.entries()) {
    const end = starts[n + 1] ?? lines.length
    let bodyEnd = end
    while (bodyEnd > start + 1 && isGap(lines[bodyEnd - 1] as string)) bodyEnd--
    const rowText = lines.slice(start, bodyEnd).join('')
    let one: unknown
    try {
      one = yamlParse(rowText, { customTags: JS_TAG, logLevel: 'error' })
    } catch {
      return rewriteWhole()
    }
    const value = Array.isArray(one) && one.length === 1 ? asMapping(one[0]) : undefined
    if (!value) return rewriteWhole()
    rows.push({ text: rowText, trailer: lines.slice(bodyEnd, end).join(''), value, touched: false })
  }
  return { head, rows, whole: false }
}

/** The last override of entry `id`, as dsh's own editor picks it: no `insert`, no other `name`. */
function findRow(doc: PatchDoc, id: string, name: string): number {
  for (let i = doc.rows.length - 1; i >= 0; i--) {
    const value = (doc.rows[i] as Row).value
    if (value['id'] === id && !('insert' in value) && (value['name'] === undefined || value['name'] === name))
      return i
  }
  return -1
}

function editRow(doc: PatchDoc, index: number, path: string): YamlMapping {
  const row = doc.rows[index] as Row
  if (row.text !== undefined && hasYamlTag(row.text)) {
    throw new AtomicCoreError(
      'IO_ERROR',
      `The \`${String(row.value['id'])}\` patch in ${path} uses \`!!js\` expressions Atomic Chat cannot keep. ` +
        "Edit it in DeepSeek Harness's Settings instead."
    )
  }
  row.touched = true
  return row.value
}

function renderPatch(doc: PatchDoc): string {
  if (doc.whole) return rowsYaml(doc.rows.map((row) => row.value))
  let out = doc.head
  for (const row of doc.rows) {
    if (out !== '' && !out.endsWith('\n')) out += '\n'
    out += row.text !== undefined && !row.touched ? row.text : rowsYaml([row.value])
    out += row.trailer
  }
  return doc.rows.length === 0 ? `${out}[]\n` : out
}

/** Write our route and select it in the profile patch; the default it replaces goes to the backup. */
async function configureProfile(
  fs: ConfigFs,
  dir: string,
  route: YamlMapping,
  model: string,
  platform: NodeJS.Platform
): Promise<void> {
  const path = `${dir}/profiles/${PROFILE}/cordis.patch.yml`
  const text = await fs.read(path)
  const doc: PatchDoc =
    text === undefined ? { head: '', rows: [], whole: false } : parsePatch(text, fs.absolute(path))

  const routes = findRow(doc, SECTION, SECTION_NAME)
  if (routes >= 0) {
    const row = editRow(doc, routes, fs.absolute(path))
    const config = childMapping(row, 'config', SECTION, 'the dsh profile')
    childMapping(config, 'providers', `${SECTION}.providers`, 'the dsh profile')[ROUTE_ID] = route
  } else {
    doc.rows.push({
      text: undefined,
      trailer: '',
      value: { id: SECTION, name: SECTION_NAME, config: { providers: { [ROUTE_ID]: route } } },
      touched: true,
    })
  }

  const ours = { provider: ROUTE_ID, model }
  const selected = findRow(doc, DEFAULT_SECTION, DEFAULT_NAME)
  const current = (selected >= 0 ? (doc.rows[selected] as Row).value['config'] : undefined) as
    JsonValue | undefined
  if (selected >= 0) editRow(doc, selected, fs.absolute(path))['config'] = ours
  else
    doc.rows.push({
      text: undefined,
      trailer: '',
      value: { id: DEFAULT_SECTION, name: DEFAULT_NAME, config: ours },
      touched: true,
    })

  // The default from before the first Connect, kept while ours is in place.
  const backup = await readSidecar(fs, path)
  const written = (backup?.['written'] as { defaultModel?: JsonValue } | undefined)?.defaultModel
  const previous =
    backup !== undefined && current !== undefined && current !== null && sameJson(written, current)
      ? ((backup['previous'] as { defaultModel?: JsonValue } | undefined)?.defaultModel ?? null)
      : (current ?? null)

  // Owner-only, as dsh writes it.
  await fs.write(path, renderPatch(doc), platform === 'win32' ? {} : { mode: 0o600 })
  await writeSidecar(
    fs,
    path,
    { previous: { defaultModel: previous }, written: { defaultModel: ours } },
    platform
  )
}

// ── .env ────────────────────────────────────────────────────────────────────────────────────────

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

export const configureDsh: ConfigureWriter = async ({
  apiUrl,
  model,
  apiKey,
  fs,
  env,
  platform,
  contextLength,
}) => {
  const dir = dshHome(env, fs.home)
  const settingsPath = `${dir}/settings.yaml`

  const trimmed = apiKey.trim()
  const key = trimmed === '' ? undefined : trimmed
  // Validate everything before writing anything, so an unusable key cannot leave a route pointing at
  // a reference we then failed to store.
  validateRoute(apiUrl, model)
  if (key !== undefined) dshValidateEnvValue(KEY_ENV, key)

  // Parse the legacy document before writing anything, so a malformed file leaves no debris.
  const text = await fs.read(settingsPath)
  let legacy: { serialized: string; previousDefault: JsonValue | undefined } | undefined
  if (text !== undefined) {
    const patched = applyDshProvider(
      parseYaml(text, fs.absolute(settingsPath)),
      apiUrl,
      model,
      key !== undefined,
      contextLength
    ) as YamlMapping
    let previousDefault: JsonValue | undefined
    // An old default would be laid over ours by a 0.2+ import, so it becomes ours too.
    const current = patched[DEFAULT_SECTION]
    if (current !== undefined) {
      if (asMapping(current)?.['provider'] !== ROUTE_ID) previousDefault = current as JsonValue
      patched[DEFAULT_SECTION] = { provider: ROUTE_ID, model }
    }
    const serialized = canonicalYaml(patched)
    legacy = { serialized: serialized.endsWith('\n') ? serialized : `${serialized}\n`, previousDefault }
  }

  await configureProfile(
    fs,
    dir,
    dshRouteNode(apiUrl, model, key !== undefined, contextLength),
    model,
    platform
  )

  if (legacy !== undefined && text !== undefined) {
    // The round trip drops comments and expands anchors, so keep one copy of whatever the user had
    // before we first touched it — once, so a later run cannot overwrite the pre-Atomic state.
    const backup = `${dir}/settings.yaml.atomic-backup`
    if (text !== '' && !(await fs.exists(backup))) await fs.write(backup, text)
    await fs.write(settingsPath, legacy.serialized)
    if (legacy.previousDefault !== undefined) {
      await writeSidecar(fs, settingsPath, { previous: { defaultModel: legacy.previousDefault } }, platform)
    }
  }

  // The secret never enters a config file. dsh resolves the reference from the inherited
  // environment, then `$DSH_HOME/.credentials.yaml`, then the invoking directory's `.env`, then this
  // file — the lowest-precedence layer, so anything the user sets deliberately still wins.
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
