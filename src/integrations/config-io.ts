/**
 * The machinery every agent-config writer shares, ported from `core/system/commands.rs`.
 *
 * Byte-for-byte compatibility with the Rust writers is the whole point (the golden fixtures in
 * `test/fixtures/app/agent-config/` compare exact file contents), so three details that look like
 * formatting are actually contract:
 *
 *  - `serde_json` is built without `preserve_order`, so every JSON file it writes has its object
 *    keys sorted alphabetically, recursively. `JSON.stringify` preserves insertion order and would
 *    diverge on any file with more than one key.
 *  - `serde_yaml` 0.9 does not indent sequence items under their key.
 *  - The managed shell-rc block has an exact shape, including where its blank lines fall.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { stringify as yamlStringify, parse as yamlParse } from 'yaml'
import { AtomicCoreError } from '../contracts/index.js'

export const ATOMIC_MANAGED_BEGIN = '# >>> Atomic Chat (managed) >>>'
export const ATOMIC_MANAGED_END = '# <<< Atomic Chat (managed) <<<'

/**
 * A filesystem rooted at the user's home directory. Writers only ever address paths relative to it,
 * which is what lets the fixtures replay against a throwaway directory.
 */
export interface ConfigFs {
  /** Absolute path of the home directory. */
  home: string
  read: (relative: string) => Promise<string | undefined>
  write: (relative: string, contents: string, options?: { mode?: number }) => Promise<void>
  mkdirp: (relative: string) => Promise<void>
  exists: (relative: string) => Promise<boolean>
  remove: (relative: string) => Promise<void>
  /** Absolute path for a relative one, for the rare writer that records its own location. */
  absolute: (relative: string) => string
}

export function nodeConfigFs(home: string): ConfigFs {
  const abs = (relative: string) => (isAbsolute(relative) ? relative : join(home, ...relative.split('/')))
  return {
    home,
    absolute: abs,
    read: (relative) =>
      readFile(abs(relative), 'utf8').then(
        (t) => t,
        () => undefined
      ),
    write: async (relative, contents, options = {}) => {
      const path = abs(relative)
      await mkdir(dirname(path), { recursive: true })
      // Write beside the target and rename over it, so a crash cannot truncate a user's config.
      const tmp = `${path}.atomic-tmp`
      await writeFile(tmp, contents, options.mode !== undefined ? { mode: options.mode } : {})
      await rename(tmp, path).catch(async (e: unknown) => {
        await rm(tmp, { force: true }).catch(() => {})
        throw e
      })
    },
    mkdirp: (relative) => mkdir(abs(relative), { recursive: true }).then(() => undefined),
    exists: (relative) =>
      stat(abs(relative)).then(
        () => true,
        () => false
      ),
    remove: (relative) => rm(abs(relative), { force: true }),
  }
}

// ── JSON ────────────────────────────────────────────────────────────────────────────────────────

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** `serde_json::to_string_pretty` + the newline every writer appends: keys sorted, 2-space indent. */
export function canonicalJson(value: unknown): string {
  return `${stringifySorted(value, 0)}\n`
}

function stringifySorted(value: unknown, depth: number): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  const pad = '  '.repeat(depth + 1)
  const closePad = '  '.repeat(depth)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map((item) => `${pad}${stringifySorted(item, depth + 1)}`)
    return `[\n${items.join(',\n')}\n${closePad}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    if (entries.length === 0) return '{}'
    // Rust's BTreeMap ordering: byte-wise, which for the keys these files use is code-unit order.
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const items = entries.map(([key, v]) => `${pad}${JSON.stringify(key)}: ${stringifySorted(v, depth + 1)}`)
    return `{\n${items.join(',\n')}\n${closePad}}`
  }
  return 'null'
}

/** Strict `serde_json`: a parse failure is fatal and nothing gets written. */
export function parseJsonStrict(text: string, path: string): JsonValue {
  const trimmed = text.trim()
  if (trimmed === '') return {}
  try {
    return JSON.parse(trimmed) as JsonValue
  } catch (e) {
    throw new AtomicCoreError('IO_ERROR', `Failed to parse ${path}`, (e as Error).message)
  }
}

/**
 * The json5 reader the Rust side uses for `.jsonc`-style files: comments and trailing commas are
 * accepted and silently dropped on write. Only the tolerances those files actually use are
 * implemented; anything else still has to be valid JSON.
 */
export function parseJsonLenient(text: string, path: string): JsonValue {
  const trimmed = text.trim()
  if (trimmed === '') return {}
  try {
    return JSON.parse(stripJsonComments(trimmed)) as JsonValue
  } catch (e) {
    throw new AtomicCoreError('IO_ERROR', `Failed to parse ${path}`, (e as Error).message)
  }
}

/** Remove `//` and block comments plus trailing commas, respecting strings and escapes. */
export function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string
    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (char === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
      continue
    }
    out += char
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

