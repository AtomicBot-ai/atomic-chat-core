import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InstallationStore, type InstallationRecord } from './installations.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'installations-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const record = (
  id = 'tensorrt-llm',
  over: Partial<InstallationRecord['installation']> = {}
): InstallationRecord => ({
  schema_version: 1,
  installation: {
    installation_id: id,
    engine_id: 'tensorrt-llm',
    environment_id: 'default',
    active_descriptor_id: 'tensorrt-llm-1.2.1-r1',
    candidate_descriptor_id: null,
    availability: 'supported',
    status: 'ready',
    ...over,
  },
  image: { repository: 'nvcr.io/nvidia/tensorrt-llm/release', digest: `sha256:${'a'.repeat(64)}` },
  platform: 'linux/amd64',
  installed_at: '2026-09-29T00:00:00.000Z',
})

describe('InstallationStore', () => {
  it('writes an installation where both cores read it, and reads it back', async () => {
    const store = new InstallationStore(root)
    await store.write(record())
    expect(await store.read('tensorrt-llm')).toEqual(record())
    expect(await store.list()).toEqual([record()])
    // One folder per installation, under the shared root's installations/.
    expect(await readdir(join(root, 'installations'))).toEqual(['tensorrt-llm'])
  })

  it('replaces a record atomically and leaves no temp file behind', async () => {
    const store = new InstallationStore(root)
    await store.write(record())
    await store.write(record('tensorrt-llm', { status: 'failed' }))
    expect((await store.read('tensorrt-llm'))?.installation.status).toBe('failed')
    expect(await readdir(join(root, 'installations', 'tensorrt-llm'))).toEqual(['installation.json'])
  })

  it('answers null and an empty list when nothing is installed', async () => {
    const store = new InstallationStore(root)
    expect(await store.read('tensorrt-llm')).toBeNull()
    expect(await store.list()).toEqual([])
  })

  it('removes an installation folder and is a no-op for one that is gone', async () => {
    const store = new InstallationStore(root)
    await store.write(record())
    await store.remove('tensorrt-llm')
    await store.remove('tensorrt-llm')
    expect(await store.list()).toEqual([])
  })

  it('skips a record it cannot read rather than inventing an installation', async () => {
    const store = new InstallationStore(root)
    await mkdir(join(root, 'installations', 'broken'), { recursive: true })
    await writeFile(join(root, 'installations', 'broken', 'installation.json'), '{"schema_version":1')
    await store.write(record())
    expect((await store.list()).map((entry) => entry.installation.installation_id)).toEqual(['tensorrt-llm'])
    expect(await store.read('broken')).toBeNull()
  })

  it('never lets an id climb out of the installations folder', async () => {
    const store = new InstallationStore(root)
    await store.write(record('../escape'))
    expect(await readdir(join(root, 'installations'))).toEqual(['..%2Fescape'])
  })
})
