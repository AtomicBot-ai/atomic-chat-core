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
 * would create one, so on a fresh install there was nothing to patch at all. This carries exactly
 * the anchors the patch logic below looks for.
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
      const t = line.trim()
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

/** A column-0 mapping key: not indented, not a list item, not a comment, not blank. */
function isTopLevelYamlKey(line: string): boolean {
  const c = line.charAt(0)
  return c !== '' && c !== ' ' && c !== '\t' && c !== '-' && c !== '#'
}

/**
 * Ensure `providers.<id>.request_timeout_seconds` exists, creating the `providers:` map and the
 * provider sub-block as needed. A value the user already set is left alone — we only fill the gap.
 */
export function upsertProviderRequestTimeout(content: string, providerId: string, seconds: number): string {
  const out = lines(content)
  const provKeyLine = `  ${providerId}:`
  const fieldLine = `    request_timeout_seconds: ${seconds}`

  const providersIdx = out.findIndex((line) => {
    const t = line.replace(/\s+$/, '')
    return isTopLevelYamlKey(line) && (t === 'providers:' || t === 'providers: {}' || t === 'providers:{}')
  })

  if (providersIdx < 0) {
    while (out.length > 0 && (out[out.length - 1] as string).trim() === '') out.pop()
    out.push('providers:', provKeyLine, fieldLine)
    return endWithNewline(out.join('\n'))
  }

  if ((out[providersIdx] as string).replace(/\s+$/, '') !== 'providers:') out[providersIdx] = 'providers:'

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

  // Only the FIRST occurrence of each key is ours: a later `default:` belongs to some other block.
  let didDefault = false
  let didProvider = false
  let didBaseUrl = false
  const patched = lines(content).map((line) => {
    const t = line.trim()
    if (!didDefault && t.startsWith('default:')) {
      didDefault = true
      return replaceYamlScalarValue(line, model)
    }
    if (!didProvider && t.startsWith('provider:')) {
      didProvider = true
      return replaceYamlScalarValue(line, 'custom')
    }
    if (!didBaseUrl && t.startsWith('base_url:')) {
      didBaseUrl = true
      return replaceYamlScalarValue(line, apiUrl)
    }
    return line
  })

  // Hermes refuses any model whose context window is below 64K, so the floor is not negotiable.
  const withProvider = upsertAtomicProvider(patched.join('\n'), apiUrl, model, HERMES_CONTEXT_LENGTH)
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
