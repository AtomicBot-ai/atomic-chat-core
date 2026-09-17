import { describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import { BUNDLED_MANIFEST_BASELINE } from './bundled-manifest-baseline.js'
import {
  archSuffixFor,
  BUNDLED_BASELINE_TAG,
  fetchLiveManifest,
  fetchManifestWithFallbacks,
  fetchRemoteBackends,
  isSupportedBackendOs,
  LLAMACPP_BACKEND_MANIFEST_URL,
  ManifestSessionCache,
  manifestTransportFromFetch,
  parseManifestForPlatform,
  withHardTimeout,
} from './manifest.js'
import type { ManifestTransport } from './manifest.js'
import type { UpstreamManifest } from '../types.js'

// Mirrors atomic-chat-conf/backends/manifest.json (app backend.test.ts).
const MANIFEST: UpstreamManifest = {
  tag_name: 'b10205',
  assets: [
    { name: 'llama-b10205-bin-win-cpu-x64.zip' },
    { name: 'llama-b10205-bin-win-cuda-12.4-x64.zip' },
    { name: 'llama-b10205-bin-win-cuda-13.3-x64.zip' },
    { name: 'llama-b10205-bin-win-vulkan-x64.zip' },
    { name: 'llama-b10205-bin-ubuntu-x64.tar.gz' },
    { name: 'llama-b10205-bin-ubuntu-vulkan-x64.tar.gz' },
    { name: 'llama-b10205-bin-macos-arm64.tar.gz' },
    { name: 'cudart-llama-bin-win-cuda-12.4-x64.zip' },
    { name: 'cudart-llama-bin-win-cuda-13.3-x64.zip' },
  ],
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const okTransport = (body: unknown = MANIFEST, label = 'ok'): ManifestTransport => ({
  label,
  fetch: vi.fn(async () => jsonResponse(body)),
})
const failingTransport = (label: string, message = 'offline'): ManifestTransport => ({
  label,
  fetch: vi.fn(async () => {
    throw new Error(message)
  }),
})

describe('archSuffixFor / isSupportedBackendOs', () => {
  it.each([
    ['x86_64', 'x64'],
    ['x64', 'x64'],
    ['aarch64', 'arm64'],
    ['arm64', 'arm64'],
  ])('archSuffixFor(%j) = %j', (arch, expected) => {
    expect(archSuffixFor(arch)).toBe(expected)
  })
  it('accepts only windows/linux/macos', () => {
    expect(isSupportedBackendOs('windows')).toBe(true)
    expect(isSupportedBackendOs('android')).toBe(false)
  })
})

describe('parseManifestForPlatform', () => {
  it('returns the whitelisted Windows catalog without the cudart companions', () => {
    const names = parseManifestForPlatform(MANIFEST, 'windows', 'x64')
      .map((b) => b.backend)
      .sort()
    expect(names).toEqual(['win-cpu-x64', 'win-cuda-12.4-x64', 'win-cuda-13.3-x64', 'win-vulkan-x64'])
    for (const b of parseManifestForPlatform(MANIFEST, 'windows', 'x64'))
      expect(b).toMatchObject({ version: 'b10205', order: 0 })
  })
  it('accepts a ROCm asset and rejects anything outside the whitelist or the arch', () => {
    const manifest: UpstreamManifest = {
      tag_name: 'b10809',
      assets: [
        { name: 'llama-b10809-bin-win-rocm-10.0-x64.zip' },
        { name: 'llama-b10809-bin-win-openvino-x64.zip' },
        { name: 'llama-b10809-bin-win-cuda-13.3-arm64.zip' },
        { name: 'llama-b10809-bin-win-cpu-arm64.zip' },
      ],
    }
    expect(parseManifestForPlatform(manifest, 'windows', 'x64').map((b) => b.backend)).toEqual([
      'win-rocm-10.0-x64',
    ])
    expect(parseManifestForPlatform(manifest, 'windows', 'arm64')).toEqual([])
  })
  it('returns cpu + vulkan for Linux x64 under linux-* ids and nothing for Linux arm64', () => {
    expect(
      parseManifestForPlatform(MANIFEST, 'linux', 'x64')
        .map((b) => b.backend)
        .sort()
    ).toEqual(['linux-cpu-x64', 'linux-vulkan-x64'])
    expect(parseManifestForPlatform(MANIFEST, 'linux', 'arm64')).toEqual([])
  })
  it('returns the arm64 build on Apple Silicon and nothing on an Intel Mac', () => {
    expect(parseManifestForPlatform(MANIFEST, 'macos', 'arm64')).toEqual([
      { version: 'b10205', backend: 'macos-arm64', order: 0 },
    ])
    expect(parseManifestForPlatform(MANIFEST, 'macos', 'x64')).toEqual([])
  })
  it('returns nothing for an unknown OS, a missing tag, or missing assets', () => {
    expect(parseManifestForPlatform(MANIFEST, 'android', 'arm64')).toEqual([])
    expect(parseManifestForPlatform({ tag_name: '', assets: MANIFEST.assets }, 'windows', 'x64')).toEqual([])
    expect(parseManifestForPlatform({ tag_name: 'b1' } as UpstreamManifest, 'windows', 'x64')).toEqual([])
  })
  it('escapes regex metacharacters in the tag', () => {
    const manifest: UpstreamManifest = {
      tag_name: 'b1.0',
      assets: [{ name: 'llama-b1x0-bin-win-cpu-x64.zip' }, { name: 'llama-b1.0-bin-win-cpu-x64.zip' }],
    }
    expect(parseManifestForPlatform(manifest, 'windows', 'x64')).toEqual([
      { version: 'b1.0', backend: 'win-cpu-x64', order: 0 },
    ])
  })
})

describe('withHardTimeout / manifestTransportFromFetch', () => {
  it('passes a value through and rejects a stalled promise', async () => {
    await expect(withHardTimeout(Promise.resolve(1), 50, 'x')).resolves.toBe(1)
    await expect(withHardTimeout(new Promise<never>(() => {}), 5, 'stalled')).rejects.toThrow('stalled')
  })
  it('sends the app headers and aborts the request on timeout', async () => {
    let seenSignal: AbortSignal | undefined
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    }) as unknown as typeof fetch
    const transport = manifestTransportFromFetch('core fetch', fetchImpl)
    await expect(transport.fetch(LLAMACPP_BACKEND_MANIFEST_URL, 5)).rejects.toThrow(
      'core fetch timed out after 5ms'
    )
    expect(seenSignal?.aborted).toBe(true)
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(init.headers).toEqual({ 'Accept': 'application/json', 'User-Agent': 'atomic-chat' })
  })
  it('returns the response when fetch answers in time', async () => {
    const fetchImpl = (async () => jsonResponse(MANIFEST)) as unknown as typeof fetch
    const res = await manifestTransportFromFetch('x', fetchImpl).fetch(LLAMACPP_BACKEND_MANIFEST_URL, 1000)
    expect(res.ok).toBe(true)
  })
})

