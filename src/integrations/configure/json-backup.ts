/**
 * The backup Claude Code's and OpenClaude's writers keep beside each config file they edit, so the
 * desktop app's Disconnect can put the user's own values back — even after a CLI `launch` made the
 * connection.
 *
 * Twin of `src-tauri/src/core/system/claude_config.rs` in the app: same sidecar name, same format,
 * same rules. Connect records, in `<config file>.atomic-chat-backup.json`, what every key it sets
 * held before; a reconnect first undoes the previous Connect in memory, so the sidecar keeps
 * describing the user's own values, never an earlier Atomic Chat write. A value the user changed
 * after Connect is theirs and is not restored. Settings an earlier release wrote without a sidecar
 * are recognised by pointing at this server and taken out rather than recorded as the user's.
 *
 * A path is a list of segments: a string is an object key, `{ id: X }` the element of an array whose
 * `id` is X — an element that is ours by that id, removed whatever it holds now. An empty path is
 * the whole file.
 */

import { join } from 'node:path'
import { canonicalJson, parseJsonStrict } from '../config-io.js'
import type { ConfigFs, JsonValue } from '../config-io.js'
import { asJsonArray, asJsonObject } from './json-tree.js'
import type { JsonObject } from './json-tree.js'

export const BACKUP_SUFFIX = '.atomic-chat-backup.json'
const BACKUP_ABOUT = 'Atomic Chat keeps the values it replaced here and puts them back when you disconnect.'

export type PathSegment = string | { id: string }
export type JsonPath = PathSegment[]

export interface BackupEntry {
  path: JsonPath
  existed: boolean
  previous?: JsonValue
  written: JsonValue
}

export interface Backup {
  about: string
  version: 1
  fileExisted: boolean
  created: JsonPath[]
  entries: BackupEntry[]
}

/** A key Connect sets. */
export type JsonWrite = [JsonPath, JsonValue]

/** The output cap written beside a known window: a quarter of it, at most 8192. */
export function outputCap(contextLength: number): number {
  return Math.min(Math.floor(contextLength / 4), 8192)
}

/**
 * A config-directory variable the way the agents take it: absolute, or `~`-relative (expanded
 * against `home`). Anything else is ignored.
 */
export function configDirFrom(value: string | undefined, home: string): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(home, trimmed.slice(2))
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(trimmed) ? trimmed : undefined
}

// ── This server ───────────────────────────────────────────────────────────────────────────────

export interface OurServer {
  host: string
  port: number
}

function normaliseHost(host: string): string {
  const bare = host.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  return bare === '0.0.0.0' || bare === '::' || bare === '' ? '127.0.0.1' : bare
}

/** Host (lower-case, IPv6 without brackets) and port of a URL; a scheme-less `host:port` works. */
function hostAndPort(raw: string): { host: string; port: number } | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const parse = (text: string): URL | undefined => {
    try {
      const url = new URL(text)
      return url.hostname === '' ? undefined : url
    } catch {
      return undefined
    }
  }
  const url = parse(trimmed) ?? parse(`http://${trimmed}`)
  if (!url) return undefined
  const defaults: Record<string, number> = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 }
  const port = url.port === '' ? defaults[url.protocol] : Number(url.port)
  if (port === undefined) return undefined
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').toLowerCase()
  return { host, port }
}

function isLoopbackHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host === '::'
  )
}

/** The server a URL we are about to write points at. */
export function ourServerFromUrl(url: string): OurServer | undefined {
  const parsed = hostAndPort(url)
  return parsed && { host: normaliseHost(parsed.host), port: parsed.port }
}

/** `url` is this server: its exact host and port, or a loopback address with its port. */
export function isOurServerUrl(server: OurServer | undefined, url: string): boolean {
  const parsed = server && hostAndPort(url)
  return (
    parsed !== undefined &&
    server !== undefined &&
    parsed.port === server.port &&
    (parsed.host === server.host || isLoopbackHost(parsed.host))
  )
}

// ── Paths in a JSON tree ──────────────────────────────────────────────────────────────────────

const idOf = (segment: PathSegment): string | undefined =>
  typeof segment === 'object' ? segment.id : undefined

const hasId = (value: JsonValue | undefined, id: string): boolean => asJsonObject(value)?.['id'] === id

const endsInId = (path: JsonPath): boolean => path.length > 0 && idOf(path[path.length - 1]!) !== undefined

const samePath = (a: JsonPath, b: JsonPath): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Structural equality, key order ignored (the Rust side compares `serde_json::Value`s). */
export function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]))
    )
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every((k) => k in b && jsonEqual(a[k], b[k]))
  }
  return false
}

export function getAt(root: JsonValue, path: JsonPath): JsonValue | undefined {
  let node: JsonValue | undefined = root
  for (const segment of path) {
    const id = idOf(segment)
    if (id !== undefined) node = asJsonArray(node)?.find((e) => hasId(e, id))
    else {
      const object = asJsonObject(node)
      node =
        object && Object.prototype.hasOwnProperty.call(object, segment as string)
          ? object[segment as string]
          : undefined
    }
    if (node === undefined) return undefined
  }
  return node
}

/**
 * Set `value` at `path`, replacing missing containers on the way — or values of the wrong kind —
 * with empty ones and recording them in `created`.
 */
