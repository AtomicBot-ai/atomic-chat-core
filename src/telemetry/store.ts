/**
 * `<data>/atomic-core/telemetry.json`: the core's own error-reporting state for one data folder — the
 * user's stored choice (`atomic-chat-core telemetry on|off`), the anonymous install id every report
 * carries when no host names a user, and whether the first-run notice was shown.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export interface TelemetryFile {
  /** The user's stored choice; absent until they make one. */
  enabled?: boolean
  install_id?: string
  notice_shown?: boolean
}

function parse(text: string): TelemetryFile {
  const raw = JSON.parse(text) as Record<string, unknown>
  const file: TelemetryFile = {}
  if (typeof raw['enabled'] === 'boolean') file.enabled = raw['enabled']
  if (typeof raw['install_id'] === 'string' && /^[0-9a-f-]{32,36}$/.test(raw['install_id']))
    file.install_id = raw['install_id']
  if (raw['notice_shown'] === true) file.notice_shown = true
  return file
}

/** The file as it is; a missing or unreadable one reads as empty (nothing chosen, no id yet). */
export async function readTelemetryFile(path: string): Promise<TelemetryFile> {
  try {
    return parse(await readFile(path, 'utf8'))
  } catch {
    return {}
  }
}

/** Write through a hidden sibling, so a reader never sees half of it. Best effort: never throws. */
export async function writeTelemetryFile(path: string, file: TelemetryFile): Promise<boolean> {
  const tmp = join(dirname(path), `.${basename(path)}.tmp`)
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`)
    await rename(tmp, path)
    return true
  } catch {
    await rm(tmp, { force: true }).catch(() => {})
    return false
  }
}

/** The install id, minted and stored on first use. */
export async function ensureInstallId(path: string, file: TelemetryFile): Promise<string> {
  if (file.install_id) return file.install_id
  const installId = randomUUID()
  await writeTelemetryFile(path, { ...file, install_id: installId })
  return installId
}