describe('fetchManifestWithFallbacks', () => {
  it('returns the first transport to answer, with its label', async () => {
    const slow: ManifestTransport = {
      label: 'slow',
      fetch: () => new Promise<Response>((r) => setTimeout(() => r(jsonResponse(MANIFEST)), 30)),
    }
    const winner = await fetchManifestWithFallbacks([
      failingTransport('rust-http1'),
      slow,
      okTransport(MANIFEST, 'webview'),
    ])
    expect(winner.label).toBe('webview')
  })
  it('passes the url and timeout to every transport', async () => {
    const t = okTransport()
    await fetchManifestWithFallbacks([t], 'https://example/manifest.json', 123)
    expect(t.fetch).toHaveBeenCalledWith('https://example/manifest.json', 123)
  })
  it('reports every labelled reason as IO_ERROR when all fail', async () => {
    const err = await fetchManifestWithFallbacks([
      failingTransport('a', 'h2 stall'),
      failingTransport('b', 'dns'),
    ]).catch((e) => e)
    expect(err).toBeInstanceOf(AtomicCoreError)
    expect(err.code).toBe('IO_ERROR')
    expect(err.message).toBe('All manifest fetch attempts failed: a: h2 stall | b: dns')
  })
  it('fails cleanly with no transports and with a synchronously throwing one', async () => {
    await expect(fetchManifestWithFallbacks([])).rejects.toMatchObject({ code: 'IO_ERROR' })
    const sync: ManifestTransport = {
      label: 'sync',
      fetch: () => {
        throw new Error('boom')
      },
    }
    await expect(fetchManifestWithFallbacks([sync])).rejects.toThrow('sync: boom')
  })
})

