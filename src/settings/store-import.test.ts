/**
 * `SettingsStore.importProvider` / `acknowledge` against a real file, which is where the merge meets
 * persistence: what survives a restart, what a second import does, and what a conflict leaves behind.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsStore } from './store.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function openStore(): Promise<SettingsStore> {
  const dir = await mkdtemp(join(tmpdir(), 'atomic-settings-import-'))
  dirs.push(dir)
  return SettingsStore.open(join(dir, 'settings.json'))
}

const PROVIDER = 'llamacpp-upstream' as const

describe('importProvider', () => {
  it('takes the app’s settings the first time and records what it took', async () => {
    const store = await openStore()

    const result = await store.importProvider(PROVIDER, { ctx_size: 8192, n_gpu_layers: 42 })

    expect(result.status).toBe('imported')
    expect(result.applied.sort()).toEqual(['ctx_size', 'n_gpu_layers'])
    expect(store.get(PROVIDER)['ctx_size']).toBe(8192)

    const migration = store.migration(PROVIDER)
    expect(migration?.legacy_hash).toEqual(expect.any(String))
    expect(migration?.baseline?.['ctx_size']).toBe(8192)
  })

  it('repeating the same import changes nothing and does not bump the revision', async () => {
    // The app imports on every start; the second start must be free.
    const store = await openStore()
    const first = await store.importProvider(PROVIDER, { ctx_size: 8192 })

    const again = await store.importProvider(PROVIDER, { ctx_size: 8192 })

    expect(again.status).toBe('unchanged')
    expect(again.applied).toEqual([])
    expect(again.revision).toBe(first.revision)
  })

  it('keeps a change made through the CLI when the app’s copy did not move', async () => {
    const store = await openStore()
    await store.importProvider(PROVIDER, { ctx_size: 8192 })
    await store.update(PROVIDER, { n_gpu_layers: 7 })

    const again = await store.importProvider(PROVIDER, { ctx_size: 8192 })

    expect(again.status).toBe('unchanged')
    expect(store.get(PROVIDER)['n_gpu_layers']).toBe(7)
  })

  it('merges a later app-side change without touching unrelated core changes', async () => {
    const store = await openStore()
    await store.importProvider(PROVIDER, { ctx_size: 8192, n_gpu_layers: 10 })
    await store.update(PROVIDER, { n_gpu_layers: 7 })

    const merged = await store.importProvider(PROVIDER, { ctx_size: 4096, n_gpu_layers: 10 })

    expect(merged.status).toBe('merged')
    expect(merged.applied).toEqual(['ctx_size'])
    expect(store.get(PROVIDER)['ctx_size']).toBe(4096)
    expect(store.get(PROVIDER)['n_gpu_layers']).toBe(7)
  })

  it('reports a field both sides changed and writes nothing at all', async () => {
    const store = await openStore()
    await store.importProvider(PROVIDER, { ctx_size: 8192, n_gpu_layers: 10 })
    const afterCliChange = await store.update(PROVIDER, { ctx_size: 2048 })

    const clash = await store.importProvider(PROVIDER, { ctx_size: 4096, n_gpu_layers: 99 })

    expect(clash.status).toBe('conflict')
    expect(clash.conflicts).toEqual([{ key: 'ctx_size', base: 8192, core: 2048, legacy: 4096 }])
    expect(clash.applied).toEqual([])
    expect(
      store.get(PROVIDER)['n_gpu_layers'],
      'the non-conflicting key must not land either: the scope is not migrated'
    ).toBe(10)
    expect(clash.revision).toBe(afterCliChange.revision)
  })

  it('applies the whole import once the caller settles the conflict', async () => {
    const store = await openStore()
    await store.importProvider(PROVIDER, { ctx_size: 8192, n_gpu_layers: 10 })
    await store.update(PROVIDER, { ctx_size: 2048 })

    const resolved = await store.importProvider(
      PROVIDER,
      { ctx_size: 4096, n_gpu_layers: 99 },
      { resolutions: { ctx_size: 'core' } }
    )

    expect(resolved.status).toBe('merged')
    expect(store.get(PROVIDER)['ctx_size'], 'the user kept the CLI value').toBe(2048)
    expect(store.get(PROVIDER)['n_gpu_layers']).toBe(99)
  })

  it('records the new legacy state even when the merge writes no values', async () => {
    // The app changed a setting and changed it back. Nothing to apply — but forgetting that would
    // make every later start re-merge from a stale base.
    const store = await openStore()
    await store.importProvider(PROVIDER, { ctx_size: 8192 })
    await store.update(PROVIDER, { ctx_size: 4096 })

    const second = await store.importProvider(PROVIDER, { ctx_size: 4096 })

    expect(second.status).toBe('merged')
    expect(second.applied).toEqual([])
    expect(store.migration(PROVIDER)?.baseline?.['ctx_size']).toBe(4096)
  })

  it('survives a restart: the record is on disk, not in memory', async () => {
    const store = await openStore()
    await store.importProvider(PROVIDER, { ctx_size: 8192 })

    const reopened = await SettingsStore.open(store.path)

    expect(reopened.migration(PROVIDER)?.legacy_hash).toBe(store.migration(PROVIDER)?.legacy_hash)
    expect((await reopened.importProvider(PROVIDER, { ctx_size: 8192 })).status).toBe('unchanged')
  })

  it('refuses an import that raced another writer', async () => {
    const store = await openStore()
    const stale = store.revision - 1

    await expect(
      store.importProvider(PROVIDER, { ctx_size: 8192 }, { expectedRevision: stale })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('rejects a provider that does not exist', async () => {
    const store = await openStore()

    await expect(store.importProvider('nope' as never, { ctx_size: 1 })).rejects.toMatchObject({
      code: 'PROVIDER_NOT_FOUND',
    })
  })
})

describe('acknowledge', () => {
  it('records the revision the app has mirrored, and is idempotent', async () => {
    const store = await openStore()
    const imported = await store.importProvider(PROVIDER, { ctx_size: 8192 })

    const first = await store.acknowledge(PROVIDER, imported.revision)
    expect(first.revision).toBe(imported.revision + 1)
    expect(store.migration(PROVIDER)?.acknowledged_revision).toBe(first.revision)

    const again = await store.acknowledge(PROVIDER, imported.revision)
    expect(again.revision, 'acknowledging the same revision twice is not a write').toBe(first.revision)
    expect((await store.acknowledge(PROVIDER, first.revision)).revision).toBe(first.revision)
  })

  it('rejects a snapshot that went stale while the app was mirroring it', async () => {
    const store = await openStore()
    const imported = await store.importProvider(PROVIDER, { ctx_size: 8192 })
    const changed = await store.update(PROVIDER, { ctx_size: 4096 })

    await expect(store.acknowledge(PROVIDER, imported.revision)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(store.migration(PROVIDER)?.acknowledged_revision).toBeNull()
    expect(store.revision).toBe(changed.revision)

    const acknowledged = await store.acknowledge(PROVIDER, changed.revision)
    expect(store.migration(PROVIDER)?.acknowledged_revision).toBe(acknowledged.revision)
  })

  it('does not turn an old retry into a new acknowledgement after a later edit', async () => {
    const store = await openStore()
    const imported = await store.importProvider(PROVIDER, { ctx_size: 8192 })
    const first = await store.acknowledge(PROVIDER, imported.revision)
    await store.update(PROVIDER, { ctx_size: 4096 })

    await expect(store.acknowledge(PROVIDER, imported.revision)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(store.migration(PROVIDER)?.acknowledged_revision).toBe(first.revision)
    expect(store.revision).toBe(first.revision + 1)
  })

  it('does nothing for a scope that was never imported', async () => {
    const store = await openStore()
    const before = store.revision

    const result = await store.acknowledge(PROVIDER, 5)

    expect(result.revision).toBe(before)
    expect(store.migration(PROVIDER)).toBeNull()
  })

  it('keeps the acknowledgement across a later import', async () => {
    const store = await openStore()
    const imported = await store.importProvider(PROVIDER, { ctx_size: 8192 })
    const acknowledged = await store.acknowledge(PROVIDER, imported.revision)

    await store.importProvider(PROVIDER, { ctx_size: 4096 })

    expect(store.migration(PROVIDER)?.acknowledged_revision).toBe(acknowledged.revision)
  })
})

describe('the file on disk', () => {
  it('keeps migrations under state, where a reader expects them', async () => {
    const store = await openStore()
    await store.importProvider(PROVIDER, { ctx_size: 8192 })

    const raw = JSON.parse(await readFile(store.path, 'utf8')) as {
      state: { migrations: Record<string, { legacy_hash: string }> }
    }

    expect(raw.state.migrations[PROVIDER]?.legacy_hash).toEqual(expect.any(String))
  })
})
