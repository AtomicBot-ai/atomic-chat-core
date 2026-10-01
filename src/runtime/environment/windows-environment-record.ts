/**
 * The Windows environment's own record (change `add-tensorrt-llm-windows`, design D9): which WSL
 * distribution Atomic Chat imported, where its disk lives, and which environment manifest it was
 * imported by. One file, `environment.json` in the shared managed root (`ManagedSharedPaths
 * .environmentFile`), so the app's core and the CLI's core agree on one distribution per Windows user.
 *
 * Ownership is exactly this record: a distribution is "ours" only when its registered name equals the
 * one recorded here (spec "Собственный дистрибутив импортируется от имени пользователя и только
 * он"). A distribution with the same name and no record is someone else's — never used, never
 * touched. The manifest id pins the environment (spec "Окружение Windows закрепляет свой
 * манифест"): while this record exists, a newer manifest in conf changes nothing about it.
 *
 * Written atomically (temp file + rename) and only by the operation that imported the distribution;
 * removed only by the removal of the environment.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'

export interface WindowsEnvironmentRecord {
  schema_version: 1
  executor: 'wsl-docker'
  distribution: {
    /** The name it is registered under (`wsl --list`). */
    name: string
    /** The Windows directory its `ext4.vhdx` lives in. */
    path: string
  }
  /** The Windows environment manifest it was imported by. */
  manifest_id: string
  imported_at: string
  /** Written into the guest at the import (`/etc/atomic-chat/owner`): a second check that it is ours (D9). */
  marker: string
}

export interface WindowsEnvironmentRecordFs {
  readFile(path: string): Promise<string>
  writeFile(path: string, text: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  mkdir(path: string): Promise<void>
  rm(path: string): Promise<void>
}

const nodeFs: WindowsEnvironmentRecordFs = {
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, text) => writeFile(path, text, 'utf8'),
  rename,
  mkdir: async (path) => {
    await mkdir(path, { recursive: true })
  },
  rm: (path) => rm(path, { force: true }),
}

const invalid = (why: string): AtomicCoreError =>
  new AtomicCoreError('MANAGED_METADATA_INVALID', `Invalid Windows environment record: ${why}`)

/** Validate a record read back from disk; anything else is refused rather than half-trusted. */
export function parseWindowsEnvironmentRecord(input: unknown): WindowsEnvironmentRecord {
  const raw = input as Partial<WindowsEnvironmentRecord> | null
  const distribution = raw?.distribution as Partial<WindowsEnvironmentRecord['distribution']> | undefined
  if (raw === null || typeof raw !== 'object' || raw.schema_version !== 1)
    throw invalid('schema_version is not 1')
  if (raw.executor !== 'wsl-docker') throw invalid('executor is not wsl-docker')
  if (typeof distribution?.name !== 'string' || distribution.name === '')
    throw invalid('no distribution name')
  if (typeof distribution.path !== 'string' || distribution.path === '') throw invalid('no distribution path')
  if (typeof raw.manifest_id !== 'string' || !/^windows-r[0-9]+$/.test(raw.manifest_id)) {
    throw invalid('manifest_id is not a Windows manifest id')
  }
  if (typeof raw.imported_at !== 'string') throw invalid('no imported_at')
  if (typeof raw.marker !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(raw.marker)) throw invalid('no marker')
  return {
    schema_version: 1,
    executor: 'wsl-docker',
    distribution: { name: distribution.name, path: distribution.path },
    manifest_id: raw.manifest_id,
    imported_at: raw.imported_at,
    marker: raw.marker,
  }
}

export class WindowsEnvironmentRecordStore {
  private readonly path: string
  private readonly fs: WindowsEnvironmentRecordFs

  constructor(path: string, fs: WindowsEnvironmentRecordFs = nodeFs) {
    this.path = path
    this.fs = fs
  }

  /** The record, or null when there is none. A record that does not parse is an error, not "none". */
  async read(): Promise<WindowsEnvironmentRecord | null> {
    let text: string
    try {
      text = await this.fs.readFile(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    return parseWindowsEnvironmentRecord(JSON.parse(text) as unknown)
  }

  async write(record: WindowsEnvironmentRecord): Promise<void> {
    await this.fs.mkdir(dirname(this.path))
    const temp = `${this.path}.tmp`
    await this.fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`)
    await this.fs.rename(temp, this.path)
  }

  async remove(): Promise<void> {
    await this.fs.rm(this.path)
  }
}