describe('fetchLiveManifest', () => {
  it('caches only a genuinely successful manifest', async () => {
    const cache = new ManifestSessionCache()
    const info: string[] = []
    const live = await fetchLiveManifest({ transports: [okTransport()], cache, onInfo: (m) => info.push(m) })
    expect(live?.tag_name).toBe('b10205')
    expect(cache.get()).toEqual(MANIFEST)
    expect(info.some((m) => m.includes('succeeded via ok'))).toBe(true)
    expect(info.some((m) => m.includes('differs from the bundled baseline'))).toBe(true)
  })
  it.each([
    ['non-2xx', [{ label: 'x', fetch: async () => jsonResponse({}, 503) }]],
    ['missing tag_name', [okTransport({ assets: [] })]],
    ['unparseable body', [{ label: 'x', fetch: async () => new Response('not json', { status: 200 }) }]],
    ['every transport failing', [failingTransport('a'), failingTransport('b')]],
  ])('returns null and leaves the cache empty on %s', async (_label, transports) => {
    const cache = new ManifestSessionCache()
    const warn: string[] = []
    expect(await fetchLiveManifest({ transports, cache, onWarn: (m) => warn.push(m) })).toBeNull()
    expect(cache.get()).toBeNull()
    expect(warn).toHaveLength(1)
  })
})

describe('fetchRemoteBackends', () => {
  const windows = { osType: 'windows', arch: 'x86_64' }

  it('returns the bundled baseline when every manifest transport fails, without caching it', async () => {
    const cache = new ManifestSessionCache()
    const backends = await fetchRemoteBackends({ ...windows, transports: [failingTransport('a')], cache })
    expect(backends.length).toBeGreaterThan(0)
    expect(backends.every((b) => b.version === BUNDLED_BASELINE_TAG)).toBe(true)
    expect(cache.get()).toBeNull()
  })
  it('follows a manifest tag newer than the bundled baseline', async () => {
    const newerTag = `b${Number(BUNDLED_BASELINE_TAG.slice(1)) + 1}`
    const backends = await fetchRemoteBackends({
      ...windows,
      force: true,
      transports: [
        okTransport({ tag_name: newerTag, assets: [{ name: `llama-${newerTag}-bin-win-cpu-x64.zip` }] }),
      ],
      cache: new ManifestSessionCache(),
    })
    expect(backends).toEqual([{ version: newerTag, backend: 'win-cpu-x64', order: 0 }])
  })
  it('serves a cached manifest without touching the network, and force refetches', async () => {
    const cache = new ManifestSessionCache()
    cache.set(MANIFEST)
    const t = okTransport({ tag_name: 'b99999', assets: [{ name: 'llama-b99999-bin-win-cpu-x64.zip' }] })
    const cached = await fetchRemoteBackends({ ...windows, transports: [t], cache })
    expect(cached.every((b) => b.version === 'b10205')).toBe(true)
    expect(t.fetch).not.toHaveBeenCalled()
    const forced = await fetchRemoteBackends({ ...windows, transports: [t], cache, force: true })
    expect(forced).toEqual([{ version: 'b99999', backend: 'win-cpu-x64', order: 0 }])
    expect(cache.get()?.tag_name).toBe('b99999')
  })
  it('returns the platform catalogs (windows / linux / apple silicon / intel mac / unsupported)', async () => {
    const run = (osType: string, arch: string) =>
      fetchRemoteBackends({ osType, arch, transports: [okTransport()], cache: new ManifestSessionCache() })
    expect((await run('windows', 'x86_64')).map((b) => b.backend).sort()).toEqual([
      'win-cpu-x64',
      'win-cuda-12.4-x64',
      'win-cuda-13.3-x64',
      'win-vulkan-x64',
    ])
    expect((await run('linux', 'x86_64')).map((b) => b.backend).sort()).toEqual([
      'linux-cpu-x64',
      'linux-vulkan-x64',
    ])
    expect(await run('macos', 'arm64')).toEqual([{ version: 'b10205', backend: 'macos-arm64', order: 0 }])
    expect(await run('macos', 'x86_64')).toEqual([])
    expect(await run('android', 'arm64')).toEqual([])
  })
  it('falls back to the baseline on macOS when every transport fails', async () => {
    const backends = await fetchRemoteBackends({
      osType: 'macos',
      arch: 'arm64',
      force: true,
      transports: [{ label: 'x', fetch: async () => jsonResponse({}, 503) }],
      cache: new ManifestSessionCache(),
    })
    expect(backends).toEqual([{ version: BUNDLED_BASELINE_TAG, backend: 'macos-arm64', order: 0 }])
  })
  it('accepts an alternative baseline', async () => {
    const baseline: UpstreamManifest = {
      tag_name: 'b5',
      assets: [{ name: 'llama-b5-bin-macos-arm64.tar.gz' }],
    }
    const backends = await fetchRemoteBackends({
      osType: 'macos',
      arch: 'arm64',
      transports: [failingTransport('x')],
      cache: new ManifestSessionCache(),
      baseline,
    })
    expect(backends).toEqual([{ version: 'b5', backend: 'macos-arm64', order: 0 }])
    expect(BUNDLED_MANIFEST_BASELINE.tag_name).toBe(BUNDLED_BASELINE_TAG)
  })
})
