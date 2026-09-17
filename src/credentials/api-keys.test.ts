import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiKeyStore } from './api-keys.js'

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-api-keys-'))
  path = join(dir, 'atomic-core', 'credentials.json')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ApiKeyStore', () => {
  it('stores keys owner-readable only and reads them back in a new process', async () => {
    const store = await ApiKeyStore.open(path, { now: () => Date.UTC(2026, 0, 1) })
    await store.set('openai', 'sk-1')

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: 1,
      providers: { openai: { api_key: 'sk-1', updated_at: '2026-01-01T00:00:00.000Z' } },
    })
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await ApiKeyStore.open(path)).get('openai')).toBe('sk-1')
  })

  it('restates the mode of a leftover temporary file before it becomes the credentials', async () => {
    const store = await ApiKeyStore.open(path)
    await store.set('a', 'x')
    await writeFile(`${path}.tmp`, 'stale')
    await chmod(`${path}.tmp`, 0o644)

    await store.set('a', 'y')

    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('removes a key given as empty, null or through remove, and skips writes that change nothing', async () => {
    const store = await ApiKeyStore.open(path)
    await store.set('a', 'x')
    await store.set('b', 'y')
    const before = await stat(path)

    await store.set('a', 'x')
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs)

    await store.set('a', '')
    await store.set('b', null)
    await store.remove('never-there')
    expect([store.has('a'), store.has('b')]).toEqual([false, false])
  })

  it('binds a key to its destination and restores the exact previous record', async () => {
    const store = await ApiKeyStore.open(path, { now: () => Date.UTC(2026, 0, 1) })
    await store.set('cloud', 'original')
    const previous = store.record('cloud')
    await store.setBound('cloud', 'original', 'destination-a')
    expect(store.record('cloud')).toMatchObject({ api_key: 'original', bound_to: 'destination-a' })
    expect(store.record('cloud')?.updated_at).toBe(previous?.updated_at)
    await store.setBound('cloud', 'original', 'destination-a')
    await store.setBound('cloud', 'new-key', 'destination-b')
    await store.restore('cloud', previous)
    expect(store.record('cloud')).toEqual(previous)
    await store.restore('cloud', previous)
    await store.restore('cloud', undefined)
    expect(store.record('cloud')).toBeUndefined()
    await store.restore('cloud', undefined)
    await store.setBound('missing', null, 'destination-a')
    await store.setBound('cloud', 'key', 'destination-a')
    await store.setBound('cloud', '', 'destination-a')
    expect(store.record('cloud')).toBeUndefined()
  })

  it('refuses a credentials file it cannot parse instead of overwriting the keys in it', async () => {
    const store = await ApiKeyStore.open(path)
    await store.set('a', 'x')
    await writeFile(path, '{ broken')

    await expect(ApiKeyStore.open(path)).rejects.toMatchObject({ code: 'IO_ERROR' })
  })

  it('ignores entries that are not keys and does not treat inherited names as providers', async () => {
    await (await ApiKeyStore.open(path)).set('seed', 's')
    await writeFile(
      path,
      JSON.stringify({ providers: { ok: { api_key: 'k' }, empty: { api_key: '' }, wrong: 7, list: [] } })
    )
    const store = await ApiKeyStore.open(path)

    expect([store.get('ok'), store.get('empty'), store.get('wrong'), store.get('toString')]).toEqual([
      'k',
      undefined,
      undefined,
      undefined,
    ])
    await writeFile(path, '[]')
    expect((await ApiKeyStore.open(path)).get('ok')).toBeUndefined()
    await writeFile(path, JSON.stringify({ providers: [] }))
    expect((await ApiKeyStore.open(path)).get('ok')).toBeUndefined()
    await writeFile(path, JSON.stringify({ providers: null }))
    expect((await ApiKeyStore.open(path)).get('ok')).toBeUndefined()
  })

  it('reports a folder it cannot read or write', async () => {
    const blocker = join(dir, 'file')
    await writeFile(blocker, '')
    await expect(ApiKeyStore.open(join(blocker, 'credentials.json'))).rejects.toMatchObject({
      code: 'IO_ERROR',
    })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps the previous keys when a write fails',
    async () => {
      const store = await ApiKeyStore.open(path)
      await store.set('a', 'x')
      const folder = join(dir, 'atomic-core')
      await chmod(folder, 0o500)
      try {
        await expect(store.set('a', 'y')).rejects.toMatchObject({ code: 'IO_ERROR' })
        expect(store.get('a')).toBe('x')
      } finally {
        await chmod(folder, 0o700)
      }
    }
  )
})
