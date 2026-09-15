/**
 * The bearer token for `/atomic/v1/*` (PLAN.md §3.6). The owner mints it while holding the instance
 * lock; clients read it from `<data>/atomic-core/control-token`. File permissions are the only thing
 * guarding it, so it is created `0600` on Unix; on Windows the file inherits the user's ACL, which
 * `test/runtime-compat` checks separately.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { AtomicCoreError } from '../contracts/index.js'
import type { DataLayout } from '../config/index.js'

export const CONTROL_TOKEN_BYTES = 32
export const CONTROL_TOKEN_MODE = 0o600

export function generateControlToken(): string {
  return randomBytes(CONTROL_TOKEN_BYTES).toString('base64url')
}

/** Replace any token left by a previous owner: an old client must re-read, not keep authenticating. */
export async function writeControlToken(layout: DataLayout, token = generateControlToken()): Promise<string> {
  await mkdir(layout.core.dir, { recursive: true })
  await rm(layout.core.controlToken, { force: true }).catch(() => {})
  await writeFile(layout.core.controlToken, `${token}\n`, { mode: CONTROL_TOKEN_MODE })
  await chmod(layout.core.controlToken, CONTROL_TOKEN_MODE).catch(() => {}) // umask may have widened it
  return token
}

export async function readControlToken(layout: DataLayout): Promise<string> {
  const text = await readFile(layout.core.controlToken, 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT')
      throw new AtomicCoreError(
        'CORE_NOT_RUNNING',
        'No Atomic Chat core control token in this data folder.',
        layout.core.controlToken
      )
    throw new AtomicCoreError('IO_ERROR', 'Cannot read the core control token.', e.message)
  })
  const token = text.trim()
  if (!token)
    throw new AtomicCoreError('IO_ERROR', 'The core control token file is empty.', layout.core.controlToken)
  return token
}

/** Constant-time compare so a wrong token cannot be guessed byte by byte. */
export function controlTokenMatches(presented: string | undefined | null, expected: string): boolean {
  if (!presented) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** `Authorization: Bearer <token>`; anything else (including `X-Api-Key`) is not accepted on control. */
export function bearerToken(authorization: string | undefined | null): string | undefined {
  if (!authorization) return undefined
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  return m ? m[1]?.trim() : undefined
}

/** Unix-only check used by tests and `doctor`: is the token readable by anyone but the owner? */
export async function controlTokenIsPrivate(
  layout: DataLayout,
  platform = process.platform
): Promise<boolean> {
  if (platform === 'win32') return true
  const s = await stat(layout.core.controlToken)
  return (s.mode & 0o077) === 0
}
