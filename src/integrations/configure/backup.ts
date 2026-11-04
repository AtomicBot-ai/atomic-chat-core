/**
 * The backup sidecar the desktop's Disconnect reads — twin of `agent_files.rs` in the app.
 *
 * `<config file>.atomic-chat-backup.json` records what the keys a writer overwrites held before the
 * first Connect (`previous`) and what the writer put there (`written`). Disconnect restores
 * `previous` only while the file still holds `written`, so a later choice of the user's stands. A
 * `launch` from this CLI writes the same sidecar as the desktop, so either side can undo the other.
 */

import type { ConfigFs, JsonValue } from '../config-io.js'
import { canonicalJson } from '../config-io.js'
import type { JsonObject } from './json-tree.js'
import { asJsonObject } from './json-tree.js'

export function sidecarPath(path: string): string {
  return `${path}.atomic-chat-backup.json`
}

/** The sidecar of `path`, when there is one; one that does not parse only narrows what is restored. */
export async function readSidecar(fs: ConfigFs, path: string): Promise<JsonObject | undefined> {
  const text = await fs.read(sidecarPath(path))
  if (text === undefined) return undefined
  try {
    return asJsonObject(JSON.parse(text) as JsonValue)
  } catch {
    return undefined
  }
}

/** Owner-only off Windows: the previous values can include another provider's key. */
export async function writeSidecar(
  fs: ConfigFs,
  path: string,
  backup: JsonValue,
  platform: NodeJS.Platform
): Promise<void> {
  await fs.write(sidecarPath(path), canonicalJson(backup), platform === 'win32' ? {} : { mode: 0o600 })
}

/** The window to write, or `undefined` when it is not known. */
export function knownWindow(contextLength: number | undefined): number | undefined {
  return contextLength !== undefined && contextLength > 0 ? contextLength : undefined
}

/** The reply cap written beside a known window: a quarter of it, and never more than 8192. */
export function outputCap(contextLength: number): number {
  return Math.min(8192, Math.floor(contextLength / 4))
}

/** Deep equality of two JSON values, key order aside. */
export function sameJson(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]))
    )
  }
  if (typeof a !== 'object' || typeof b !== 'object') return false
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]))
  )
}
