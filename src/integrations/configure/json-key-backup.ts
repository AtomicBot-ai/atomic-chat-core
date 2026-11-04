/**
 * Restorable edits to an agent's own JSON config — the TypeScript side of the app's
 * `core/system/json_key_backup.rs`, byte for byte.
 *
 * Connect overwrites a handful of keys in a file the user also edits (the model an agent opens on,
 * a gateway mode, an allow-list). Before writing, it records what each of those keys held — and the
 * value it put there — in a sidecar `<config>.atomic-chat-backup.json` next to the file. The app's
 * Disconnect puts a key back only while it still holds our value: a key the user changed after
 * Connect is theirs. The CLI records the same sidecar, so a connection made from the terminal is
 * undone by the app's Disconnect too.
 */

import type { ConfigFs, JsonValue } from '../config-io.js'
import { canonicalJson } from '../config-io.js'
import { asJsonObject } from './json-tree.js'

/** Appended to the config file's name to name its sidecar. */
export const BACKUP_SUFFIX = '.atomic-chat-backup.json'

/** One key Connect changed: where, what it held before (absent: it was absent) and what we wrote. */
export interface KeyBackup {
  path: string[]
  before?: JsonValue
  ours?: JsonValue
}

/** A sidecar. `seeded` is agent-specific: values Connect added that are not a key of their own. */
export interface Backup {
  keys: KeyBackup[]
  seeded: JsonValue[]
}

/** The value at `path`, when every step on the way is an object. */
export function getAt(root: JsonValue | undefined, path: string[]): JsonValue | undefined {
  let node: JsonValue | undefined = root
  for (const key of path) {
    const obj = asJsonObject(node)
    if (obj === undefined || !Object.prototype.hasOwnProperty.call(obj, key)) return undefined
    node = obj[key]
  }
  return node
}

function same(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return canonicalJson(a) === canonicalJson(b)
}

function samePath(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((part, i) => part === b[i])
}

/**
 * The backup of a Connect that turned `before` into `after`, for the keys at `paths`. A key Connect
 * left as it found it gets no entry. A key an earlier Connect already recorded keeps that earlier
 * `before` while it still held the earlier `ours` — otherwise the user changed it in between, and
 * that is what Disconnect returns to. Earlier entries for keys this Connect does not touch are
 * carried over.
 */
export function trackKeys(
  before: JsonValue,
  after: JsonValue,
  paths: string[][],
  previous: KeyBackup[]
): KeyBackup[] {
  const out: KeyBackup[] = []
  for (const path of paths) {
    const now = getAt(before, path)
    const ours = getAt(after, path)
    const earlier = previous.find((entry) => samePath(entry.path, path))
    const original = earlier !== undefined && same(earlier.ours, now) ? earlier.before : now
    if (!same(original, ours)) {
      out.push({
        path,
        ...(original !== undefined ? { before: original } : {}),
        ...(ours !== undefined ? { ours } : {}),
      })
    }
  }
  for (const entry of previous) {
    if (!paths.some((path) => samePath(path, entry.path))) out.push(entry)
  }
  return out
}

/** The sidecar's text, in the format every JSON writer here uses. */
export function renderBackup(backup: Backup): string {
  return canonicalJson({
    keys: backup.keys.map((entry) => ({
      path: entry.path,
      ...(entry.before !== undefined ? { before: entry.before } : {}),
      ...(entry.ours !== undefined ? { ours: entry.ours } : {}),
    })),
    ...(backup.seeded.length > 0 ? { seeded: backup.seeded } : {}),
  })
}

/** Parse a sidecar; `undefined` for anything that is not one. */
export function parseBackup(text: string): Backup | undefined {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return undefined
  }
  const keys = asJsonObject(root)?.['keys']
  if (!Array.isArray(keys)) return undefined
  const parsed: KeyBackup[] = []
  for (const raw of keys) {
    const entry = asJsonObject(raw)
    const path = entry?.['path']
    if (!entry || !Array.isArray(path) || !path.every((p) => typeof p === 'string')) return undefined
    parsed.push({
      path: path as string[],
      ...(entry['before'] !== undefined ? { before: entry['before'] } : {}),
      ...(entry['ours'] !== undefined ? { ours: entry['ours'] } : {}),
    })
  }
  const seeded = asJsonObject(root)?.['seeded']
  return { keys: parsed, seeded: Array.isArray(seeded) ? (seeded as JsonValue[]) : [] }
}

export async function readBackupText(fs: ConfigFs, configPath: string): Promise<string | undefined> {
  return fs.read(`${configPath}${BACKUP_SUFFIX}`)
}

export async function readBackup(fs: ConfigFs, configPath: string): Promise<Backup | undefined> {
  const text = await readBackupText(fs, configPath)
  return text === undefined ? undefined : parseBackup(text)
}

/** Write the sidecar with the config's own permissions: it holds the same values, keys included. */
export async function writeBackupText(fs: ConfigFs, configPath: string, text: string): Promise<void> {
  const mode = await fs.permissions(configPath)
  await fs.write(`${configPath}${BACKUP_SUFFIX}`, text, mode !== undefined ? { mode } : {})
}
