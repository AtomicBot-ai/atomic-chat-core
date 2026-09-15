import { describe, expect, it } from 'vitest'
import { AtomicCoreError, DEFAULT_SERVER_SETTINGS } from '../contracts/index.js'
import {
  EMPTY_PROVIDER_STATE,
  SETTINGS_FILE_VERSION,
  SettingsStore,
  canonicalProviderDefaults,
  normalizeSettingsDocument,
  type SettingsChange,
  type SettingsFs,
} from './store.js'

const PATH = '/data/atomic-core/settings.json'

/** In-memory `node:fs/promises` subset with an operation log for ordering assertions. */
class FakeFs implements SettingsFs {
  readonly files = new Map<string, string>()
  readonly dirs = new Set<string>()
  readonly ops: string[] = []
  failRename = false

  private enoent(path: string) {
    return Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  }
  async readFile(path: string): Promise<string> {
    this.ops.push(`read ${path}`)
    const text = this.files.get(path)
    if (text === undefined) throw this.enoent(path)
    return text
  }
  async writeFile(path: string, data: string, options?: { mode?: number }): Promise<void> {
    this.ops.push(`write ${path} mode=${options?.mode?.toString(8) ?? '-'}`)
    this.files.set(path, data)
  }
  async rename(from: string, to: string): Promise<void> {
    this.ops.push(`rename ${from} -> ${to}`)
    if (this.failRename) throw new Error('EACCES: rename denied')
    const text = this.files.get(from)
    if (text === undefined) throw this.enoent(from)
    this.files.delete(from)
    this.files.set(to, text)
  }
  async mkdir(path: string): Promise<string | undefined> {
    this.ops.push(`mkdir ${path}`)
    this.dirs.add(path)
    return undefined
  }
  async stat(path: string): Promise<unknown> {
    this.ops.push(`stat ${path}`)
    if (!this.files.has(path)) throw this.enoent(path)
    return {}
  }
}

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0)

async function openFresh(fs = new FakeFs()) {
  const store = await SettingsStore.open(PATH, { fs, now: () => NOW })
  return { fs, store }
}

function onDisk(fs: FakeFs) {
  return JSON.parse(fs.files.get(PATH)!) as Record<string, unknown>
}

describe('SettingsStore.open', () => {
  it('creates the file with schema defaults when absent', async () => {
    const { fs, store } = await openFresh()
    expect(fs.dirs.has('/data/atomic-core')).toBe(true)
    const doc = onDisk(fs)
    expect(doc).toMatchObject({
      version: SETTINGS_FILE_VERSION,
      revision: 0,
      updated_at: '2026-09-15T12:00:00.000Z',
      server: DEFAULT_SERVER_SETTINGS,
      cloud: { providers: [] },
      state: {
        providers: {
          'llamacpp-upstream': EMPTY_PROVIDER_STATE,
          'llamacpp': EMPTY_PROVIDER_STATE,
          'mlx': EMPTY_PROVIDER_STATE,
          'foundation-models': EMPTY_PROVIDER_STATE,
        },
        migrations: {},
      },
    })
    expect(doc['providers']).toEqual({
      'llamacpp-upstream': canonicalProviderDefaults('llamacpp-upstream'),
      'llamacpp': canonicalProviderDefaults('llamacpp'),
      'mlx': canonicalProviderDefaults('mlx'),
      'foundation-models': {},
    })
    // canonical, not raw: the schema ships timeout "1800" and fit_ctx 4096
    expect(store.get('llamacpp-upstream')).toMatchObject({
      timeout: 1800,
      fit_ctx: '4096',
      fit: true,
      mtp: false,
    })
    expect(store.revision).toBe(0)
    expect(fs.files.has(`${PATH}.tmp`)).toBe(false)
  })

  it('reads an existing file without rewriting it', async () => {
    const fs = new FakeFs()
    fs.files.set(PATH, JSON.stringify({ version: 1, revision: 3, providers: { mlx: { timeout: 42 } } }))
    const { store } = await openFresh(fs)
    expect(store.revision).toBe(3)
    expect(store.get('mlx')['timeout']).toBe(42)
    expect(fs.ops.filter((op) => op.startsWith('write'))).toEqual([])
  })

  it('canonicalizes hand-edited string values on read', async () => {
    const fs = new FakeFs()
    fs.files.set(
      PATH,
      JSON.stringify({ providers: { 'llamacpp-upstream': { timeout: '900', fit: 'false' } } })
    )
    const { store } = await openFresh(fs)
    expect(store.get('llamacpp-upstream')).toMatchObject({ timeout: 900, fit: false })
  })

  it('rejects corrupt JSON, non-objects and newer versions instead of overwriting them', async () => {
    const fs = new FakeFs()
    fs.files.set(PATH, '{ not json')
    await expect(openFresh(fs)).rejects.toMatchObject({ code: 'IO_ERROR' })
    fs.files.set(PATH, '[1]')
    await expect(openFresh(fs)).rejects.toMatchObject({ code: 'IO_ERROR' })
    fs.files.set(PATH, JSON.stringify({ version: 99 }))
    await expect(openFresh(fs)).rejects.toThrow(/newer than this core supports/)
    expect(fs.files.get(PATH)).toBe(JSON.stringify({ version: 99 }))
  })

  it('surfaces stat/read failures other than ENOENT as IO_ERROR', async () => {
    const fs = new FakeFs()
    fs.stat = async () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    }
    await expect(openFresh(fs)).rejects.toMatchObject({ code: 'IO_ERROR' })
  })
})

