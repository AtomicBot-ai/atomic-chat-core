/**
 * Hermes Agent's `config.yaml` is patched LINE BY LINE rather than parsed and re-emitted.
 *
 * That is deliberate: the file is hand-edited, heavily commented, and its `custom_providers` list
 * carries the user's own bridges (Telegram, WhatsApp, …). A YAML round trip would drop every comment
 * and reflow every block for the sake of a few scalars. So we rewrite only the lines we own and
 * splice our list entry in, leaving everything else byte-identical.
 *
 * The route is bare `custom` with `model.base_url` and `model.api_key`: Hermes trusts that URL while
 * `model.provider` is `custom` and takes the key from the same section, so the route needs nothing
 * outside it — unlike `custom:atomic-chat`, which needs our `custom_providers` entry, and that cannot
 * be added to an inline `custom_providers: [...]` list. The entry is still written where it can be,
 * for `hermes model` and detection. What the edit replaced is recorded in
 * `config.yaml.atomic-chat-backup.json` for the app's Disconnect. `.env` is patched only when it
 * already exists — creating one would shadow the agent's own defaults.
 *
 * Mirrors `configure_hermes_at` in the app's `core/system/commands.rs`, byte for byte.
 */

import { HERMES_CONTEXT_LENGTH } from '../catalog.js'
import type { ConfigFs } from '../config-io.js'
import { canonicalJson } from '../config-io.js'
import { BACKUP_SUFFIX, writeBackupText } from './json-key-backup.js'
import type { ConfigureWriter } from './registry.js'
import { registerWriter } from './registry.js'

const PROVIDER_NAME = 'atomic-chat'
/** The provider older releases wrote: our named `custom_providers` entry. */
const LEGACY_PROVIDER = `custom:${PROVIDER_NAME}`
/** Hermes otherwise waits out its legacy 1800s default; a tighter cap lets a wedged turn fail fast. */
const REQUEST_TIMEOUT_SECONDS = 180
const NO_PROXY_LINE = 'NO_PROXY=localhost,127.0.0.1,0.0.0.0'
const NO_PROXY_EXPORT_LINE = 'export no_proxy=localhost,127.0.0.1,0.0.0.0'

