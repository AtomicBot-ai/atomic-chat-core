import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseStoredJob, RemoteJobStore } from './remote-store.js'
import type { StoredRemoteVideoJob } from './remote-store.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-remote-store-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const entry = (n: number): StoredRemoteVideoJob => ({
  jobId: n.toString(16).padStart(32, '0'),
  target: { provider: 'openrouter', model: 'google/veo-3.1-fast' },
  submission: {
    id: `up-${n}`,
    data: { polling_url: 'https://openrouter.ai/api/v1/videos/x', attempt: 1, ok: true, gone: null },
  },
  request: { prompt: 'waves', width: 0, height: 0, steps: 0, cfgScale: 0 },
  seed: 3,
  createdAtMs: 1,
  startedAtMs: 2,
})

describe('RemoteJobStore', () => {
  it('adds, replaces, lists and removes entries, surviving a new instance', async () => {
    const path = join(dir, 'sub', 'remote-jobs.json')
    const store = new RemoteJobStore(path)
    await Promise.all([store.put(entry(1)), store.put(entry(2))])
    await store.put({ ...entry(1), seed: 9 })
    const again = new RemoteJobStore(path)
    expect((await again.list()).map((j) => [j.jobId.slice(-1), j.seed])).toEqual([
      ['2', 3],
      ['1', 9],
    ])
    await again.remove(entry(2).jobId)
    await again.remove('not-there')
    expect((await again.list()).map((j) => j.submission.id)).toEqual(['up-1'])
  })

  it('reads an unreadable file as empty', async () => {
    const path = join(dir, 'remote-jobs.json')
    await writeFile(path, '{not json')
    expect(await new RemoteJobStore(path).list()).toEqual([])
  })
})

describe('parseStoredJob', () => {
  it('keeps a whole entry and refuses anything else', () => {
    expect(parseStoredJob(entry(1))).toEqual(entry(1))
    expect(parseStoredJob({ ...entry(1), jobId: '../x' })).toBeUndefined()
    expect(parseStoredJob({ ...entry(1), submission: { id: '' } })).toBeUndefined()
    expect(parseStoredJob({ ...entry(1), submission: { id: 'a', data: { nested: {} } } })).toBeUndefined()
    expect(parseStoredJob({ ...entry(1), target: { provider: 'p' } })).toBeUndefined()
    expect(parseStoredJob(null)).toBeUndefined()
  })
})
