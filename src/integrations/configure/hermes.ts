/**
 * Hermes Agent's `config.yaml` is patched LINE BY LINE rather than parsed and re-emitted.
 *
 * That is deliberate: the file is hand-edited, heavily commented, and its `custom_providers` list
 * carries the user's own bridges (Telegram, WhatsApp, …). A YAML round trip would drop every comment
 * and reflow every block for the sake of three scalars. So we rewrite only the lines we own and
 * splice our list entry in, leaving everything else byte-identical.
 *
 * Hermes ignores the API key entirely (`api_key` is accepted for call-site symmetry and reserved),
 * and `.env` is patched only when it already exists — creating one would shadow the agent's own
 * defaults.
 */

import { HERMES_CONTEXT_LENGTH } from '../catalog.js'
import type { ConfigFs } from '../config-io.js'
import type { ConfigureWriter } from './registry.js'
import { registerWriter } from './registry.js'

const PROVIDER_NAME = 'atomic-chat'
/** Hermes otherwise waits out its legacy 1800s default; a tighter cap lets a wedged turn fail fast. */
const REQUEST_TIMEOUT_SECONDS = 180

/**
 * Seeded when no config exists. The installer runs with `--skip-setup`, which skips the wizard that
 * would create one (and on Windows writes no config at all). It mirrors the `model:` block of
 * Hermes' own `cli-config.yaml.example`, which the macOS/Linux installer copies in instead.
 */
const DEFAULT_CONFIG = `model:
  default: anthropic/claude-opus-4.6
  provider: auto
  base_url: https://openrouter.ai/api/v1
custom_providers: []
`

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

/**
 * Point the top-level `model:` section at our endpoint, and touch nothing outside it.
 *
 * Hermes' chat route comes from `model.default` (`model.model` is an alias), `model.provider` and
 * `model.base_url` alone; a section it cannot read leaves it on its built-in default, an empty model
 * on provider `auto`, which falls through to OpenRouter. The same three keys recur under
 * `auxiliary:`, `delegation:`, `compression:` and others, so only direct children of the top-level
 * `model:` key are ours. A missing key is added, a scalar `model: <id>` (also valid Hermes) becomes
 * a block, and a file with no `model:` at all gets one appended.
 */
