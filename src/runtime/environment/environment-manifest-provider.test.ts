import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { managedSharedPaths } from '../../config/index.js'
import { FakeManagedFs } from '../../../test/helpers/managed-store-fs.js'
import { readRuntimeFixture } from '../../../test/helpers/runtime-fixtures.js'
import type { DocumentFetch } from './cached-document.js'
import {
  createEnvironmentManifestProvider,
  DEFAULT_LINUX_ENVIRONMENT_MANIFEST_URL,
  DEFAULT_WINDOWS_ARM64_ENVIRONMENT_MANIFEST_URL,
  DEFAULT_WINDOWS_ENVIRONMENT_MANIFEST_URL,
  ENVIRONMENT_MANIFEST_URL_ENV,
  environmentManifestFetchFromFetch,
} from './environment-manifest-provider.js'
import { parseLinuxEnvironmentManifest, parseWindowsEnvironmentManifest } from './environment-manifest.js'

const ROOT = '/shared'
const PATHS = managedSharedPaths(ROOT)
const CORE_VERSION = '0.7.5'

/** The real fixture, verbatim: `manifest_id` `linux-r1`, `minimum_core_version` `0.7.5`. */
const FIXTURE = readRuntimeFixture('environments/linux.json') as Record<string, unknown>
const RAW_R1 = JSON.stringify(FIXTURE)
const MANIFEST_R1 = parseLinuxEnvironmentManifest(FIXTURE)

const rawWith = (mutate: (doc: Record<string, unknown>) => void): string => {
  const doc = JSON.parse(RAW_R1) as Record<string, unknown>
  mutate(doc)
  return JSON.stringify(doc)
}
/** The next published manifest: a new id, one more distribution — the conf rule for any change. */
const RAW_R2 = rawWith((doc) => {
  doc['manifest_id'] = 'linux-r2'
  const recipes = doc['recipes'] as Array<{ distributions: unknown[] }>
  recipes[0]?.distributions.push({ id: 'ubuntu', version_id: '28.04', arch: 'x86_64' })
})
const MANIFEST_R2 = parseLinuxEnvironmentManifest(JSON.parse(RAW_R2))
const RAW_TOO_NEW = rawWith((doc) => {
  doc['manifest_id'] = 'linux-r9'
  doc['minimum_core_version'] = '9.9.9'
})

const okFetch = (body: string): DocumentFetch => vi.fn(async () => new Response(body, { status: 200 }))
const failingFetch = (): DocumentFetch =>
  vi.fn(async () => {
    throw new Error('network unreachable')
  })
const unreachableFetch: DocumentFetch = vi.fn(async () => {
  throw new Error('pinned() must never call fetch')
})
const unreachableReadFile = (): Promise<string> =>
  Promise.reject(new Error('pinned() must never call readFile'))

const provider = (opts: {
  fetch?: DocumentFetch
  readFile?: (path: string) => Promise<string>
  env?: Record<string, string | undefined>
  fs: FakeManagedFs
  coreVersion?: string
  onWarn?: (message: string) => void
}) =>
  createEnvironmentManifestProvider({
    env: opts.env ?? {},
    fetch: opts.fetch ?? unreachableFetch,
    readFile: opts.readFile ?? unreachableReadFile,
    fs: opts.fs,
    root: ROOT,
    coreVersion: opts.coreVersion ?? CORE_VERSION,
    ...(opts.onWarn === undefined ? {} : { onWarn: opts.onWarn }),
  })

const seedAccepted = (fs: FakeManagedFs, raw: string, id: string): void => {
  fs.files.set(PATHS.environmentManifestFile(id), raw)
  fs.files.set(PATHS.environmentManifestLatestFile, JSON.stringify({ manifest_id: id }))
}