describe('SettingsStore.update', () => {
  it('canonicalizes the patch, bumps the revision once per write and notifies per changed key', async () => {
    const { fs, store } = await openFresh()
    const seen: SettingsChange[] = []
    const off = store.onChange((c) => seen.push(c))

    const first = await store.update('llamacpp-upstream', { timeout: '900', fit: 'false', mtp: false })
    expect(first).toEqual({ revision: 1, changed: ['timeout', 'fit'] })
    expect(store.get('llamacpp-upstream')).toMatchObject({ timeout: 900, fit: false, mtp: false })
    expect(seen).toEqual([
      { scope: 'llamacpp-upstream', key: 'timeout', value: 900, revision: 1 },
      { scope: 'llamacpp-upstream', key: 'fit', value: false, revision: 1 },
    ])
    expect(onDisk(fs)).toMatchObject({
      revision: 1,
      providers: { 'llamacpp-upstream': { timeout: 900, fit: false } },
    })

    const second = await store.update('mlx', { kv_bits: '4' })
    expect(second.revision).toBe(2)
    expect(store.get('mlx')['kv_bits']).toBe(4)

    off()
    await store.update('mlx', { kv_bits: 5 })
    expect(seen).toHaveLength(3)
    expect(store.revision).toBe(3)
  })

  it('does not write or bump the revision for a no-op patch', async () => {
    const { fs, store } = await openFresh()
    const writes = () => fs.ops.filter((op) => op.startsWith('write')).length
    const before = writes()
    const result = await store.update('llamacpp', { timeout: '1800', unknown_undefined: undefined })
    expect(result).toEqual({ revision: 0, changed: [] })
    expect(writes()).toBe(before)
  })

  it('accepts a matching expectedRevision and rejects a stale one without touching the file', async () => {
    const { fs, store } = await openFresh()
    await store.update('llamacpp', { threads: 4 })
    const disk = fs.files.get(PATH)

    await expect(store.update('llamacpp', { threads: 8 }, { expectedRevision: 0 })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof AtomicCoreError &&
        e.code === 'INVALID_ARGUMENT' &&
        /expected 0, current 1/.test(e.message) &&
        e.details === PATH
    )
    expect(store.get('llamacpp')['threads']).toBe(4)
    expect(fs.files.get(PATH)).toBe(disk)

    await expect(store.update('llamacpp', { threads: 8 }, { expectedRevision: 1 })).resolves.toMatchObject({
      revision: 2,
    })
  })

  it('rejects an unknown provider', async () => {
    const { store } = await openFresh()
    await expect(store.update('nope' as never, { a: 1 })).rejects.toMatchObject({
      code: 'PROVIDER_NOT_FOUND',
    })
    expect(() => store.get('nope' as never)).toThrow(AtomicCoreError)
  })

  it('writes atomically: tmp file (0600) then rename, never the target directly', async () => {
    const { fs, store } = await openFresh()
    fs.ops.length = 0
    await store.update('llamacpp', { mlock: true })
    expect(fs.ops).toEqual([
      'mkdir /data/atomic-core',
      `write ${PATH}.tmp mode=600`,
      `rename ${PATH}.tmp -> ${PATH}`,
    ])
    expect(fs.files.has(`${PATH}.tmp`)).toBe(false)
  })

  it('rolls the in-memory document back when the rename fails', async () => {
    const { fs, store } = await openFresh()
    const disk = fs.files.get(PATH)
    fs.failRename = true
    await expect(store.update('llamacpp', { mlock: true })).rejects.toMatchObject({ code: 'IO_ERROR' })
    expect(store.revision).toBe(0)
    expect(store.get('llamacpp')['mlock']).toBe(false)
    expect(fs.files.get(PATH)).toBe(disk)
    fs.failRename = false
    await expect(store.update('llamacpp', { mlock: true })).resolves.toMatchObject({ revision: 1 })
  })

  it('serialises concurrent updates so both land with distinct revisions', async () => {
    const { store } = await openFresh()
    const [a, b] = await Promise.all([
      store.update('llamacpp', { threads: 2 }),
      store.update('llamacpp', { threads_batch: 3 }),
    ])
    expect([a.revision, b.revision].sort()).toEqual([1, 2])
    expect(store.get('llamacpp')).toMatchObject({ threads: 2, threads_batch: 3 })
  })

  it('keeps a throwing listener from breaking the write', async () => {
    const { store } = await openFresh()
    store.onChange(() => {
      throw new Error('boom')
    })
    await expect(store.update('mlx', { timeout: 1 })).resolves.toMatchObject({ revision: 1 })
  })
})

