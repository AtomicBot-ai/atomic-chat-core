/**
 * Which engines are installed in the environment (task 2.6): one record per installation under the
 * shared per-user root, `installations/<installation_id>/installation.json`, written by the setup
 * operation's activation and deleted by its removal. App and CLI cores read the same files, so a
 * setup finished in one is `ready` in the other (spec "Окружение общее для app и cli…").
 *
 * The record pins the installation to its descriptor (`active_descriptor_id`, design D7) and keeps
 * the exact platform image it pulled, so a removal can delete that image even when the cached
 * descriptor is unreadable. Writes are atomic (a temp file per write, then a rename), and only one
 * operation per environment runs at a time (`OperationStore`'s busy check), so no lock is needed
 * beyond that.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { managedSharedPaths } from '../../config/index.js'
import type { PlatformImage, RuntimeInstallation } from '../../contracts/index.js'

export interface InstallationRecord {
  schema_version: 1
  installation: RuntimeInstallation
  /** The image this installation runs, pulled by digest for `platform`. */
  image: PlatformImage
  platform: 'linux/amd64' | 'linux/arm64'
  installed_at: string
}

const isRecord = (value: unknown): value is InstallationRecord => {
  const raw = value as Partial<InstallationRecord> | null
  return (
    raw !== null &&
    typeof raw === 'object' &&
    raw.schema_version === 1 &&
    typeof raw.installation?.installation_id === 'string' &&
    typeof raw.installation.engine_id === 'string' &&
    typeof raw.image?.repository === 'string' &&
    typeof raw.image.digest === 'string'
  )
}

export class InstallationStore {
  private readonly paths: ReturnType<typeof managedSharedPaths>

  constructor(root: string) {
    this.paths = managedSharedPaths(root)
  }

  async read(installationId: string): Promise<InstallationRecord | null> {
    return this.readPath(this.paths.installationFile(installationId))
  }

  /** Every readable installation. A torn or foreign file is skipped, never guessed at. */
  async list(): Promise<InstallationRecord[]> {
    const names = await readdir(this.paths.installationsDir).catch(() => [] as string[])
    const records: InstallationRecord[] = []
    for (const name of names.sort()) {
      const record = await this.readPath(join(this.paths.installationsDir, name, 'installation.json'))
      if (record !== null) records.push(record)
    }
    return records
  }

  async write(record: InstallationRecord): Promise<void> {
    const path = this.paths.installationFile(record.installation.installation_id)
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${randomUUID()}.tmp`
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, path).catch(async (error: unknown) => {
      await rm(tmp, { force: true }).catch(() => undefined)
      throw error
    })
  }

  /** Idempotent: an installation already gone is removed. */
  async remove(installationId: string): Promise<void> {
    await rm(dirname(this.paths.installationFile(installationId)), { recursive: true, force: true })
  }

  private async readPath(path: string): Promise<InstallationRecord | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }
}
