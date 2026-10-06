import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { RuntimeDescriptor } from '../../contracts/index.js'
import { managedSharedPaths } from '../../config/index.js'
import { FakeManagedFs, posixPath } from '../../../test/helpers/managed-store-fs.js'
import { readRuntimeFixture } from '../../../test/helpers/runtime-fixtures.js'
import {
  createRuntimeDescriptorProvider,
  descriptorFetchFromFetch,
  descriptorMeetsCoreVersion,
  DEFAULT_TENSORRT_LLM_DESCRIPTOR_URL,
  defaultDescriptorUrl,
  RUNTIME_DESCRIPTOR_URL_ENV,
  runtimeDescriptorUrlEnv,
  TENSORRT_LLM_DESCRIPTOR_SOURCE,
} from './descriptor-provider.js'
import { parseRuntimeDescriptor } from './descriptor.js'
import type { DescriptorFetch } from './descriptor-provider.js'

const ROOT = '/shared'
const PATHS = managedSharedPaths(ROOT)
const CORE_VERSION = '0.7.6'

/** A real published descriptor, verbatim: `descriptor_id` `tensorrt-llm-1.2.1-r2`, `minimum_core_version` `0.7.5`. */
const FIXTURE_A = readRuntimeFixture('tensorrt-llm-1.2.1-r2.json') as Record<string, unknown>
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
  engines?: Parameters<typeof createRuntimeDescriptorProvider>[0]['engines']
}) =>
  createRuntimeDescriptorProvider({
    ...(opts.engines === undefined ? {} : { engines: opts.engines }),
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
  fs.files.set(
    PATHS.descriptorLatestFileFor('tensorrt-llm'),
    JSON.stringify({ descriptor_id: descriptor.descriptor_id })
  )
}

describe('forNewSetup', () => {
  it('caches and returns a freshly fetched, compatible descriptor', async () => {
    const fs = new FakeManagedFs()
    const fetch = okFetch(RAW_A)
    const result = await provider({ fetch, fs }).forNewSetup('tensorrt-llm')

    expect(result).toEqual({ kind: 'available', descriptor: DESCRIPTOR_A })
    expect(fetch).toHaveBeenCalledWith(DEFAULT_TENSORRT_LLM_DESCRIPTOR_URL, expect.any(Number))
    expect(JSON.parse(fs.files.get(PATHS.descriptorFile('tensorrt-llm-1.2.1-r2')) ?? 'null')).toEqual(
      JSON.parse(RAW_A)
    )
    expect(JSON.parse(fs.files.get(PATHS.descriptorLatestFileFor('tensorrt-llm')) ?? 'null')).toEqual({
      descriptor_id: 'tensorrt-llm-1.2.1-r2',
    })
  })

  it('no network + cache: uses the cached descriptor and reports no error', async () => {
    const fs = new FakeManagedFs()
    await seedAccepted(fs, RAW_A, DESCRIPTOR_A)
    const result = await provider({ fetch: failingFetch(), fs }).forNewSetup('tensorrt-llm')

    expect(result).toEqual({ kind: 'available', descriptor: DESCRIPTOR_A })
  })

  it('no network and no cache: unsupported with MANAGED_METADATA_INVALID', async () => {
    const fs = new FakeManagedFs()
    const result = await provider({ fetch: failingFetch(), fs }).forNewSetup('tensorrt-llm')

    expect(result.kind).toBe('unsupported')
    if (result.kind === 'unsupported') {
      expect(result.error).toBeInstanceOf(AtomicCoreError)
      expect(result.error.code).toBe('MANAGED_METADATA_INVALID')
    }
  })

  it('a non-2xx response is treated the same as a network failure: falls back to cache', async () => {
    const fs = new FakeManagedFs()
    await seedAccepted(fs, RAW_A, DESCRIPTOR_A)
    const result = await provider({ fetch: notOkFetch(503), fs }).forNewSetup('tensorrt-llm')

    expect(result).toEqual({ kind: 'available', descriptor: DESCRIPTOR_A })
  })

  it('an invalid fetched document falls back to the previous cache without error', async () => {
    const fs = new FakeManagedFs()
    await seedAccepted(fs, RAW_A, DESCRIPTOR_A)
    const brokenJson = okFetch('{ not json')
    const result = await provider({ fetch: brokenJson, fs }).forNewSetup('tensorrt-llm')

    expect(result).toEqual({ kind: 'available', descriptor: DESCRIPTOR_A })
  })

  it('a fetched document that fails schema validation falls back to the previous cache', async () => {
    const fs = new FakeManagedFs()
    await seedAccepted(fs, RAW_A, DESCRIPTOR_A)
    const wrongShape = okFetch(JSON.stringify({ not: 'a descriptor' }))
    const result = await provider({ fetch: wrongShape, fs }).forNewSetup('tensorrt-llm')

    expect(result).toEqual({ kind: 'available', descriptor: DESCRIPTOR_A })
  })

  it('too-new core requirement: keeps using the previous accepted descriptor', async () => {
    const fs = new FakeManagedFs()
    await seedAccepted(fs, RAW_A, DESCRIPTOR_A)
    const result = await provider({ fetch: okFetch(RAW_TOO_NEW), fs }).forNewSetup('tensorrt-llm')

    expect(result).toEqual({ kind: 'available', descriptor: DESCRIPTOR_A })
    // The too-new document must not have been accepted into the cache.
    expect(fs.files.has(PATHS.descriptorFile('tensorrt-llm-1.4.0-r1'))).toBe(false)
  })

  it('too-new core requirement with no previous descriptor: unsupported, "update required"', async () => {
    const fs = new FakeManagedFs()
    const result = await provider({ fetch: okFetch(RAW_TOO_NEW), fs }).forNewSetup('tensorrt-llm')

    expect(result.kind).toBe('unsupported')
    if (result.kind === 'unsupported') {
      expect(result.error.code).toBe('MANAGED_METADATA_INVALID')
      expect(result.error.message.toLowerCase()).toContain('update')
    }
  })

  it('file:// override reads from disk instead of fetching, and is cached the same way', async () => {
    const fs = new FakeManagedFs()
    // The host's own spelling of the file URL (a drive on Windows), and the path it names.
    const url = pathToFileURL('/dev/tensorrt-llm.json')
    const readFile = vi.fn(async (path: string) => {
      expect(path).toBe(fileURLToPath(url))
      return RAW_A
    })
    const result = await provider({
      fetch: unreachableFetch,
      readFile,
      env: { [RUNTIME_DESCRIPTOR_URL_ENV]: url.href },
      fs,
    }).forNewSetup('tensorrt-llm')

    expect(result).toEqual({ kind: 'available', descriptor: DESCRIPTOR_A })
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(unreachableFetch).not.toHaveBeenCalled()
    expect(fs.files.has(PATHS.descriptorFile('tensorrt-llm-1.2.1-r2'))).toBe(true)
  })

  it('an ATOMIC_RUNTIME_DESCRIPTOR_URL https override replaces the default source', async () => {
    const fs = new FakeManagedFs()
    const fetch = okFetch(RAW_A)
    await provider({
      fetch,
      env: { [RUNTIME_DESCRIPTOR_URL_ENV]: 'https://example.test/tensorrt-llm.json' },
      fs,
    }).forNewSetup('tensorrt-llm')

    expect(fetch).toHaveBeenCalledWith('https://example.test/tensorrt-llm.json', expect.any(Number))
  })

  it('writes the cache atomically: a uniquely named temp file is written, then renamed into place', async () => {
    const fs = new FakeManagedFs()
    await provider({ fetch: okFetch(RAW_A), fs }).forNewSetup('tensorrt-llm')

    const finalPath = PATHS.descriptorFile('tensorrt-llm-1.2.1-r2')
    const rename = fs.renames.find(([, to]) => to === posixPath(finalPath))
    expect(rename).toBeDefined()
    // Not a fixed `<path>.tmp`: this cache has no lock, so a shared name would let a second,
    // concurrent writer (the other scope's core) clobber it. `<path>.<uuid>.tmp` per call instead.
    expect(rename?.[0]).toMatch(/^\/shared\/descriptors\/tensorrt-llm-1\.2\.1-r2\.json\.[0-9a-f-]{36}\.tmp$/)
    // The temp file never lingers: the rename consumed it (FakeManagedFs.rename deletes the source).
    expect(fs.files.has(rename?.[0] ?? '')).toBe(false)

    const latestRename = fs.renames.find(
      ([, to]) => to === posixPath(PATHS.descriptorLatestFileFor('tensorrt-llm'))
    )
    expect(latestRename?.[0]).toMatch(
      /^\/shared\/descriptors\/latest-tensorrt-llm\.json\.[0-9a-f-]{36}\.tmp$/
    )
  })

  it('a cache write failure is not fatal: the freshly fetched descriptor is still returned', async () => {
    class WriteFailsFs extends FakeManagedFs {
      override writeFile(): Promise<void> {
        return Promise.reject(new Error('ENOSPC: no space left on device'))
      }
    }
    const onWarn = vi.fn()
    const result = await createRuntimeDescriptorProvider({
      env: {},
      fetch: okFetch(RAW_A),
      readFile: unreachableReadFile,
      fs: new WriteFailsFs(),
      root: ROOT,
      coreVersion: CORE_VERSION,
      onWarn,
    }).forNewSetup('tensorrt-llm')

    expect(result).toEqual({ kind: 'available', descriptor: DESCRIPTOR_A })
    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(onWarn.mock.calls[0]?.[0]).toContain('tensorrt-llm-1.2.1-r2')
  })

  it('two concurrent accepts of different descriptor ids never clobber each other', async () => {
    const fs = new FakeManagedFs()
    const [resultA, resultB] = await Promise.all([
      provider({ fetch: okFetch(RAW_A), fs }).forNewSetup('tensorrt-llm'),
      provider({ fetch: okFetch(RAW_B), fs }).forNewSetup('tensorrt-llm'),
    ])

    expect(resultA).toEqual({ kind: 'available', descriptor: DESCRIPTOR_A })
    expect(resultB).toEqual({ kind: 'available', descriptor: DESCRIPTOR_B })
    // Both landed on disk, uncorrupted, and no stray .tmp file was left behind by either.
    expect(JSON.parse(fs.files.get(PATHS.descriptorFile('tensorrt-llm-1.2.1-r2')) ?? 'null')).toEqual(
      JSON.parse(RAW_A)
    )
    expect(JSON.parse(fs.files.get(PATHS.descriptorFile('tensorrt-llm-1.3.0-r1')) ?? 'null')).toEqual(
      JSON.parse(RAW_B)
    )
    expect([...fs.files.keys()].some((path) => path.endsWith('.tmp'))).toBe(false)
    // latest.json is a benign last-writer-wins race: whichever it is, it must be valid and be one
    // of the two ids actually written — never a torn or mixed read.
    const latest = JSON.parse(fs.files.get(PATHS.descriptorLatestFileFor('tensorrt-llm')) ?? 'null') as {
      descriptor_id: string
    }
    expect(['tensorrt-llm-1.2.1-r2', 'tensorrt-llm-1.3.0-r1']).toContain(latest.descriptor_id)
  })
})

describe('cachedForNewSetup', () => {
  it('never calls fetch or readFile', async () => {
    const fs = new FakeManagedFs()
    await seedAccepted(fs, RAW_A, DESCRIPTOR_A)
    const result = await provider({ fs }).cachedForNewSetup('tensorrt-llm')

    expect(result).toEqual({ kind: 'available', descriptor: DESCRIPTOR_A })
    expect(unreachableFetch).not.toHaveBeenCalled()
  })

  it('unsupported, network-free, when nothing has ever been cached', async () => {
    const fs = new FakeManagedFs()
    const result = await provider({ fs }).cachedForNewSetup('tensorrt-llm')

    expect(result.kind).toBe('unsupported')
    if (result.kind === 'unsupported') {
      expect(result.error.code).toBe('MANAGED_METADATA_INVALID')
    }
  })
})

describe('readSource scheme restriction (via forNewSetup)', () => {
  it('rejects a plain http:// override instead of fetching it, and warns', async () => {
    const fs = new FakeManagedFs()
    await seedAccepted(fs, RAW_A, DESCRIPTOR_A)
    const onWarn = vi.fn()
    const result = await createRuntimeDescriptorProvider({
      env: { [RUNTIME_DESCRIPTOR_URL_ENV]: 'http://example.test/tensorrt-llm.json' },
      fetch: unreachableFetch,
      readFile: unreachableReadFile,
      fs,
      root: ROOT,
      coreVersion: CORE_VERSION,
      onWarn,
    }).forNewSetup('tensorrt-llm')

    expect(result).toEqual({ kind: 'available', descriptor: DESCRIPTOR_A })
    expect(unreachableFetch).not.toHaveBeenCalled()
    // The override itself, then why it gave nothing and what stands in.
    expect(onWarn).toHaveBeenCalledTimes(2)
    expect(onWarn.mock.calls[0]?.[0]).toContain(
      `overridden by ${RUNTIME_DESCRIPTOR_URL_ENV}=http://example.test`
    )
    expect(onWarn.mock.calls[1]?.[0]).toContain('neither file:// nor https://')
    expect(onWarn.mock.calls[1]?.[0]).toContain(`using the cached ${DESCRIPTOR_A.descriptor_id}`)
    expect(onWarn.mock.calls[0]?.[0]).toContain('http://example.test/tensorrt-llm.json')
  })

  it('rejects an unrecognised scheme the same way, with no cache to fall back to', async () => {
    const fs = new FakeManagedFs()
    const result = await createRuntimeDescriptorProvider({
      env: { [RUNTIME_DESCRIPTOR_URL_ENV]: 'ftp://example.test/tensorrt-llm.json' },
      fetch: unreachableFetch,
      readFile: unreachableReadFile,
      fs,
      root: ROOT,
      coreVersion: CORE_VERSION,
    }).forNewSetup('tensorrt-llm')

    expect(result.kind).toBe('unsupported')
    expect(unreachableFetch).not.toHaveBeenCalled()
  })
})

describe('forInstallation', () => {
  it('resolves a pinned descriptor from the cache alone: no fetch, no readFile', async () => {
    const fs = new FakeManagedFs()
    await seedAccepted(fs, RAW_A, DESCRIPTOR_A)
    const result = await provider({ fs }).forInstallation('tensorrt-llm-1.2.1-r2')

    expect(result).toEqual({ kind: 'available', descriptor: DESCRIPTOR_A })
    expect(unreachableFetch).not.toHaveBeenCalled()
  })

  it('a descriptor published in conf while an installation is pinned to an older one: setup on the old id needs no download, and its cache survives', async () => {
    const fs = new FakeManagedFs()
    await seedAccepted(fs, RAW_A, DESCRIPTOR_A)

    // conf now serves B; a fresh setup accepts and caches it, moving "latest" forward.
    const freshFetch = okFetch(RAW_B)
    const fresh = await provider({ fetch: freshFetch, fs }).forNewSetup('tensorrt-llm')
    expect(fresh).toEqual({ kind: 'available', descriptor: DESCRIPTOR_B })

    // The installation still on A resolves purely from cache: no network call for it, ever.
    const aFetch: DescriptorFetch = vi.fn(async () => {
      throw new Error('an installation pinned to A must never fetch')
    })
    const pinned = await provider({ fetch: aFetch, fs }).forInstallation('tensorrt-llm-1.2.1-r2')

    expect(pinned).toEqual({ kind: 'available', descriptor: DESCRIPTOR_A })
    expect(aFetch).not.toHaveBeenCalled()
    // A's own cache entry is untouched by B's arrival.
    expect(JSON.parse(fs.files.get(PATHS.descriptorFile('tensorrt-llm-1.2.1-r2')) ?? 'null')).toEqual(
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

/**
 * One descriptor per engine (change `add-vllm-runtime`, task 2.1). The second engine is test data:
 * the TensorRT-LLM fixture with another `engine_id`, published at its own conf path.
 */
describe('a descriptor per engine', () => {
  const SECOND = { engine_id: 'vllm', label: 'vLLM', url: defaultDescriptorUrl('vllm') }
  const ENGINES = [TENSORRT_LLM_DESCRIPTOR_SOURCE, SECOND]
  const RAW_SECOND = rawWith((doc) => {
    doc['descriptor_id'] = 'vllm-0.31.0-cu129-r1'
    doc['engine_id'] = 'vllm'
    doc['adapter_id'] = 'vllm'
  })
  const DESCRIPTOR_SECOND = parseRuntimeDescriptor(JSON.parse(RAW_SECOND))
  /** Answers each engine's conf path; anything else (or a missing body) is a 404. */
  const routedFetch = (bodies: Record<string, string | undefined>): DescriptorFetch =>
    vi.fn(async (url: string) => {
      const body = bodies[url]
      return body === undefined ? new Response('404: Not Found', { status: 404 }) : new Response(body)
    })

  it('each engine reads its own conf file and keeps its own last-accepted pointer', async () => {
    const fs = new FakeManagedFs()
    const fetch = routedFetch({ [DEFAULT_TENSORRT_LLM_DESCRIPTOR_URL]: RAW_A, [SECOND.url]: RAW_SECOND })
    const descriptors = provider({ fetch, fs, engines: ENGINES })

    expect(await descriptors.forNewSetup('vllm')).toEqual({
      kind: 'available',
      descriptor: DESCRIPTOR_SECOND,
    })
    expect(await descriptors.forNewSetup('tensorrt-llm')).toEqual({
      kind: 'available',
      descriptor: DESCRIPTOR_A,
    })
    expect(fetch).toHaveBeenCalledWith(defaultDescriptorUrl('vllm'), expect.any(Number))
    expect(JSON.parse(fs.files.get(PATHS.descriptorLatestFileFor('vllm')) ?? 'null')).toEqual({
      descriptor_id: 'vllm-0.31.0-cu129-r1',
    })
    // The legacy single pointer is never written again.
    expect(fs.files.has(PATHS.descriptorLatestFile)).toBe(false)
  })

  it('Последний принятый — у каждого движка свой: offline, TensorRT-LLM plans with its own, not the newer vLLM one', async () => {
    const fs = new FakeManagedFs()
    await seedAccepted(fs, RAW_A, DESCRIPTOR_A)
    // vLLM was accepted later; a single pointer would now name it.
    await provider({ fetch: routedFetch({ [SECOND.url]: RAW_SECOND }), fs, engines: ENGINES }).forNewSetup(
      'vllm'
    )

    const offline = provider({ fetch: failingFetch(), fs, engines: ENGINES })
    expect(await offline.forNewSetup('tensorrt-llm')).toEqual({ kind: 'available', descriptor: DESCRIPTOR_A })
    expect(await offline.cachedForNewSetup('tensorrt-llm')).toEqual({
      kind: 'available',
      descriptor: DESCRIPTOR_A,
    })
    expect(await offline.cachedForNewSetup('vllm')).toEqual({
      kind: 'available',
      descriptor: DESCRIPTOR_SECOND,
    })
  })

  it('Дескриптора в main conf ещё нет: a 404 makes only that engine unsupported, and the next call picks it up once published', async () => {
    const fs = new FakeManagedFs()
    const bodies: Record<string, string | undefined> = { [DEFAULT_TENSORRT_LLM_DESCRIPTOR_URL]: RAW_A }
    const descriptors = provider({ fetch: routedFetch(bodies), fs, engines: ENGINES })

    const missing = await descriptors.forNewSetup('vllm')
    expect(missing.kind).toBe('unsupported')
    if (missing.kind === 'unsupported') expect(missing.error.code).toBe('MANAGED_METADATA_INVALID')
    expect(await descriptors.forNewSetup('tensorrt-llm')).toEqual({
      kind: 'available',
      descriptor: DESCRIPTOR_A,
    })

    bodies[SECOND.url] = RAW_SECOND
    expect(await descriptors.forNewSetup('vllm')).toEqual({
      kind: 'available',
      descriptor: DESCRIPTOR_SECOND,
    })
  })

  it("rejects a document whose engine_id is another engine's, and keeps that engine's previous one", async () => {
    const fs = new FakeManagedFs()
    await seedAccepted(fs, RAW_A, DESCRIPTOR_A)
    const warnings: string[] = []
    const descriptors = createRuntimeDescriptorProvider({
      env: {},
      // conf's tensorrt-llm.json now holds vLLM's document.
      fetch: okFetch(RAW_SECOND),
      readFile: unreachableReadFile,
      fs,
      root: ROOT,
      coreVersion: CORE_VERSION,
      engines: ENGINES,
      onWarn: (message) => warnings.push(message),
    })

    expect(await descriptors.forNewSetup('tensorrt-llm')).toEqual({
      kind: 'available',
      descriptor: DESCRIPTOR_A,
    })
    expect(fs.files.has(PATHS.descriptorFile('vllm-0.31.0-cu129-r1'))).toBe(false)
    expect(warnings.join('\n')).toContain('is for vllm, not tensorrt-llm')
  })

  it('reads the legacy latest.json as the TensorRT-LLM pointer until its own exists, and never as another engine’s', async () => {
    const fs = new FakeManagedFs()
    fs.files.set(PATHS.descriptorFile(DESCRIPTOR_A.descriptor_id), RAW_A)
    fs.files.set(PATHS.descriptorLatestFile, JSON.stringify({ descriptor_id: DESCRIPTOR_A.descriptor_id }))
    const descriptors = provider({ fetch: failingFetch(), fs, engines: ENGINES })

    expect(await descriptors.cachedForNewSetup('tensorrt-llm')).toEqual({
      kind: 'available',
      descriptor: DESCRIPTOR_A,
    })
    expect((await descriptors.cachedForNewSetup('vllm')).kind).toBe('unsupported')
  })

  it('a legacy latest.json naming another engine’s descriptor is not a TensorRT-LLM pointer', async () => {
    const fs = new FakeManagedFs()
    fs.files.set(PATHS.descriptorFile(DESCRIPTOR_SECOND.descriptor_id), RAW_SECOND)
    fs.files.set(
      PATHS.descriptorLatestFile,
      JSON.stringify({ descriptor_id: DESCRIPTOR_SECOND.descriptor_id })
    )

    expect((await provider({ fs, engines: ENGINES }).cachedForNewSetup('tensorrt-llm')).kind).toBe(
      'unsupported'
    )
  })

  it('Локальный дескриптор в разработке: ATOMIC_RUNTIME_DESCRIPTOR_URL_VLLM moves vLLM alone', async () => {
    const fs = new FakeManagedFs()
    const url = pathToFileURL('/dev/vllm.json')
    const readFile = vi.fn(async () => RAW_SECOND)
    const fetch = routedFetch({ [DEFAULT_TENSORRT_LLM_DESCRIPTOR_URL]: RAW_A })
    const descriptors = provider({
      fetch,
      readFile,
      fs,
      engines: ENGINES,
      env: { ATOMIC_RUNTIME_DESCRIPTOR_URL_VLLM: url.href },
    })

    expect(runtimeDescriptorUrlEnv('vllm')).toBe('ATOMIC_RUNTIME_DESCRIPTOR_URL_VLLM')
    expect(await descriptors.forNewSetup('vllm')).toEqual({
      kind: 'available',
      descriptor: DESCRIPTOR_SECOND,
    })
    expect(await descriptors.forNewSetup('tensorrt-llm')).toEqual({
      kind: 'available',
      descriptor: DESCRIPTOR_A,
    })
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(DEFAULT_TENSORRT_LLM_DESCRIPTOR_URL, expect.any(Number))
  })

  it('ATOMIC_RUNTIME_DESCRIPTOR_URL_TENSORRT_LLM wins over the legacy variable, which moves no other engine', async () => {
    const fs = new FakeManagedFs()
    const fetch = okFetch(RAW_A)
    const descriptors = provider({
      fetch,
      fs,
      engines: ENGINES,
      env: {
        [RUNTIME_DESCRIPTOR_URL_ENV]: 'https://example.test/legacy.json',
        ATOMIC_RUNTIME_DESCRIPTOR_URL_TENSORRT_LLM: 'https://example.test/per-engine.json',
      },
    })
    await descriptors.forNewSetup('tensorrt-llm')
    await descriptors.forNewSetup('vllm')

    expect(fetch).toHaveBeenCalledWith('https://example.test/per-engine.json', expect.any(Number))
    expect(fetch).toHaveBeenCalledWith(defaultDescriptorUrl('vllm'), expect.any(Number))
    expect(fetch).not.toHaveBeenCalledWith('https://example.test/legacy.json', expect.any(Number))
  })

  it('an engine with no source is unsupported, and forInstallation reads any engine’s pinned descriptor', async () => {
    const fs = new FakeManagedFs()
    fs.files.set(PATHS.descriptorFile(DESCRIPTOR_SECOND.descriptor_id), RAW_SECOND)
    const descriptors = provider({ fs })

    const result = await descriptors.forNewSetup('vllm')
    expect(result.kind).toBe('unsupported')
    if (result.kind === 'unsupported') expect(result.error.code).toBe('MANAGED_METADATA_INVALID')
    expect(await descriptors.forInstallation(DESCRIPTOR_SECOND.descriptor_id)).toEqual({
      kind: 'available',
      descriptor: DESCRIPTOR_SECOND,
    })
  })
})

describe('descriptorFetchFromFetch', () => {
  it('sends the url with an Accept: application/json header and an abortable signal', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Accept: 'application/json' })
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      expect(init?.signal?.aborted).toBe(false)
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const response = await descriptorFetchFromFetch(fetchImpl)('https://example.test/d.json', 5_000)

    expect(fetchImpl).toHaveBeenCalledWith('https://example.test/d.json', expect.any(Object))
    expect(response.status).toBe(200)
  })

  it('resolves with whatever Response the transport returns, non-2xx included: readSource decides what that means', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('server error', { status: 503 })
    ) as unknown as typeof fetch

    const response = await descriptorFetchFromFetch(fetchImpl)('https://example.test/d.json', 5_000)

    expect(response.ok).toBe(false)
    expect(response.status).toBe(503)
  })

  it('aborts the underlying request and rejects once the timeout elapses', async () => {
    let capturedSignal: AbortSignal | undefined
    const fetchImpl = vi.fn((_url: string | URL, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal
      return new Promise<Response>(() => undefined) // never settles on its own
    }) as unknown as typeof fetch

    await expect(descriptorFetchFromFetch(fetchImpl)('https://example.test/d.json', 10)).rejects.toThrow(
      /timed out after 10ms/
    )
    expect(capturedSignal?.aborted).toBe(true)
  })
})