export function patchModelSection(content: string, model: string, provider: string, apiUrl: string): string {
  const out = lines(content)
  const wanted: Array<[string, string]> = [
    ['default', model],
    ['provider', provider],
    ['base_url', apiUrl],
  ]
  const block = (indent: string) => wanted.map(([key, value]) => `${indent}${key}: ${value}`)

  const headerIdx = out.findIndex((line) => topLevelYamlKey(line)?.key === 'model')
  const header = headerIdx < 0 ? undefined : topLevelYamlKey(out[headerIdx] as string)
  if (header === undefined) {
    while (out.length > 0 && (out[out.length - 1] as string).trim() === '') out.pop()
    out.push('model:', ...block('  '))
    return endWithNewline(out.join('\n'))
  }

  // The section runs to the next column-0 key; comments and blank lines inside it are kept.
  let end = out.length
  for (let i = headerIdx + 1; i < out.length; i++) {
    if (isTopLevelYamlKey(out[i] as string)) {
      end = i
      break
    }
  }
  // Anything still indented under a scalar `model: <id>` header is that scalar's continuation.
  const isScalar = header.value !== ''
  const section = out.slice(headerIdx + 1, end).filter((line) => !isScalar || isBlankOrComment(line))
  if (isScalar) {
    out.splice(headerIdx, end - headerIdx, 'model:', ...block('  '), ...section)
    return endWithNewline(out.join('\n'))
  }

  const firstChild = section.find((line) => !isBlankOrComment(line))
  const childIndent = firstChild === undefined ? '  ' : firstChild.slice(0, indentOf(firstChild))
  const missing: string[] = []
  for (const [key, value] of wanted) {
    const keyPattern = new RegExp(`^${key}\\s*:`)
    const at = section.findIndex(
      (line) =>
        !isBlankOrComment(line) && indentOf(line) === childIndent.length && keyPattern.test(line.trim())
    )
    if (at < 0) {
      missing.push(`${childIndent}${key}: ${value}`)
      continue
    }
    section[at] = replaceYamlScalarValue(section[at] as string, value)
    // A nested value (a mapping-valued `default`, a wrapped scalar) would dangle under the new one.
    for (let i = at + 1; i < section.length;) {
      const line = section[i] as string
      if (isBlankOrComment(line)) i++
      else if (indentOf(line) > childIndent.length) section.splice(i, 1)
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

/** Add or update only our entry, leaving the user's other bridges untouched and in order. */
export function upsertAtomicProvider(content: string, apiUrl: string, model: string, ctx: number): string {
  // An inline list cannot be spliced, and a second `custom_providers:` would make the whole file
  // unreadable to Hermes (duplicate key); leave it rather than append one.
  const inline = lines(content)
    .map(topLevelYamlKey)
    .find((entry) => entry?.key === 'custom_providers')?.value
  if (inline !== undefined && inline !== '' && inline.replace(/\s/g, '') !== '[]')
    return endWithNewline(content)
  const { before, entries, after } = splitCustomProviders(content)
  const kept = entries.filter((entry) => !entryIsOurs(entry))
  kept.push([
    `- name: ${PROVIDER_NAME}`,
    `  base_url: ${apiUrl}`,
    `  model: ${model}`,
    '  models:',
    `    ${model}:`,
    `      context_length: ${ctx}`,
  ])
  return rebuildCustomProviders(before, kept, after)
}

/**
 * Ensure `providers.<id>.request_timeout_seconds` exists, creating the `providers:` map and the
 * provider sub-block as needed. A value the user already set is left alone — we only fill the gap.
 */
export function upsertProviderRequestTimeout(content: string, providerId: string, seconds: number): string {
  const out = lines(content)
  const provKeyLine = `  ${providerId}:`
  const fieldLine = `    request_timeout_seconds: ${seconds}`

  const providersIdx = out.findIndex((line) => topLevelYamlKey(line)?.key === 'providers')
  const providers = providersIdx < 0 ? undefined : topLevelYamlKey(out[providersIdx] as string)

  if (providers === undefined) {
    while (out.length > 0 && (out[out.length - 1] as string).trim() === '') out.pop()
    out.push('providers:', provKeyLine, fieldLine)
    return endWithNewline(out.join('\n'))
  }

  // Hermes' YAML reader rejects a duplicate key, and then runs on its defaults: an inline map we
  // cannot edit line by line is left as it is rather than shadowed by a second `providers:`.
  if (providers.value !== '' && providers.value.replace(/\s/g, '') !== '{}')
    return endWithNewline(out.join('\n'))
  if (providers.value !== '') out[providersIdx] = 'providers:'

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
    return endWithNewline(out.join('\n'))
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
  if (!hasField) out.splice(provIdx + 1, 0, fieldLine)

  return endWithNewline(out.join('\n'))
}

/**
 * `~/.hermes` everywhere except Windows, where the installer writes `HERMES_HOME` to the user
 * environment and the CLI honours it.
 */
export function hermesDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, fs: ConfigFs): string {
  if (platform !== 'win32') return '.hermes'
  const explicit = env['HERMES_HOME']
  if (explicit && explicit !== '') return explicit
  const localAppData = env['LOCALAPPDATA']
  return localAppData && localAppData !== '' ? `${localAppData}/hermes` : fs.absolute('hermes')
}

export const configureHermes: ConfigureWriter = async ({ apiUrl, model, fs, env, platform }) => {
  const dir = hermesDir(env, platform, fs)
  const configPath = `${dir}/config.yaml`
  const envPath = `${dir}/.env`

  let content = await fs.read(configPath)
  if (content === undefined) {
    await fs.write(configPath, DEFAULT_CONFIG)
    content = DEFAULT_CONFIG
  }

  // Bare `custom` routes to `model.base_url`; Hermes trusts that URL while `model.provider` is `custom`.
  const patched = patchModelSection(content, model, 'custom', apiUrl)

  // Hermes refuses any model whose context window is below 64K, so the floor is not negotiable.
  const withProvider = upsertAtomicProvider(patched, apiUrl, model, HERMES_CONTEXT_LENGTH)
  const withTimeout = upsertProviderRequestTimeout(withProvider, 'custom', REQUEST_TIMEOUT_SECONDS)
  await fs.write(configPath, content.endsWith('\n') ? endWithNewline(withTimeout) : withTimeout)

  // Bypass a system proxy for loopback. Only ever a patch: we never create the file.
  const envContent = await fs.read(envPath)
  if (envContent !== undefined && !envContent.includes('NO_PROXY=') && !envContent.includes('no_proxy=')) {
    const separator = envContent.endsWith('\n') ? '' : '\n'
    await fs.write(
      envPath,
      `${envContent}${separator}\nNO_PROXY=localhost,127.0.0.1,0.0.0.0\nexport no_proxy=localhost,127.0.0.1,0.0.0.0`
    )
  }
}

registerWriter('hermes', configureHermes)