function setAt(root: JsonValue, path: JsonPath, value: JsonValue, created: JsonPath[]): void {
  let node: JsonValue = root
  for (let i = 0; i < path.length; i++) {
    const segment = path[i]!
    const id = idOf(segment)
    const last = i === path.length - 1
    let child: JsonValue | undefined
    const store = (next: JsonValue): void => {
      if (id !== undefined) {
        const items = node as JsonValue[]
        const index = items.findIndex((e) => hasId(e, id))
        if (index >= 0) items[index] = next
        else items.push(next)
      } else {
        ;(node as JsonObject)[segment as string] = next
      }
    }
    if (last) {
      store(value)
      return
    }
    child =
      id !== undefined
        ? (node as JsonValue[]).find((e) => hasId(e, id))
        : Object.prototype.hasOwnProperty.call(node, segment as string)
          ? (node as JsonObject)[segment as string]
          : undefined
    const wantsArray = idOf(path[i + 1]!) !== undefined
    const fits = wantsArray ? Array.isArray(child) : asJsonObject(child) !== undefined
    if (!fits) {
      child = wantsArray ? [] : {}
      store(child)
      const prefix = path.slice(0, i + 1)
      if (!created.some((p) => samePath(p, prefix))) created.push(prefix)
    }
    node = child as JsonValue
  }
}

function removeAt(root: JsonValue, path: JsonPath): void {
  if (path.length === 0) return
  const parent = getAt(root, path.slice(0, -1))
  const segment = path[path.length - 1]!
  const id = idOf(segment)
  if (id !== undefined) {
    const items = asJsonArray(parent)
    if (!items) return
    for (let i = items.length - 1; i >= 0; i--) if (hasId(items[i], id)) items.splice(i, 1)
  } else {
    const object = asJsonObject(parent)
    if (object) delete object[segment as string]
  }
}

/**
 * Put back what `backup` recorded wherever the value is still the one we wrote. An element that is
 * ours by its id goes whatever it holds now: the agent may have rewritten it.
 */
function restore(root: JsonValue, backup: Backup): void {
  for (const entry of [...backup.entries].reverse()) {
    const current = getAt(root, entry.path)
    if (current === undefined) continue
    const byId = endsInId(entry.path)
    if (!byId && !jsonEqual(current, entry.written)) continue
    if (entry.existed && !byId) setAt(root, entry.path, entry.previous ?? null, [])
    else removeAt(root, entry.path)
  }
}

/**
 * Apply `writes` to `root` and describe them. `carry` lists paths the previous Connect wrote that
 * this one keeps as they are when it does not write them itself. `forgetLegacy` runs only when there
 * is no backup.
 */
export function redo(
  root: JsonObject,
  previous: Backup | undefined,
  fileExisted: boolean,
  writes: JsonWrite[],
  carry: JsonPath[],
  forgetLegacy: (root: JsonObject) => void
): Backup {
  let created: JsonPath[] = []
  let existedBefore = fileExisted
  const all = [...writes]
  if (previous) {
    const kept: JsonWrite[] = []
    for (const path of carry) {
      if (writes.some(([written]) => samePath(written, path))) continue
      const entry = previous.entries.find((e) => samePath(e.path, path))
      if (entry && jsonEqual(getAt(root, entry.path), entry.written)) kept.push([entry.path, entry.written])
    }
    restore(root, previous)
    all.push(...kept)
    created = previous.created.map((p) => [...p])
    existedBefore = previous.fileExisted
  } else {
    forgetLegacy(root)
  }

  const entries: BackupEntry[] = []
  for (const [path, value] of all) {
    const before = endsInId(path) ? undefined : getAt(root, path)
    setAt(root, path, structuredClone(value), created)
    const entry: BackupEntry = { path, existed: before !== undefined, written: value }
    if (before !== undefined && before !== null) entry.previous = structuredClone(before)
    entries.push(entry)
  }
  return { about: BACKUP_ABOUT, version: 1, fileExisted: existedBefore, created, entries }
}

/** The whole-file backup of a file Connect replaces outright (OpenClaude's startup profile). */
export function wholeFileBackup(
  existed: boolean,
  previous: JsonValue | undefined,
  written: JsonValue
): Backup {
  const entry: BackupEntry = { path: [], existed, written }
  if (existed && previous !== undefined && previous !== null) entry.previous = previous
  return { about: BACKUP_ABOUT, version: 1, fileExisted: existed, created: [], entries: [entry] }
}

// ── Files ─────────────────────────────────────────────────────────────────────────────────────

export const backupPath = (config: string): string => `${config}${BACKUP_SUFFIX}`

/** The sidecar next to `config`; one that cannot be read counts as none, as on the Rust side. */
export async function readBackup(fs: ConfigFs, config: string): Promise<Backup | undefined> {
  const text = await fs.read(backupPath(config))
  if (text === undefined) return undefined
  try {
    const parsed = asJsonObject(parseJsonStrict(text, fs.absolute(backupPath(config))))
    if (!parsed || !Array.isArray(parsed['entries']) || typeof parsed['fileExisted'] !== 'boolean')
      return undefined
    return {
      about: BACKUP_ABOUT,
      version: 1,
      fileExisted: parsed['fileExisted'],
      created: (asJsonArray(parsed['created']) ?? []) as JsonPath[],
      entries: parsed['entries'] as unknown as BackupEntry[],
    }
  } catch {
    return undefined
  }
}

/**
 * Write a config the way the desktop does: through a symbolic link rather than over it, keeping an
 * existing file's permissions and giving a new one owner-only access (these files carry keys).
 */
export async function writeConfigFile(fs: ConfigFs, path: string, contents: string): Promise<void> {
  const target = await fs.linkTarget(path)
  const mode = (await fs.permissions(target)) ?? 0o600
  await fs.write(target, contents, { mode })
}

export async function writeBackup(fs: ConfigFs, config: string, backup: Backup): Promise<void> {
  await writeConfigFile(fs, backupPath(config), canonicalJson(backup))
}