/** Rust's `str::lines`: split on `\n`, drop the empty tail, strip a trailing `\r` from each line. */
function lines(text: string): string[] {
  const parts = text.split('\n')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

function endWithNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

/** Rewrite everything after the first colon, with no quoting — the values here never need it. */
export function replaceYamlScalarValue(line: string, value: string): string {
  const colon = line.indexOf(':')
  return colon < 0 ? line : `${line.slice(0, colon + 1)} ${value}`
}

/** A column-0 mapping key: not indented, not a list item, not a comment, not blank. */
function isTopLevelYamlKey(line: string): boolean {
  const c = line.charAt(0)
  return c !== '' && c !== ' ' && c !== '\t' && c !== '-' && c !== '#'
}

/** Drop a trailing `# comment` (YAML only starts one after whitespace). */
function stripYamlComment(text: string): string {
  return text.replace(/(^|\s)#.*$/, '')
}

/** `key: value` of a column-0 mapping line, the value without its comment; `undefined` otherwise. */
function topLevelYamlKey(line: string): { key: string; value: string } | undefined {
  if (!isTopLevelYamlKey(line)) return undefined
  const colon = line.indexOf(':')
  if (colon < 0) return undefined
  return { key: line.slice(0, colon).trim(), value: stripYamlComment(line.slice(colon + 1)).trim() }
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function isBlankOrComment(line: string): boolean {
  const t = line.trim()
  return t === '' || t.startsWith('#')
}

/** The top-level `model:` section: its header line, its end (the next column-0 key), and whether the
 * header carries a scalar (`model: <id>`, also valid Hermes). */
interface ModelSection {
  header: number
  end: number
  isScalar: boolean
}

function modelSection(out: string[]): ModelSection | undefined {
  const header = out.findIndex((line) => topLevelYamlKey(line)?.key === 'model')
  if (header < 0) return undefined
  let end = out.length
  for (let i = header + 1; i < out.length; i++) {
    if (isTopLevelYamlKey(out[i] as string)) {
      end = i
      break
    }
  }
  return { header, end, isScalar: (topLevelYamlKey(out[header] as string)?.value ?? '') !== '' }
}

function childIndent(out: string[], section: ModelSection): string {
  const first = out.slice(section.header + 1, section.end).find((line) => !isBlankOrComment(line))
  return first === undefined ? '  ' : first.slice(0, indentOf(first))
}

function isChildKey(line: string, indent: number, key: string): boolean {
  if (isBlankOrComment(line) || indentOf(line) !== indent) return false
  const t = line.trim()
  return t.startsWith(key) && t.slice(key.length).trimStart().startsWith(':')
}

/** The lines of the direct child `key` of a block section: its own line and the more-indented lines
 * of a nested value after it (with any comments between those), as `[start, end)`. */
function childSpan(out: string[], section: ModelSection, key: string): [number, number] | undefined {
  if (section.isScalar) return undefined
  const indent = childIndent(out, section).length
  let start = -1
  for (let i = section.header + 1; i < section.end; i++) {
    if (isChildKey(out[i] as string, indent, key)) {
      start = i
      break
    }
  }
  if (start < 0) return undefined
  let end = start + 1
  for (let i = start + 1; i < section.end;) {
    const line = out[i] as string
    if (isBlankOrComment(line)) i++
    else if (indentOf(line) > indent) {
      i++
      end = i
    } else break
  }
  return [start, end]
}

/** The value text of a `key: value` line, without its comment (quotes kept). */
function scalarOf(line: string): string {
  const colon = line.indexOf(':')
  return colon < 0 ? '' : stripYamlComment(line.slice(colon + 1)).trim()
}

function modelValue(out: string[], section: ModelSection | undefined, key: string): string | undefined {
  const span = section === undefined ? undefined : childSpan(out, section, key)
  return span === undefined ? undefined : scalarOf(out[span[0]] as string)
}

/**
 * Point the top-level `model:` section at our endpoint, and touch nothing outside it.
 *
 * Hermes' chat route comes from `model.default` (`model.model` is an alias), `model.provider` and
 * `model.base_url`; a section it cannot read leaves it on its built-in default, an empty model on
 * provider `auto`, which falls through to OpenRouter. The same keys recur under `auxiliary:`,
 * `delegation:`, `compression:` and others, so only direct children of the top-level `model:` key are
 * ours. A missing key is added, a scalar `model: <id>` (also valid Hermes) becomes a block, and a file
 * with no `model:` at all gets one appended.
 */
export function patchModelSection(content: string, wanted: Array<[string, string]>): string {
  const out = lines(content)
  const block = (indent: string) => wanted.map(([key, value]) => `${indent}${key}: ${value}`)

  const found = modelSection(out)
  if (found === undefined) {
    while (out.length > 0 && (out[out.length - 1] as string).trim() === '') out.pop()
    out.push('model:', ...block('  '))
    return endWithNewline(out.join('\n'))
  }
  const { header: headerIdx, end, isScalar } = found

  // Anything still indented under a scalar `model: <id>` header is that scalar's continuation.
  const section = out.slice(headerIdx + 1, end).filter((line) => !isScalar || isBlankOrComment(line))
  if (isScalar) {
    out.splice(headerIdx, end - headerIdx, 'model:', ...block('  '), ...section)
    return endWithNewline(out.join('\n'))
  }

  const firstChild = section.find((line) => !isBlankOrComment(line))
  const indent = firstChild === undefined ? '  ' : firstChild.slice(0, indentOf(firstChild))
  const missing: string[] = []
  for (const [key, value] of wanted) {
    const at = section.findIndex((line) => isChildKey(line, indent.length, key))
    if (at < 0) {
      missing.push(`${indent}${key}: ${value}`)
      continue
    }
    section[at] = replaceYamlScalarValue(section[at] as string, value)
    // A nested value (a mapping-valued `default`, a wrapped scalar) would dangle under the new one.
    for (let i = at + 1; i < section.length;) {
      const line = section[i] as string
      if (isBlankOrComment(line)) i++
      else if (indentOf(line) > indent.length) section.splice(i, 1)
      else break
    }
  }
  out.splice(headerIdx + 1, end - headerIdx - 1, ...missing, ...section)
  return endWithNewline(out.join('\n'))
}

/**
 * Split the document into (before, entries, after) around `custom_providers:`. `entries` is one
 * array of raw lines per list item; blank lines inside the block are dropped, which is why a rerun
 * never accumulates whitespace there.
 */
export function splitCustomProviders(content: string): {
  before: string[]
  entries: string[][]
  after: string[]
} {
  const before: string[] = []
  const blockLines: string[] = []
  const after: string[] = []
  let phase: 'before' | 'inBlock' | 'after' = 'before'

  for (const line of lines(content)) {
    if (phase === 'before') {
      const t = stripYamlComment(line).trim()
      if (t === 'custom_providers:' || t === 'custom_providers: []' || t === 'custom_providers:[]') {
        phase = t.includes('[]') ? 'after' : 'inBlock'
      } else {
        before.push(line)
      }
    } else if (phase === 'inBlock') {
      // The block ends at the first line that is neither indented, a list item, nor empty.
      const first = line.charAt(0)
      if (line.length === 0 || first === ' ' || first === '\t' || first === '-') blockLines.push(line)
      else {
        phase = 'after'
        after.push(line)
      }
    } else {
      after.push(line)
    }
  }

  const entries: string[][] = []
  let current: string[] = []
  for (const line of blockLines) {
    if (line.startsWith('- ') && current.length > 0) {
      entries.push(current)
      current = []
    }
    if (line.trim() !== '') current.push(line)
  }
  if (current.length > 0) entries.push(current)

  return { before, entries, after }
}

function entryIsOurs(entry: string[]): boolean {
  return entry.some((line) => {
    const t = line.trim()
    const prefix = t.startsWith('- name:') ? '- name:' : t.startsWith('name:') ? 'name:' : undefined
    if (prefix === undefined) return false
    const value = t.slice(prefix.length).trim()
    return value === PROVIDER_NAME || value === `"${PROVIDER_NAME}"`
  })
}

/** Re-emit the block: items at column 0, or `custom_providers: []` when nothing is left. */
export function rebuildCustomProviders(before: string[], entries: string[][], after: string[]): string {
  const result = [...before]
  while (result.length > 0 && (result[result.length - 1] as string).trim() === '') result.pop()

  if (entries.length === 0) result.push('custom_providers: []')
  else {
    result.push('custom_providers:')
    for (const entry of entries) result.push(...entry)
  }
  result.push(...after)
  return endWithNewline(result.join('\n'))
}

/** Whether the top-level `custom_providers:` holds an inline list with entries. */
function hasInlineCustomProviders(content: string): boolean {
  const inline = lines(content)
    .map(topLevelYamlKey)
    .find((entry) => entry?.key === 'custom_providers')?.value
  return inline !== undefined && inline !== '' && inline.replace(/\s/g, '') !== '[]'
}

/**
 * Add or update only our entry, leaving the user's other bridges untouched and in order; also says
 * whether the `custom_providers` key itself was added. `key` is already a YAML scalar.
 */
export function upsertAtomicProvider(
  content: string,
  apiUrl: string,
  model: string,
  ctx: number,
  key: string
): [string, boolean] {
  // An inline list cannot be spliced, and a second `custom_providers:` would make the whole file
  // unreadable to Hermes (duplicate key); leave it rather than append one.
  if (hasInlineCustomProviders(content)) return [endWithNewline(content), false]
  const hadKey = lines(content).some((line) => topLevelYamlKey(line)?.key === 'custom_providers')
  const { before, entries, after } = splitCustomProviders(content)
  const kept = entries.filter((entry) => !entryIsOurs(entry))
  kept.push([
    `- name: ${PROVIDER_NAME}`,
    `  base_url: ${apiUrl}`,
    `  api_key: ${key}`,
    `  model: ${model}`,
    '  models:',
    `    ${model}:`,
    `      context_length: ${ctx}`,
  ])
  return [rebuildCustomProviders(before, kept, after), !hadKey]
}

/**
 * Ensure `providers.<id>.request_timeout_seconds` exists, creating the `providers:` map and the
 * provider sub-block as needed. A value the user already set is left alone — we only fill the gap.
 * Also returns what it created, for Disconnect: `providers`, `providers:{}` (an empty inline map
 * turned into a block), `providers.<id>` and `providers.<id>.request_timeout_seconds`.
 */
export function upsertProviderRequestTimeout(
  content: string,
  providerId: string,
  seconds: number
): [string, string[]] {
  const out = lines(content)
  const created: string[] = []
  const provKeyLine = `  ${providerId}:`
  const fieldLine = `    request_timeout_seconds: ${seconds}`
  const providerLabel = `providers.${providerId}`
  const fieldLabel = `providers.${providerId}.request_timeout_seconds`

  const providersIdx = out.findIndex((line) => topLevelYamlKey(line)?.key === 'providers')
  const providers = providersIdx < 0 ? undefined : topLevelYamlKey(out[providersIdx] as string)

  if (providers === undefined) {
    while (out.length > 0 && (out[out.length - 1] as string).trim() === '') out.pop()
    out.push('providers:', provKeyLine, fieldLine)
    created.push('providers', providerLabel, fieldLabel)
    return [endWithNewline(out.join('\n')), created]
  }

  // Hermes' YAML reader rejects a duplicate key, and then runs on its defaults: an inline map we
  // cannot edit line by line is left as it is rather than shadowed by a second `providers:`.
  if (providers.value !== '' && providers.value.replace(/\s/g, '') !== '{}')
    return [endWithNewline(out.join('\n')), created]
  if (providers.value !== '') {
    out[providersIdx] = 'providers:'
    created.push('providers:{}')
  }

  // The providers block runs until the next column-0 key.
  let blockEnd = out.length
  for (let i = providersIdx + 1; i < out.length; i++) {
    if (isTopLevelYamlKey(out[i] as string)) {
      blockEnd = i
      break
    }
  }

  let provIdx = -1
  for (let i = providersIdx + 1; i < blockEnd; i++) {
    if ((out[i] as string).replace(/\s+$/, '') === provKeyLine) {
      provIdx = i
      break
    }
  }

  if (provIdx < 0) {
    out.splice(providersIdx + 1, 0, provKeyLine, fieldLine)
    created.push(providerLabel, fieldLabel)
    return [endWithNewline(out.join('\n')), created]
  }

  // This provider's sub-block runs until the next key at indent <= 2 (a sibling provider).
  let subEnd = blockEnd
  for (let i = provIdx + 1; i < blockEnd; i++) {
    const line = out[i] as string
    if (line.trim() === '') continue
    if (line.length - line.trimStart().length <= 2) {
      subEnd = i
      break
    }
  }
  const hasField = out
    .slice(provIdx + 1, subEnd)
    .some((line) => line.trimStart().startsWith('request_timeout_seconds:'))
  if (!hasField) {
    out.splice(provIdx + 1, 0, fieldLine)
    created.push(fieldLabel)
  }

  return [endWithNewline(out.join('\n')), created]
}

// ── the backup Disconnect restores from ─────────────────────────────────────────────────────────

/** One `model:` key Connect wrote: the lines it replaced (absent: none) and the value it wrote. */
interface KeyBackup {
  before?: string[]
  ours: string
}

/** What Connect changed in `config.yaml` (the app's `HermesBackup`). */
export interface HermesBackup {
  /** The `model:` line before Connect; absent when there was no section. */
  header?: string
  keys: Record<string, KeyBackup>
  /** What Connect added that was not there at all (see `upsertProviderRequestTimeout`). */
  created: string[]
}

/** `value` without one pair of surrounding quotes. */
function unquote(value: string): string {
  for (const quote of ['"', "'"]) {
    if (value.length >= 2 && value.startsWith(quote) && value.endsWith(quote)) return value.slice(1, -1)
  }
  return value
}

/** Whether `current` is the value Connect wrote; Hermes may persist bare `custom` under our name. */
function valueIsOurs(key: string, current: string, ours: string): boolean {
  const value = unquote(current)
  return value === unquote(ours) || (key === 'provider' && ours === 'custom' && value === LEGACY_PROVIDER)
}

export function parseHermesBackup(text: string): HermesBackup | undefined {
  try {
    const root = JSON.parse(text) as {
      created?: unknown
      model?: { header?: unknown; keys?: Record<string, { before?: unknown; ours?: unknown }> }
    }
    const created = root.created
    const keys = root.model?.keys
    if (!Array.isArray(created) || !created.every((c) => typeof c === 'string')) return undefined
    if (typeof keys !== 'object' || keys === null) return undefined
    const parsed: Record<string, KeyBackup> = {}
    for (const [key, entry] of Object.entries(keys)) {
      if (typeof entry?.ours !== 'string') return undefined
      const before = entry.before
      if (before !== undefined && !(Array.isArray(before) && before.every((l) => typeof l === 'string')))
        return undefined
      parsed[key] = { ours: entry.ours, ...(before !== undefined ? { before: before as string[] } : {}) }
    }
    const header = root.model?.header
    return { ...(typeof header === 'string' ? { header } : {}), keys: parsed, created: created as string[] }
  } catch {
    return undefined
  }
}

export function renderHermesBackup(backup: HermesBackup): string {
  return canonicalJson({
    created: [...new Set(backup.created)].sort(),
    model: { ...(backup.header !== undefined ? { header: backup.header } : {}), keys: backup.keys },
  })
}

/**
 * The backup of a Connect that wrote `route` over `content`. A key an earlier Connect recorded keeps
 * that record's original while it still holds the value that Connect wrote; otherwise the user
 * changed it since, and the current lines are the ones to return to.
 */
export function hermesBackup(
  content: string,
  route: Array<[string, string]>,
  previous: HermesBackup | undefined,
  created: string[]
): HermesBackup {
  const out = lines(content)
  const section = modelSection(out)
  const stillOurs = (prev: HermesBackup) =>
    Object.entries(prev.keys).every(([key, entry]) => {
      const value = modelValue(out, section, key)
      return value !== undefined && valueIsOurs(key, value, entry.ours)
    })
  const header =
    previous !== undefined && stillOurs(previous)
      ? previous.header
      : section === undefined
        ? undefined
        : out[section.header]
  const keys: Record<string, KeyBackup> = {}
  for (const [key, ours] of route) {
    const earlier = previous?.keys[key]
    const current = modelValue(out, section, key)
    let before: string[] | undefined
    if (earlier !== undefined && current !== undefined && valueIsOurs(key, current, earlier.ours)) {
      before = earlier.before
    } else {
      const span = section === undefined ? undefined : childSpan(out, section, key)
      before =
        span === undefined ? undefined : out.slice(span[0], span[1]).filter((l) => !isBlankOrComment(l))
    }
    keys[key] = { ours, ...(before !== undefined ? { before } : {}) }
  }
  return {
    ...(header !== undefined ? { header } : {}),
    keys,
    created: [...new Set([...(previous?.created ?? []), ...created])].sort(),
  }
}

// ── where Hermes reads its config ───────────────────────────────────────────────────────────────

/**
 * `HERMES_HOME` as Hermes reads it (`os.path.expanduser(os.path.expandvars(...))`): `$NAME`,
 * `${NAME}` and `%NAME%` take the variable's value (an unset one stays as written), then a leading
 * `~` is the user's home.
 */
export function expandHermesHome(raw: string, env: NodeJS.ProcessEnv, home: string): string {
  const value = (name: string) => {
    const v = env[name]
    return v !== undefined && v.trim() !== '' ? v : undefined
  }
  const expanded = raw.replace(
    /\$\{([^}]*)\}|\$([A-Za-z0-9_]+)|%([^%]+)%/g,
    (match, braced?: string, bare?: string, percent?: string) =>
      value((braced ?? bare ?? percent) as string) ?? match
  )
  if (expanded === '~') return home
  if (expanded.startsWith('~/') || expanded.startsWith('~\\')) return `${home}${expanded.slice(1)}`
  return expanded
}

const parentName = (path: string) =>
  path
    .split(/[\\/]+/)
    .filter(Boolean)
    .slice(-2, -1)[0]

/**
 * The directory whose `config.yaml` the `hermes` CLI reads (`resolve_hermes_dir` in the app):
 * `HERMES_HOME` (expanded) or the platform default (`%LOCALAPPDATA%/hermes` on Windows, `~/.hermes`
 * elsewhere) is the root; a `HERMES_HOME` naming a profile (`<root>/profiles/<name>`) is used as it
 * is; otherwise the sticky profile `hermes profile use <name>` leaves in `<root>/active_profile` is
 * what every `hermes` without `-p` runs, from `<root>/profiles/<name>`.
 */
export async function hermesDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  fs: ConfigFs
): Promise<string> {
  const localAppData = env['LOCALAPPDATA']
  const native =
    platform === 'win32'
      ? `${localAppData && localAppData.trim() !== '' ? localAppData : `${fs.home}/AppData/Local`}/hermes`
      : '.hermes'
  const raw = env['HERMES_HOME']?.trim()
  const envHome = raw ? expandHermesHome(raw, env, fs.home) : undefined
  if (envHome !== undefined && parentName(envHome) === 'profiles') return envHome
  // The root holding `active_profile`: the platform default for anything under it, else
  // `HERMES_HOME` itself (Docker and custom roots).
  const nativeAbs = fs.absolute(native).replace(/[\\/]+$/, '')
  const under =
    envHome !== undefined &&
    (fs.absolute(envHome) === nativeAbs ||
      fs.absolute(envHome).startsWith(`${nativeAbs}/`) ||
      fs.absolute(envHome).startsWith(`${nativeAbs}\\`))
  const root = envHome !== undefined && !under ? envHome : native
  const base = envHome ?? native
  const active = ((await fs.read(`${root}/active_profile`)) ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
  if (active !== '' && active !== 'default') {
    const profile = `${base}/profiles/${active}`
    if (await fs.exists(profile)) return profile
  }
  return base
}

export const configureHermes: ConfigureWriter = async ({
  apiUrl,
  model,
  apiKey,
  fs,
  env,
  platform,
  contextLength,
}) => {
  const dir = await hermesDir(env, platform, fs)
  const configPath = `${dir}/config.yaml`
  const envPath = `${dir}/.env`

  // The installer runs with `--skip-setup`, so a fresh install may have no config at all; Hermes
  // fills every key we do not write with its own defaults.
  const content = (await fs.read(configPath)) ?? ''
  const previousText = await fs.read(`${configPath}${BACKUP_SUFFIX}`)
  const previous = previousText === undefined ? undefined : parseHermesBackup(previousText)

  // Hermes refuses any model whose window is below 64K, so an unknown window is written as that floor;
  // a known one is written as served.
  const ctx = contextLength ?? HERMES_CONTEXT_LENGTH
  const key = JSON.stringify(apiKey === '' ? 'atomic' : apiKey)
  const route: Array<[string, string]> = [
    ['default', model],
    ['provider', 'custom'],
    ['base_url', apiUrl],
    ['api_key', key],
    ['context_length', String(ctx)],
  ]

  const patched = patchModelSection(content, route)
  const [withProvider, addedList] = upsertAtomicProvider(patched, apiUrl, model, ctx, key)
  const [withTimeout, created] = upsertProviderRequestTimeout(withProvider, 'custom', REQUEST_TIMEOUT_SECONDS)
  if (addedList) created.push('custom_providers')

  // Bypass a system proxy for loopback. Only ever a patch: we never create the file.
  const envContent = await fs.read(envPath)
  if (envContent !== undefined && !envContent.includes('NO_PROXY=') && !envContent.includes('no_proxy=')) {
    const separator = envContent.endsWith('\n') ? '' : '\n'
    await fs.write(envPath, `${envContent}${separator}\n${NO_PROXY_LINE}\n${NO_PROXY_EXPORT_LINE}`)
    created.push('env.no_proxy')
  }

  const backup = hermesBackup(content, route, previous, created)
  await fs.write(configPath, withTimeout)
  await writeBackupText(fs, configPath, renderHermesBackup(backup))
}

registerWriter('hermes', configureHermes)