describe('latest', () => {
  it('fetches conf main’s Linux manifest by default, and caches it by manifest_id in the shared root', async () => {
    const fs = new FakeManagedFs()
    const fetch = okFetch(RAW_R1)
    const result = await provider({ fetch, fs }).latest()

    expect(result).toEqual({ kind: 'available', manifest: MANIFEST_R1 })
    expect(fetch).toHaveBeenCalledWith(DEFAULT_LINUX_ENVIRONMENT_MANIFEST_URL, expect.any(Number))
    expect(DEFAULT_LINUX_ENVIRONMENT_MANIFEST_URL).toMatch(/\/main\/runtimes\/environments\/linux\.json$/)
    expect(fs.files.get(PATHS.environmentManifestFile('linux-r1'))).toBe(RAW_R1)
    expect(JSON.parse(fs.files.get(PATHS.environmentManifestLatestFile) ?? 'null')).toEqual({
      manifest_id: 'linux-r1',
    })
    // Its own directory: a manifest id never lands among the descriptors.
    expect([...fs.files.keys()].some((path) => path.startsWith(PATHS.descriptorsDir))).toBe(false)
  })

  it('network unavailable: uses the cached manifest and reports no error', async () => {
    const fs = new FakeManagedFs()
    seedAccepted(fs, RAW_R1, 'linux-r1')
    expect(await provider({ fetch: failingFetch(), fs }).latest()).toEqual({
      kind: 'available',
      manifest: MANIFEST_R1,
    })
  })

  it('network unavailable and nothing cached: unavailable with MANAGED_METADATA_INVALID', async () => {
    const result = await provider({ fetch: failingFetch(), fs: new FakeManagedFs() }).latest()
    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable') expect(result.error.code).toBe('MANAGED_METADATA_INVALID')
  })

  it('a 404 from conf (no manifest published yet) is the same as no network', async () => {
    const fs = new FakeManagedFs()
    const notFound: DocumentFetch = vi.fn(async () => new Response('404: Not Found', { status: 404 }))
    expect((await provider({ fetch: notFound, fs }).latest()).kind).toBe('unavailable')
    seedAccepted(fs, RAW_R1, 'linux-r1')
    expect(await provider({ fetch: notFound, fs }).latest()).toEqual({
      kind: 'available',
      manifest: MANIFEST_R1,
    })
  })

  it('an invalid document (a command on a recipe) falls back to the cache and is never cached itself', async () => {
    const fs = new FakeManagedFs()
    seedAccepted(fs, RAW_R1, 'linux-r1')
    const withCommand = rawWith((doc) => {
      doc['manifest_id'] = 'linux-r3'
      const recipes = doc['recipes'] as Array<Record<string, unknown>>
      if (recipes[0] !== undefined) recipes[0]['command'] = 'curl | sh'
    })
    expect(await provider({ fetch: okFetch(withCommand), fs }).latest()).toEqual({
      kind: 'available',
      manifest: MANIFEST_R1,
    })
    expect(fs.files.has(PATHS.environmentManifestFile('linux-r3'))).toBe(false)
  })

  it('requires a newer core: the previously accepted manifest stands, and the new one is not cached', async () => {
    const fs = new FakeManagedFs()
    seedAccepted(fs, RAW_R1, 'linux-r1')
    expect(await provider({ fetch: okFetch(RAW_TOO_NEW), fs }).latest()).toEqual({
      kind: 'available',
      manifest: MANIFEST_R1,
    })
    expect(fs.files.has(PATHS.environmentManifestFile('linux-r9'))).toBe(false)
  })

  it('requires a newer core and nothing is cached: unavailable, naming the manifest', async () => {
    const result = await provider({ fetch: okFetch(RAW_TOO_NEW), fs: new FakeManagedFs() }).latest()
    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable') {
      expect(result.error.code).toBe('MANAGED_METADATA_INVALID')
      expect(result.error.details).toBe('linux-r9')
      expect(result.error.message.toLowerCase()).toContain('newer version')
    }
  })

  it('a newer published manifest replaces the latest pointer and keeps the older one cached', async () => {
    const fs = new FakeManagedFs()
    seedAccepted(fs, RAW_R1, 'linux-r1')
    expect(await provider({ fetch: okFetch(RAW_R2), fs }).latest()).toEqual({
      kind: 'available',
      manifest: MANIFEST_R2,
    })
    expect(JSON.parse(fs.files.get(PATHS.environmentManifestLatestFile) ?? 'null')).toEqual({
      manifest_id: 'linux-r2',
    })
    expect(fs.files.get(PATHS.environmentManifestFile('linux-r1'))).toBe(RAW_R1)
  })

  it('a file:// override reads the local manifest instead of conf main, and caches it the same way', async () => {
    const fs = new FakeManagedFs()
    const fetch = vi.fn(unreachableFetch)
    const readFile = vi.fn(async () => RAW_R1)
    const url = pathToFileURL('/work/atomic-chat-conf/runtimes/environments/linux.json')
    const result = await provider({
      fetch,
      readFile,
      fs,
      env: { [ENVIRONMENT_MANIFEST_URL_ENV]: url.href },
    }).latest()

    expect(result).toEqual({ kind: 'available', manifest: MANIFEST_R1 })
    expect(readFile).toHaveBeenCalledWith(fileURLToPath(url))
    expect(fetch).not.toHaveBeenCalled()
    expect(fs.files.has(PATHS.environmentManifestFile('linux-r1'))).toBe(true)
  })

  it('an https:// override replaces the default source', async () => {
    const fetch = okFetch(RAW_R1)
    await provider({
      fetch,
      fs: new FakeManagedFs(),
      env: { [ENVIRONMENT_MANIFEST_URL_ENV]: 'https://example.test/linux.json' },
    }).latest()
    expect(fetch).toHaveBeenCalledWith('https://example.test/linux.json', expect.any(Number))
  })

  it('refuses a plain http:// override instead of fetching it, warns, and falls back to the cache', async () => {
    const fs = new FakeManagedFs()
    seedAccepted(fs, RAW_R1, 'linux-r1')
    const fetch = vi.fn(okFetch(RAW_R2))
    const onWarn = vi.fn()
    const result = await provider({
      fetch,
      fs,
      onWarn,
      env: { [ENVIRONMENT_MANIFEST_URL_ENV]: 'http://example.test/linux.json' },
    }).latest()

    expect(result).toEqual({ kind: 'available', manifest: MANIFEST_R1 })
    expect(fetch).not.toHaveBeenCalled()
    expect(onWarn.mock.calls[0]?.[0]).toContain(
      'Environment manifest source "http://example.test/linux.json"'
    )
  })

  it('a manifest one scope accepted is what the other scope reads without a network (one shared root)', async () => {
    const fs = new FakeManagedFs()
    await provider({ fetch: okFetch(RAW_R1), fs }).latest()
    expect(await provider({ fetch: failingFetch(), fs }).latest()).toEqual({
      kind: 'available',
      manifest: MANIFEST_R1,
    })
  })
})