// ── YAML ────────────────────────────────────────────────────────────────────────────────────────

/** `serde_yaml` 0.9 shape: sequence items sit at their key's indent, no document marker. */
export function canonicalYaml(value: unknown): string {
  return yamlStringify(value, { indentSeq: false, lineWidth: 0, nullStr: 'null' })
}

export function parseYaml(text: string, path: string): unknown {
  try {
    return yamlParse(text) ?? {}
  } catch (e) {
    throw new AtomicCoreError('IO_ERROR', `Failed to parse ${path}`, (e as Error).message)
  }
}

// ── managed blocks ──────────────────────────────────────────────────────────────────────────────

/**
 * Remove every `# >>> Atomic Chat (managed) >>> … # <<< Atomic Chat (managed) <<<` region. Some
 * writers (Codex) keep two, so this strips all of them, and — like the Rust original — it does not
 * consume the newline after the closing marker, which is why blank-line residue is expected.
 */
export function stripAtomicManagedBlock(content: string): string {
  let result = content
  for (;;) {
    const start = result.indexOf(ATOMIC_MANAGED_BEGIN)
    const end = result.indexOf(ATOMIC_MANAGED_END)
    if (start < 0 || end < 0 || end < start) return result
    result = result.slice(0, start) + result.slice(end + ATOMIC_MANAGED_END.length)
  }
}

/** Which shell rc file the env-var agents write to, from `$SHELL` and the platform. */
export function shellRcFile(shell: string | undefined, platform: NodeJS.Platform): string {
  if (shell && shell.endsWith('/bash')) return platform === 'darwin' ? '.bash_profile' : '.bashrc'
  return '.zshenv'
}

export interface EnvEntry {
  key: string
  value: string
}

/**
 * The rc-file block the five env-configured agents write (`write_marked_env_to_shell`).
 *
 * `marker` is a single comment line that opens AND closes the region — each agent has its own
 * (`# Atomic Chat - Goose Config`), so two agents never fight over one block. A line that merely
 * *starts with* the marker toggles the region, exactly as the Rust filter does.
 *
 * Besides replacing our own block, it drops any `export <PREFIX>…` line even outside it — a safety
 * net against a stale hand-written export overriding us, which also means the user's own
 * `export GOOSE_*` lines are removed, while an unrelated `export OPENAI_API_KEY` survives because
 * Goose's prefix is `GOOSE_`. Values are single-quoted without escaping, exactly as the Rust writer
 * does, and each entry carries its own newline — which is where the blank line before the closing
 * marker comes from.
 */
export function renderMarkedEnvBlock(
  existing: string,
  marker: string,
  prefix: string,
  entries: EnvEntry[]
): string {
  const exportLine = `export ${prefix}`
  const cleaned: string[] = []
  let inBlock = false
  for (const line of existing.split('\n')) {
    if (line.startsWith(marker)) {
      inBlock = !inBlock
      continue
    }
    if (inBlock) continue
    if (line.startsWith(exportLine)) continue
    cleaned.push(line)
  }
  const body = entries.map((e) => `export ${e.key}='${e.value}'\n`).join('')
  return `${cleaned.join('\n')}${marker}\n${body}\n${marker}\n`
}

/** Write the block into the right rc file for this shell. */
export async function writeMarkedEnvToShell(
  fs: ConfigFs,
  shell: string | undefined,
  platform: NodeJS.Platform,
  marker: string,
  prefix: string,
  entries: EnvEntry[]
): Promise<void> {
  const rc = shellRcFile(shell, platform)
  const existing = (await fs.read(rc)) ?? ''
  await fs.write(rc, renderMarkedEnvBlock(existing, marker, prefix, entries))
}

// ── small shared helpers ────────────────────────────────────────────────────────────────────────

/** TOML basic string escaping: only `\` and `"`, as the Rust writer does. */
export function tomlBasicStringEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** The key an agent should use when the user configured none. Not uniform across agents. */
export function keyOr(apiKey: string, fallback: string): string {
  return apiKey && apiKey.length > 0 ? apiKey : fallback
}

/** Expand a leading `~` against the home directory, as the Rust path helpers do. */
export function expandTilde(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return resolve(home, path.slice(2))
  return path
}
