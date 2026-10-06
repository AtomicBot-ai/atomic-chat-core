/**
 * The shared fetch-and-cache mechanism on its own, over a toy document kind: what both real
 * providers build on (`descriptor-provider.test.ts` and `environment-manifest-provider.test.ts`
 * cover each one's messages and wiring). Only the mechanism's own answers are checked here.
 */
import { describe, expect, it, vi } from 'vitest'
import { FakeManagedFs } from '../../../test/helpers/managed-store-fs.js'
import {
  createCachedDocuments,
  meetsCoreVersion,
  type CachedDocumentKind,
  type DocumentFetch,
} from './cached-document.js'

interface Toy {
  toy_id: string
  minimum_core_version: string
}

const KIND: CachedDocumentKind<Toy> = {
  label: 'Toy document',
  urlEnv: 'ATOMIC_TOY_URL',
  parse: (input) => {
    const doc = input as Partial<Toy>
    if (typeof doc.toy_id !== 'string' || typeof doc.minimum_core_version !== 'string') {
      throw new Error('not a toy')
    }
    return { toy_id: doc.toy_id, minimum_core_version: doc.minimum_core_version }
  },
  idField: 'toy_id',
  id: (doc) => doc.toy_id,
  minimumCoreVersion: (doc) => doc.minimum_core_version,
  cacheDir: '/root/toys',
  cacheFile: (id) => `/root/toys/${id}.json`,
  latestFile: '/root/toys/latest.json',
}

const raw = (toy: Toy): string => JSON.stringify(toy)
const A: Toy = { toy_id: 'toy-a', minimum_core_version: '1.0.0' }
const B: Toy = { toy_id: 'toy-b', minimum_core_version: '1.0.0' }
const TOO_NEW: Toy = { toy_id: 'toy-z', minimum_core_version: '2.0.0' }

const documents = (fs: FakeManagedFs, fetch: DocumentFetch, onWarn = vi.fn()) =>
  createCachedDocuments(KIND, {
    env: {},
    fetch,
    readFile: () => Promise.reject(new Error('no file:// in these tests')),
    fs,
    coreVersion: '1.2.0',
    url: 'https://conf.test/toy.json',
    onWarn,
  })

const serve = (body: string): DocumentFetch => vi.fn(async () => new Response(body, { status: 200 }))
const offline: DocumentFetch = vi.fn(async () => {
  throw new Error('offline')
})

describe('createCachedDocuments', () => {
  it('fresh: caches the exact bytes under the id and points latest.json at it with the kind’s own key', async () => {
    const fs = new FakeManagedFs()
    const bytes = `${raw(A)}\n`
    expect(await documents(fs, serve(bytes)).latest()).toEqual({ kind: 'fresh', document: A })
    expect(fs.files.get('/root/toys/toy-a.json')).toBe(bytes)
    expect(JSON.parse(fs.files.get('/root/toys/latest.json') ?? 'null')).toEqual({ toy_id: 'toy-a' })
  })

  it('cached: the latest accepted document stands in when the fetch gives nothing acceptable', async () => {
    const fs = new FakeManagedFs()
    await documents(fs, serve(raw(A))).latest()
    expect(await documents(fs, offline).latest()).toEqual({ kind: 'cached', document: A })
    expect(await documents(fs, serve('{"nope":1}')).latest()).toEqual({ kind: 'cached', document: A })
    expect(await documents(fs, serve(raw(TOO_NEW))).latest()).toEqual({ kind: 'cached', document: A })
  })

  it('too-new with an empty cache names the document; none when nothing could be read at all', async () => {
    expect(await documents(new FakeManagedFs(), serve(raw(TOO_NEW))).latest()).toEqual({
      kind: 'too-new',
      id: 'toy-z',
    })
    expect(await documents(new FakeManagedFs(), offline).latest()).toEqual({ kind: 'none' })
  })

  it('cached(id) and latestCached() read the cache alone, and keep older ids after a newer accept', async () => {
    const fs = new FakeManagedFs()
    await documents(fs, serve(raw(A))).latest()
    await documents(fs, serve(raw(B))).latest()
    const network = vi.fn(offline)
    const cacheOnly = documents(fs, network)
    expect(await cacheOnly.cached('toy-a')).toEqual(A)
    expect(await cacheOnly.cached('toy-c')).toBeNull()
    expect(await cacheOnly.latestCached()).toEqual(B)
    expect(network).not.toHaveBeenCalled()
  })

  it('says in the log why it fell back and which cached document stands in, once per reason', async () => {
    const fs = new FakeManagedFs()
    await documents(fs, serve(raw(A))).latest()
    const onWarn = vi.fn()
    const offlineDocs = documents(fs, offline, onWarn)
    await offlineDocs.latest()
    await offlineDocs.latest()
    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(onWarn.mock.calls[0]?.[0]).toBe(
      'Toy document from https://conf.test/toy.json could not be read (offline); using the cached toy-a.'
    )

    const statusWarn = vi.fn()
    await documents(fs, vi.fn(async () => new Response('', { status: 404 })), statusWarn).latest()
    expect(statusWarn.mock.calls[0]?.[0]).toContain('could not be read (HTTP 404)')

    const invalidWarn = vi.fn()
    await documents(fs, serve('{"nope":1}'), invalidWarn).latest()
    expect(invalidWarn.mock.calls[0]?.[0]).toContain('is not a valid toy document (not a toy)')

    const tooNewWarn = vi.fn()
    await documents(fs, serve(raw(TOO_NEW)), tooNewWarn).latest()
    expect(tooNewWarn.mock.calls[0]?.[0]).toContain('is toy-z, which needs core 2.0.0 (this is 1.2.0)')
  })

  it('a fresh fetch from conf writes nothing to the log', async () => {
    const onWarn = vi.fn()
    await documents(new FakeManagedFs(), serve(raw(A)), onWarn).latest()
    expect(onWarn).not.toHaveBeenCalled()
  })

  it('names an override of the source once, even when it serves a valid document', async () => {
    const onWarn = vi.fn()
    const pinned = createCachedDocuments(KIND, {
      env: { ATOMIC_TOY_URL: 'https://conf.test/pinned/toy.json' },
      fetch: serve(raw(B)),
      readFile: () => Promise.reject(new Error('no file:// in these tests')),
      fs: new FakeManagedFs(),
      coreVersion: '1.2.0',
      url: 'https://conf.test/toy.json',
      onWarn,
    })
    expect(await pinned.latest()).toEqual({ kind: 'fresh', document: B })
    await pinned.latest()
    expect(onWarn.mock.calls).toEqual([
      [
        'Toy document source is overridden by ATOMIC_TOY_URL=https://conf.test/pinned/toy.json; https://conf.test/toy.json is not read.',
      ],
    ])
  })

  it('a failed cache write is reported and never fails the resolution', async () => {
    const fs = new FakeManagedFs()
    fs.rename = async () => {
      throw new Error('disk full')
    }
    const onWarn = vi.fn()
    expect(await documents(fs, serve(raw(A)), onWarn).latest()).toEqual({ kind: 'fresh', document: A })
    expect(onWarn.mock.calls[0]?.[0]).toBe('Could not cache toy document toy-a: disk full')
  })
})

describe('meetsCoreVersion', () => {
  it.each([
    ['1.2.0', '1.2.0', true],
    ['1.2.1', '1.2.0', true],
    ['1.10.0', '1.9.0', true],
    ['1.1.9', '1.2.0', false],
  ] as const)('core %s vs minimum %s -> %s', (core, minimum, expected) => {
    expect(meetsCoreVersion(minimum, core)).toBe(expected)
  })
})