describe('on Windows', () => {
  /** The real Windows fixture, verbatim: `manifest_id` `windows-r1`, `minimum_core_version` `0.7.5`. */
  const RAW_WINDOWS = JSON.stringify(readRuntimeFixture('environments/windows.json'))
  const WINDOWS_R1 = parseWindowsEnvironmentManifest(JSON.parse(RAW_WINDOWS))

  const windowsProvider = (fetch: DocumentFetch, fs: FakeManagedFs) =>
    createEnvironmentManifestProvider({
      platform: 'windows',
      env: {},
      fetch,
      readFile: unreachableReadFile,
      fs,
      root: ROOT,
      coreVersion: CORE_VERSION,
    })

  it('fetches conf main’s Windows manifest, never Linux’s, and caches it by its own manifest_id', async () => {
    const fs = new FakeManagedFs()
    const fetch = okFetch(RAW_WINDOWS)
    expect(await windowsProvider(fetch, fs).latest()).toEqual({ kind: 'available', manifest: WINDOWS_R1 })
    expect(fetch).toHaveBeenCalledWith(DEFAULT_WINDOWS_ENVIRONMENT_MANIFEST_URL, expect.any(Number))
    expect(DEFAULT_WINDOWS_ENVIRONMENT_MANIFEST_URL).toMatch(/\/main\/runtimes\/environments\/windows\.json$/)
    expect(fs.files.get(PATHS.environmentManifestFile('windows-r1'))).toBe(RAW_WINDOWS)
  })

  it('on Windows on Arm, fetches the arm64 manifest, a file released cores never read', async () => {
    const fs = new FakeManagedFs()
    const raw = JSON.stringify({
      ...JSON.parse(RAW_WINDOWS),
      manifest_id: 'windows-arm64-r1',
      rootfs: {
        ...JSON.parse(RAW_WINDOWS).rootfs,
        url: 'https://example.org/ubuntu-24.04.5-wsl-arm64.wsl',
        distribution: { id: 'ubuntu', version_id: '24.04', arch: 'aarch64' },
      },
    })
    const fetch = okFetch(raw)
    const provider = createEnvironmentManifestProvider({
      platform: 'windows',
      arch: 'aarch64',
      env: {},
      fetch,
      readFile: unreachableReadFile,
      fs,
      root: ROOT,
      coreVersion: CORE_VERSION,
    })

    const result = await provider.latest()

    expect(result.kind).toBe('available')
    expect(fetch).toHaveBeenCalledWith(DEFAULT_WINDOWS_ARM64_ENVIRONMENT_MANIFEST_URL, expect.any(Number))
    expect(DEFAULT_WINDOWS_ARM64_ENVIRONMENT_MANIFEST_URL).toMatch(
      /\/main\/runtimes\/environments\/windows-arm64\.json$/
    )
    expect(fs.files.get(PATHS.environmentManifestFile('windows-arm64-r1'))).toBe(raw)
  })

  it('a Linux manifest served where Windows’ is expected is refused and never cached (spec: no other platform)', async () => {
    const fs = new FakeManagedFs()
    const result = await windowsProvider(okFetch(RAW_R1), fs).latest()
    expect(result.kind).toBe('unavailable')
    expect(fs.files.has(PATHS.environmentManifestFile('linux-r1'))).toBe(false)
  })

  it('pins the Windows manifest by id from the cache alone', async () => {
    const fs = new FakeManagedFs()
    seedAccepted(fs, RAW_WINDOWS, 'windows-r1')
    expect(await windowsProvider(unreachableFetch, fs).pinned('windows-r1')).toEqual({
      kind: 'available',
      manifest: WINDOWS_R1,
    })
  })
})