describe('server and state', () => {
  it('updateServer patches server settings under the same revision rules', async () => {
    const { fs, store } = await openFresh()
    const seen: SettingsChange[] = []
    store.onChange((c) => seen.push(c))
    await store.updateServer({ port: 1338, api_key: 'k' }, { expectedRevision: 0 })
    expect(store.server).toMatchObject({ ...DEFAULT_SERVER_SETTINGS, port: 1338, api_key: 'k' })
    expect(seen.map((c) => [c.scope, c.key, c.value])).toEqual([
      ['server', 'port', 1338],
      ['server', 'api_key', 'k'],
    ])
    expect(onDisk(fs)).toMatchObject({ revision: 1, server: { port: 1338 } })
    await expect(store.updateServer({ port: 1 }, { expectedRevision: 0 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })

  it('updateState patches one provider state and reports keys as <provider>.<key>', async () => {
    const { fs, store } = await openFresh()
    const seen: SettingsChange[] = []
    store.onChange((c) => seen.push(c))
    await store.updateState('llamacpp-upstream', { pending_backend: 'b10405/win-cuda-12-x64' })
    expect(store.state.providers['llamacpp-upstream']).toEqual({
      ...EMPTY_PROVIDER_STATE,
      pending_backend: 'b10405/win-cuda-12-x64',
    })
    expect(store.state.providers['llamacpp']).toEqual(EMPTY_PROVIDER_STATE)
    expect(seen).toEqual([
      {
        scope: 'state',
        key: 'llamacpp-upstream.pending_backend',
        value: 'b10405/win-cuda-12-x64',
        revision: 1,
      },
    ])
    expect(onDisk(fs)).toMatchObject({
      state: { providers: { 'llamacpp-upstream': { pending_backend: 'b10405/win-cuda-12-x64' } } },
    })
  })

  it('getters return copies', async () => {
    const { store } = await openFresh()
    store.server.port = 1
    store.state.providers['mlx']!.backend_type = 'x'
    store.get('mlx')['timeout'] = 1
    store.snapshot().revision = 99
    expect(store.server.port).toBe(DEFAULT_SERVER_SETTINGS.port)
    expect(store.state.providers['mlx']!.backend_type).toBeNull()
    expect(store.get('mlx')['timeout']).toBe(600)
    expect(store.revision).toBe(0)
  })
})

describe('unknown-key preservation', () => {
  const foreign = {
    version: 1,
    revision: 5,
    updated_at: '2020-01-01T00:00:00.000Z',
    experimental: { a: 1 },
    providers: { 'llamacpp': { my_custom: 'x', timeout: 7 }, 'future-provider': { z: true } },
    server: { port: 2000, tls: { cert: 'c' } },
    cloud: { providers: [{ id: 'openai' }], routing: 'auto' },
    state: {
      providers: { 'mlx': { extra: true, backend_type: 'metal' }, 'future-provider': { q: 1 } },
      migrations: {
        llamacpp: { baseline: { timeout: 1 }, legacy_hash: 'h', acknowledged_revision: 2, note: 'n' },
      },
      flags: ['f'],
    },
  }

  it('keeps foreign keys at every level through read → update → write', async () => {
    const fs = new FakeFs()
    fs.files.set(PATH, JSON.stringify(foreign))
    const { store } = await openFresh(fs)

    expect(store.revision).toBe(5)
    expect(store.get('llamacpp')).toMatchObject({
      ...canonicalProviderDefaults('llamacpp'),
      my_custom: 'x',
      timeout: 7,
    })
    expect(store.snapshot()).toMatchObject({
      experimental: { a: 1 },
      providers: { 'future-provider': { z: true } },
      server: { port: 2000, tls: { cert: 'c' } },
      cloud: { providers: [{ id: 'openai' }], routing: 'auto' },
      state: {
        providers: {
          'mlx': { ...EMPTY_PROVIDER_STATE, extra: true, backend_type: 'metal' },
          'future-provider': { q: 1 },
        },
        migrations: {
          llamacpp: { baseline: { timeout: 1 }, legacy_hash: 'h', acknowledged_revision: 2, note: 'n' },
        },
        flags: ['f'],
      },
    })

    await store.update('mlx', { timeout: 1 })
    const written = onDisk(fs)
    expect(written).toMatchObject({
      revision: 6,
      updated_at: '2026-09-15T12:00:00.000Z',
      experimental: { a: 1 },
      providers: {
        'llamacpp': { my_custom: 'x', timeout: 7 },
        'future-provider': { z: true },
        'mlx': { timeout: 1 },
      },
      server: { port: 2000, tls: { cert: 'c' }, host: DEFAULT_SERVER_SETTINGS.host },
      cloud: { providers: [{ id: 'openai' }], routing: 'auto' },
      state: {
        providers: { 'mlx': { extra: true, backend_type: 'metal' }, 'future-provider': { q: 1 } },
        migrations: { llamacpp: { note: 'n' } },
        flags: ['f'],
      },
    })
  })

  it('unknown keys inside a provider patch are stored as given', async () => {
    const { fs, store } = await openFresh()
    await store.update('llamacpp', { my_custom: '1' })
    expect(store.get('llamacpp')['my_custom']).toBe('1')
    expect(onDisk(fs)).toMatchObject({ providers: { llamacpp: { my_custom: '1' } } })
  })
})

describe('normalizeSettingsDocument', () => {
  it('repairs malformed sections instead of trusting them', () => {
    const doc = normalizeSettingsDocument(
      {
        revision: -3,
        providers: 'nope',
        server: null,
        cloud: { providers: 'x' },
        state: {
          providers: [],
          migrations: { s: { baseline: 'bad', legacy_hash: 1, acknowledged_revision: 'x' } },
        },
      },
      NOW
    )
    expect(doc.revision).toBe(0)
    expect(doc.version).toBe(SETTINGS_FILE_VERSION)
    expect(doc.updated_at).toBe('2026-09-15T12:00:00.000Z')
    expect(doc.providers['mlx']).toEqual(canonicalProviderDefaults('mlx'))
    expect(doc.server).toEqual(DEFAULT_SERVER_SETTINGS)
    expect(doc.cloud).toEqual({ providers: [] })
    expect(doc.state.providers['llamacpp']).toEqual(EMPTY_PROVIDER_STATE)
    expect(doc.state.migrations).toEqual({
      s: { baseline: null, legacy_hash: null, acknowledged_revision: null },
    })
  })
})
