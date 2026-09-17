/**
 * `<data>/atomic-chatgpt-auth.json`: the ChatGPT subscription session, shared with the app.
 *
 * Ported from: src-tauri/src/core/auth/store.rs. Contract: test/fixtures/app/chatgpt-auth (`save`,
 * `load`, `clear`, `is_expired_at` cases).
 *
 * The same file the app reads, byte-compatible: serde's pretty print with fields in declaration
 * order and `null` for an absent optional. Reading is as strict as serde's derive — a wrong type or
 * a missing required field reads as "no session", as does a version other than 1. Unknown fields
 * are ignored. The file is owner-readable only, and the mode is set when it is opened for writing so
 * a refresh token is never briefly on disk under a wider one.
 */

import { chmod, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

export const TOKEN_FILE_VERSION = 1

export interface StoredTokens {
  version: number
  access_token: string
  refresh_token: string
  id_token: string | null
  account_id: string | null
  plan_type: string | null
  email: string | null
  /** Unix seconds; absolute so a restart does not extend the token's life. */
  expires_at: number
}

export function isExpiredAt(
  tokens: Pick<StoredTokens, 'expires_at'>,
  nowUnix: number,
  marginSecs: number
): boolean {
  return tokens.expires_at - marginSecs <= nowUnix
}

const U32_MAX = 0xffffffff

function optionalString(value: unknown): string | null | false {
  if (value === undefined || value === null) return null
  return typeof value === 'string' ? value : false
}

/** serde's derive for `StoredTokens`, then the version check. */
export function parseStoredTokens(text: string): StoredTokens | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const version = o['version']
  const expires = o['expires_at']
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0 || version > U32_MAX)
    return undefined
  if (typeof o['access_token'] !== 'string' || typeof o['refresh_token'] !== 'string') return undefined
  if (typeof expires !== 'number' || !Number.isInteger(expires)) return undefined
  const id = optionalString(o['id_token'])
  const account = optionalString(o['account_id'])
  const plan = optionalString(o['plan_type'])
  const email = optionalString(o['email'])
  if (id === false || account === false || plan === false || email === false) return undefined
  if (version !== TOKEN_FILE_VERSION) return undefined
  return {
    version,
    access_token: o['access_token'],
    refresh_token: o['refresh_token'],
    id_token: id,
    account_id: account,
    plan_type: plan,
    email,
    expires_at: expires,
  }
}

/** serde_json's `to_string_pretty`: two-space indent, declaration order, no trailing newline. */
export function serializeStoredTokens(tokens: StoredTokens): string {
  return JSON.stringify(
    {
      version: tokens.version,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      id_token: tokens.id_token,
      account_id: tokens.account_id,
      plan_type: tokens.plan_type,
      email: tokens.email,
      expires_at: tokens.expires_at,
    },
    null,
    2
  )
}

export async function loadTokens(path: string): Promise<StoredTokens | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  return parseStoredTokens(text)
}

export async function saveTokens(path: string, tokens: StoredTokens): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'w', 0o600)
  try {
    await handle.writeFile(serializeStoredTokens(tokens))
  } finally {
    await handle.close()
  }
  // An existing file keeps its old mode through `open`, so restate it.
  if (process.platform !== 'win32') await chmod(path, 0o600)
}

/** Missing is success: "not connected" is the goal state. */
export async function clearTokens(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}