describe('pinned', () => {
  it('answers the exact cached manifest without fetch or readFile, even after a newer one was accepted', async () => {
    const fs = new FakeManagedFs()
    seedAccepted(fs, RAW_R1, 'linux-r1')
    seedAccepted(fs, RAW_R2, 'linux-r2')
    expect(await provider({ fs }).pinned('linux-r1')).toEqual({ kind: 'available', manifest: MANIFEST_R1 })
    expect(unreachableFetch).not.toHaveBeenCalled()
  })

  it('a pinned id that is not cached: unavailable naming it, never another manifest', async () => {
    const fs = new FakeManagedFs()
    seedAccepted(fs, RAW_R2, 'linux-r2')
    const result = await provider({ fs }).pinned('linux-r1')
    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable') {
      expect(result.error.code).toBe('MANAGED_METADATA_INVALID')
      expect(result.error.details).toBe('linux-r1')
    }
  })
})

describe('environmentManifestFetchFromFetch', () => {
  it('names the manifest when the hard timeout elapses, and aborts the request', async () => {
    let signal: AbortSignal | undefined
    const fetchImpl = vi.fn((_url: string | URL, init?: RequestInit) => {
      signal = init?.signal as AbortSignal
      return new Promise<Response>(() => undefined)
    }) as unknown as typeof fetch
    await expect(
      environmentManifestFetchFromFetch(fetchImpl)('https://example.test/linux.json', 10)
    ).rejects.toThrow(/Environment manifest fetch timed out after 10ms/)
    expect(signal?.aborted).toBe(true)
  })
})
