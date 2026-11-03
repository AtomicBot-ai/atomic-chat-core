/**
 * Goose — a connection writes nothing. `launch` starts `goose session` with its provider, model,
 * endpoint, key and window in that one process's environment (`childEnv` in the catalog), so nothing
 * outside it changes.
 *
 * Earlier releases saved the same variables for the whole user instead — a marked block in the shell
 * rc file, or `setx` on Windows — which pointed every OpenAI SDK tool on the machine at Atomic Chat
 * (`OPENAI_API_KEY`, `OPENAI_HOST`). Configuring takes exactly that out again, and nothing a user
 * wrote. Port of `goose_config.rs` in the app.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { ConfigureInput, ConfigureWriter } from './registry.js'
import { registerWriter } from './registry.js'

/** The line that opened and closed the block earlier releases wrote. */
export const LEGACY_SHELL_MARKER = '# Atomic Chat - Goose Config'
/** The variables that block (or `setx`) held. */
const LEGACY_VARS = ['GOOSE_PROVIDER', 'GOOSE_MODEL', 'OPENAI_HOST', 'OPENAI_BASE_PATH', 'OPENAI_API_KEY']
const LEGACY_BASE_PATH = 'v1/chat/completions'
/** The key written when the server had none. */
const KEY_PLACEHOLDER = 'atomic'
/** The rc files `shellRcFile` could have picked for the `$SHELL` of the time. */
const LEGACY_RC_FILES = ['.zshenv', '.bashrc', '.bash_profile']

function isLegacyExport(line: string): boolean {
  const rest = line.trimStart()
  if (!rest.startsWith('export ')) return false
  const eq = rest.indexOf('=')
  return eq >= 0 && LEGACY_VARS.includes(rest.slice('export '.length, eq).trim())
}

/**
 * `content` without our Goose blocks, or `undefined` when it has none. A block runs from one marker
 * line to the next; within it only the marker lines, our `export` lines and blank lines go — anything
 * else a user put there stays. A marker without a partner goes alone.
 */
export function stripLegacyGooseBlock(content: string): string | undefined {
  const lines = content.split('\n')
  const markers = lines.flatMap((line, i) => (line.startsWith(LEGACY_SHELL_MARKER) ? [i] : []))
  if (markers.length === 0) return undefined
  const inBlock = (i: number): boolean => {
    for (let p = 0; p + 1 < markers.length; p += 2) {
      if ((markers[p] as number) < i && i < (markers[p + 1] as number)) return true
    }
    return false
  }
  return lines
    .filter((line, i) => {
      if (markers.includes(i)) return false
      return !(inBlock(i) && (line.trim() === '' || isLegacyExport(line)))
    })
    .join('\n')
}

/** `localhost`, loopback, unspecified, private or link-local: a host an earlier release pointed at. */
function isLocalUrl(raw: string): boolean {
  let host: string
  try {
    host = new URL(raw.includes('://') ? raw : `http://${raw}`).hostname.toLowerCase()
  } catch {
    return false
  }
  host = host.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '::') return true
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!v4) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  return (
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  )
}

/**
 * The User-scope variables (`read` looks one up) that are recognisably what an earlier release set
 * with `setx`: Goose on the OpenAI provider with our fixed base path at a local host. The key goes
 * only when it is our placeholder or the server's own key.
 */
export function legacyGooseUserVars(read: (name: string) => string | undefined, apiKey: string): string[] {
  const ours =
    read('GOOSE_PROVIDER')?.trim() === 'openai' &&
    read('OPENAI_BASE_PATH')?.trim() === LEGACY_BASE_PATH &&
    isLocalUrl(read('OPENAI_HOST') ?? '')
  if (!ours) return []
  return LEGACY_VARS.filter((name) => {
    const value = read(name)
    if (value === undefined) return false
    if (name === 'OPENAI_API_KEY') return value === KEY_PLACEHOLDER || (apiKey !== '' && value === apiKey)
    return true
  })
}

/** `reg query HKCU\Environment /v <name>`'s value, `undefined` when there is none. */
async function readUserVar(
  spawn: NonNullable<ConfigureInput['spawn']>,
  name: string
): Promise<string | undefined> {
  const result = await spawn('reg', ['query', 'HKCU\\Environment', '/v', name]).catch(() => undefined)
  if (!result || result.code !== 0) return undefined
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^\s+(\S+)\s+REG_\w+\s+(.*)$/)
    if (match && match[1]?.toLowerCase() === name.toLowerCase()) {
      const value = (match[2] ?? '').trim()
      return value === '' ? undefined : value
    }
  }
  return undefined
}

export const configureGoose: ConfigureWriter = async (input) => {
  const { fs } = input
  for (const rc of LEGACY_RC_FILES) {
    const content = await fs.read(rc)
    if (content === undefined) continue
    const cleaned = stripLegacyGooseBlock(content)
    if (cleaned !== undefined) await fs.write(rc, cleaned)
  }
  if (input.platform !== 'win32' || !input.spawn) return
  const spawn = input.spawn
  const values = new Map<string, string>()
  for (const name of LEGACY_VARS) {
    const value = await readUserVar(spawn, name)
    if (value !== undefined) values.set(name, value)
  }
  const names = legacyGooseUserVars((name) => values.get(name), input.apiKey)
  if (names.length === 0) return
  // `SetEnvironmentVariable(…, $null, 'User')` deletes the value and broadcasts WM_SETTINGCHANGE,
  // as `setx` did when it set it. The names are our constants.
  const script = names
    .map((name) => `[Environment]::SetEnvironmentVariable('${name}', $null, 'User')`)
    .join('; ')
  const result = await spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
  if (result.code !== 0) {
    throw new AtomicCoreError(
      'IO_ERROR',
      `Could not remove the Goose variables an earlier Atomic Chat set: ${result.stderr.trim()}`
    )
  }
}

registerWriter('goose', configureGoose)
