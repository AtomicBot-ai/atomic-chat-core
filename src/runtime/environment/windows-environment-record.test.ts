import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  parseWindowsEnvironmentRecord,
  WindowsEnvironmentRecordStore,
  type WindowsEnvironmentRecord,
} from './windows-environment-record.js'

const RECORD: WindowsEnvironmentRecord = {
  schema_version: 1,
  executor: 'wsl-docker',
  distribution: { name: 'AtomicChat', path: 'C:\\Users\\ada\\AppData\\Local\\AtomicChat\\wsl\\AtomicChat' },
  manifest_id: 'windows-r1',
  imported_at: '2026-10-01T00:00:00.000Z',
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'windows-record-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('WindowsEnvironmentRecordStore', () => {
  it('has no record until one is written, then reads back exactly that, and forgets it on removal', async () => {
    const store = new WindowsEnvironmentRecordStore(join(dir, 'shared', 'environment.json'))
    expect(await store.read()).toBeNull()
    await store.write(RECORD)
    expect(await store.read()).toEqual(RECORD)
    await store.remove()
    expect(await store.read()).toBeNull()
  })

  it('refuses a record that does not parse rather than calling it "none"', async () => {
    const path = join(dir, 'environment.json')
    await writeFile(path, JSON.stringify({ ...RECORD, manifest_id: 'linux-r1' }))
    await expect(new WindowsEnvironmentRecordStore(path).read()).rejects.toMatchObject({
      code: 'MANAGED_METADATA_INVALID',
    })
  })
})

describe('parseWindowsEnvironmentRecord', () => {
  it.each([
    ['another executor', { ...RECORD, executor: 'linux-docker' }],
    ['no distribution name', { ...RECORD, distribution: { ...RECORD.distribution, name: '' } }],
    ['no path', { ...RECORD, distribution: { name: 'AtomicChat' } }],
    ['schema_version 2', { ...RECORD, schema_version: 2 }],
  ])('refuses %s', (_label, value) => {
    expect(() => parseWindowsEnvironmentRecord(value)).toThrow(/Invalid Windows environment record/)
  })
})
