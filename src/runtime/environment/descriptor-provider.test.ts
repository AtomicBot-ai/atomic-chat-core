import { describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { RuntimeDescriptor } from '../../contracts/index.js'
import { managedSharedPaths } from '../../config/index.js'
import { FakeManagedFs } from '../../../test/helpers/managed-store-fs.js'
import { readRuntimeFixture } from '../../../test/helpers/runtime-fixtures.js'
import {
  createRuntimeDescriptorProvider,
  descriptorMeetsCoreVersion,
  DEFAULT_TENSORRT_LLM_DESCRIPTOR_URL,
  RUNTIME_DESCRIPTOR_URL_ENV,
} from './descriptor-provider.js'
import { parseRuntimeDescriptor } from './descriptor.js'
import type { DescriptorFetch } from './descriptor-provider.js'

const ROOT = '/shared'
const PATHS = managedSharedPaths(ROOT)
const CORE_VERSION = '0.7.0'

/** The real fixture, verbatim: `descriptor_id` `tensorrt-llm-1.2.1-r1`, `minimum_core_version` `0.7.0`. */
const FIXTURE_A = readRuntimeFixture('tensorrt-llm.json') as Record<string, unknown>
const RAW_A = JSON.stringify(FIXTURE_A)
const DESCRIPTOR_A = parseRuntimeDescriptor(FIXTURE_A)

/** A different published release: same shape, a new id, the conf rule for a real update. */
const rawWith = (mutate: (doc: Record<string, unknown>) => void): string => {
  const doc = JSON.parse(JSON.stringify(FIXTURE_A)) as Record<string, unknown>
  mutate(doc)
  return JSON.stringify(doc)
}
const RAW_B = rawWith((doc) => (doc['descriptor_id'] = 'tensorrt-llm-1.3.0-r1'))
const DESCRIPTOR_B = parseRuntimeDescriptor(JSON.parse(RAW_B))

/** A release conf could publish that this build is too old for. */
const RAW_TOO_NEW = rawWith((doc) => {
  doc['descriptor_id'] = 'tensorrt-llm-1.4.0-r1'
  doc['minimum_core_version'] = '9.9.9'
})

const okFetch = (body: string): DescriptorFetch => vi.fn(async () => new Response(body, { status: 200 }))
const notOkFetch = (status = 500): DescriptorFetch =>
  vi.fn(async () => new Response('server error', { status }))
const failingFetch = (message = 'network unreachable'): DescriptorFetch =>
  vi.fn(async () => {
    throw new Error(message)
  })
const unreachableFetch: DescriptorFetch = vi.fn(async () => {
  throw new Error('forInstallation must never call fetch')
})
const unreachableReadFile = (): Promise<string> =>
  Promise.reject(new Error('forInstallation must never call readFile'))

const provider = (opts: {
  fetch?: DescriptorFetch
  readFile?: (path: string) => Promise<string>
  env?: Record<string, string | undefined>
  fs?: FakeManagedFs
  coreVersion?: string
}) =>
  createRuntimeDescriptorProvider({
    env: opts.env ?? {},
    fetch: opts.fetch ?? unreachableFetch,
    readFile: opts.readFile ?? unreachableReadFile,
    ...(opts.fs === undefined ? {} : { fs: opts.fs }),
    root: ROOT,
    coreVersion: opts.coreVersion ?? CORE_VERSION,
  })

/** Seeds the cache as if a previous `forNewSetup()` had already accepted this descriptor. */
const seedAccepted = async (fs: FakeManagedFs, raw: string, descriptor: RuntimeDescriptor): Promise<void> => {
  fs.files.set(PATHS.descriptorFile(descriptor.descriptor_id), raw)
  fs.files.set(PATHS.descriptorLatestFile, JSON.stringify({ descriptor_id: descriptor.descriptor_id }))
}

describe('forNewSetup', () => {
  it('caches and returns a freshly fetched, compatible descriptor', async () => {
    const fs = new FakeManagedFs()
    const fetch = okFetch(RAW_A)
    const result = await provider({ fetch, fs }).forNewSetup()

    expect(result).toEqual({ kind: 'available', descriptor: DESCRIPTOR_A })
    expect(fetch).toHaveBeenCalledWith(DEFAULT_TENSORRT_LLM_DESCRIPTOR_URL, expect.any(Number))
    expect(JSON.parse(fs.files.get(PATHS.descriptorFile('tensorrt-llm-1.2.1-r1')) ?? 'null')).toEqual(
      JSON.parse(RAW_A)
    )
    expect(JSON.parse(fs.files.get(PATHS.descriptorLatestFile) ?? 'null')).toEqual({
      descriptor_id: 'tensorrt-llm-1.2.1-r1',
    })
  })

  it('no network + cache: uses the cached descriptor and reports no error', async () => {
    const fs = new FakeManagedFs()
    await seedAccepted(fs, RAW_A, DESCRIPTOR_A)
    const result = await provider({ fetch: failingFetch(), fs }).forNewSetup()

    expect(result).toEqual({ kind: 'available', descriptor: DESCRIPTOR_A })
  })

  it('no network and no cache: unsupported with MANAGED_METADATA_INVALID', async () => {
    const fs = new FakeManagedFs()
    const result = await provider({ fetch: failingFetch(), fs }).forNewSetup()

    expect(result.kind).toBe('unsupported')
    if (result.kind === 'unsupported') {
      expect(result.error).toBeInstanceOf(AtomicCoreError)
      expect(result.error.code).toBe('MANAGED_METADATA_INVALID')
    }
  })

  it('a non-2xx response is treated the same as a network failure: falls back to cache', async () => {
    const fs = new FakeManagedFs()
    await seedAccepted(fs, RAW_A, DESCRIPTOR_A)
    const result = await provider({ fetch: notOkFetch(503), fs }).forNewSetup()

    expect(result).toEqual({ kind: 'available', descriptor: DESCRIPTOR_A })
  })

  it('an invalid fetched document falls back to the previous cache without error', async () => {
    const fs = new FakeManagedFs()
    await seedAccepted(fs, RAW_A, DESCRIPTOR_A)
    const brokenJson = okFetch('{ not json')
    const result = await provider({ fetch: brokenJson, fs }).forNewSetup()

    expect(result).toEqual({ kind: 'available', descriptor: DESCRIPTOR_A })
  })

  it('a fetched document that fails schema validation falls back to the previous cache', async () => {
    const fs = new FakeManagedFs()
    await seedAccepted(fs, RAW_A, DESCRIPTOR_A)
    const wrongShape = okFetch(JSON.stringify({ not: 'a descriptor' }))
    const result = await provider({ fetch: wrongShape, fs }).forNewSetup()

    expect(result).toEqual({ kind: 'available', descriptor: DESCRIPTOR_A })
  })

  it('too-new core requirement: keeps using the previous accepted descriptor', async () => {
    const fs = new FakeManagedFs()
    await seedAccepted(fs, RAW_A, DESCRIPTOR_A)
    const result = await provider({ fetch: okFetch(RAW_TOO_NEW), fs }).forNewSetup()

    expect(result).toEqual({ kind: 'available', descriptor: DESCRIPTOR_A })
    // The too-new document must not have been accepted into the cache.
    expect(fs.files.has(PATHS.descriptorFile('tensorrt-llm-1.4.0-r1'))).toBe(false)
  })

  it('too-new core requirement with no previous descriptor: unsupported, "update required"', async () => {
    const fs = new FakeManagedFs()
    const result = await provider({ fetch: okFetch(RAW_TOO_NEW), fs }).forNewSetup()

    expect(result.kind).toBe('unsupported')
    if (result.kind === 'unsupported') {
      expect(result.error.code).toBe('MANAGED_METADATA_INVALID')
      expect(result.error.message.toLowerCase()).toContain('update')
    }
  })

  it('file:// override reads from disk instead of fetching, and is cached the same way', async () => {
    const fs = new FakeManagedFs()
    const readFile = vi.fn(async (path: string) => {
      expect(path).toBe('/dev/tensorrt-llm.json')
      return RAW_A
    })
    const result = await provider({
      fetch: unreachableFetch,
      readFile,
      env: { [RUNTIME_DESCRIPTOR_URL_ENV]: 'file:///dev/tensorrt-llm.json' },
      fs,
    }).forNewSetup()

    expect(result).toEqual({ kind: 'available', descriptor: DESCRIPTOR_A })
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(unreachableFetch).not.toHaveBeenCalled()
    expect(fs.files.has(PATHS.descriptorFile('tensorrt-llm-1.2.1-r1'))).toBe(true)
  })

  it('an ATOMIC_RUNTIME_DESCRIPTOR_URL https override replaces the default source', async () => {
    const fs = new FakeManagedFs()
    const fetch = okFetch(RAW_A)
    await provider({
      fetch,
      env: { [RUNTIME_DESCRIPTOR_URL_ENV]: 'https://example.test/tensorrt-llm.json' },
      fs,
    }).forNewSetup()

    expect(fetch).toHaveBeenCalledWith('https://example.test/tensorrt-llm.json', expect.any(Number))
  })

  it('writes the cache atomically: a temp file is written, then renamed into place', async () => {
    const fs = new FakeManagedFs()
    await provider({ fetch: okFetch(RAW_A), fs }).forNewSetup()

    const finalPath = PATHS.descriptorFile('tensorrt-llm-1.2.1-r1')
    const rename = fs.renames.find(([, to]) => to === finalPath)
    expect(rename).toBeDefined()
    expect(rename?.[0]).toBe(`${finalPath}.tmp`)
    // The temp file never lingers: the rename consumed it (FakeManagedFs.rename deletes the source).
    expect(fs.files.has(`${finalPath}.tmp`)).toBe(false)

    const latestRename = fs.renames.find(([, to]) => to === PATHS.descriptorLatestFile)
    expect(latestRename?.[0]).toBe(`${PATHS.descriptorLatestFile}.tmp`)
  })
})

describe('forInstallation', () => {
  it('resolves a pinned descriptor from the cache alone: no fetch, no readFile', async () => {
    const fs = new FakeManagedFs()
    await seedAccepted(fs, RAW_A, DESCRIPTOR_A)
    const result = await provider({ fs }).forInstallation('tensorrt-llm-1.2.1-r1')

    expect(result).toEqual({ kind: 'available', descriptor: DESCRIPTOR_A })
    expect(unreachableFetch).not.toHaveBeenCalled()
  })

  it('a descriptor published in conf while an installation is pinned to an older one: setup on the old id needs no download, and its cache survives', async () => {
    const fs = new FakeManagedFs()
    await seedAccepted(fs, RAW_A, DESCRIPTOR_A)

    // conf now serves B; a fresh setup accepts and caches it, moving "latest" forward.
    const freshFetch = okFetch(RAW_B)
    const fresh = await provider({ fetch: freshFetch, fs }).forNewSetup()
    expect(fresh).toEqual({ kind: 'available', descriptor: DESCRIPTOR_B })

    // The installation still on A resolves purely from cache: no network call for it, ever.
    const aFetch: DescriptorFetch = vi.fn(async () => {
      throw new Error('an installation pinned to A must never fetch')
    })
    const pinned = await provider({ fetch: aFetch, fs }).forInstallation('tensorrt-llm-1.2.1-r1')

    expect(pinned).toEqual({ kind: 'available', descriptor: DESCRIPTOR_A })
    expect(aFetch).not.toHaveBeenCalled()
    // A's own cache entry is untouched by B's arrival.
    expect(JSON.parse(fs.files.get(PATHS.descriptorFile('tensorrt-llm-1.2.1-r1')) ?? 'null')).toEqual(
      JSON.parse(RAW_A)
    )
  })

  it('no cached descriptor for the pinned id: unsupported with MANAGED_METADATA_INVALID', async () => {
    const fs = new FakeManagedFs()
    const result = await provider({ fs }).forInstallation('no-such-descriptor')

    expect(result.kind).toBe('unsupported')
    if (result.kind === 'unsupported') {
      expect(result.error.code).toBe('MANAGED_METADATA_INVALID')
      expect(result.error.details).toBe('no-such-descriptor')
    }
  })
})

describe('descriptorMeetsCoreVersion', () => {
  const withMinimum = (minimum_core_version: string): RuntimeDescriptor => ({
    ...DESCRIPTOR_A,
    minimum_core_version,
  })

  it.each([
    ['equal versions pass', '0.7.0', '0.7.0', true],
    ['a lower requirement passes', '0.7.0', '0.6.0', true],
    ['a higher requirement fails', '0.6.0', '0.7.0', false],
    ['minor component decides when major ties', '0.7.0', '0.8.0', false],
    ['patch component decides when major.minor ties', '0.7.1', '0.7.0', true],
    ['patch component fails when major.minor ties', '0.7.0', '0.7.1', false],
    ['a double-digit component compares numerically, not lexicographically', '0.10.0', '0.9.0', true],
    ['a much newer core still satisfies an old floor', '2.3.0', '0.7.0', true],
  ] as const)('%s: core %s vs minimum %s -> %s', (_label, coreVersion, minimum, expected) => {
    expect(descriptorMeetsCoreVersion(withMinimum(minimum), coreVersion)).toBe(expected)
  })
})
