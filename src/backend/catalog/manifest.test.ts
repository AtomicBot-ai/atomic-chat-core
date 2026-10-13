import { describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import {
  archSuffixFor,
  fetchManifestWithFallbacks,
  isSupportedBackendOs,
  LLAMACPP_BACKEND_MANIFEST_URL,
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
  })
  it('returns the Windows arm64 catalog: CPU, OpenCL Adreno and CUDA 13 only', () => {
    const manifest: UpstreamManifest = {
      tag_name: 'b11344',
      assets: [
        { name: 'llama-b11344-bin-win-cpu-arm64.zip' },
        { name: 'llama-b11344-bin-win-opencl-adreno-arm64.zip' },
        { name: 'llama-b11344-bin-win-cuda-13.4-arm64.zip' },
        { name: 'llama-b11344-bin-win-cuda-12.4-arm64.zip' },
        { name: 'llama-b11344-bin-win-vulkan-arm64.zip' },
        { name: 'llama-b11344-bin-win-cpu-x64.zip' },
        { name: 'cudart-llama-bin-win-cuda-13.4-arm64.zip' },
      ],
    }
    expect(
      parseManifestForPlatform(manifest, 'windows', 'arm64')
        .map((b) => b.backend)
        .sort()
    ).toEqual(['win-cpu-arm64', 'win-cuda-13.4-arm64', 'win-opencl-adreno-arm64'])
    expect(parseManifestForPlatform(manifest, 'windows', 'x64').map((b) => b.backend)).toEqual([
      'win-cpu-x64',
    ])
  })
  it('returns the Linux arm64 catalog: CPU, Vulkan and CUDA 13, not Snapdragon or x64 CUDA', () => {
    const manifest: UpstreamManifest = {
      tag_name: 'b11344',
      assets: [
        { name: 'llama-b11344-bin-ubuntu-arm64.tar.gz' },
        { name: 'llama-b11344-bin-ubuntu-vulkan-arm64.tar.gz' },
        { name: 'llama-b11344-bin-ubuntu-cuda-13.4-arm64.tar.gz' },
        { name: 'llama-b11344-bin-linux-arm64-snapdragon.tar.gz' },
        { name: 'llama-b11344-bin-ubuntu-cuda-13.4-x64.tar.gz' },
        { name: 'llama-b11344-bin-ubuntu-x64.tar.gz' },
        { name: 'cudart-llama-b11344-bin-ubuntu-cuda-13.4-arm64.tar.gz' },
      ],
    }
    expect(
      parseManifestForPlatform(manifest, 'linux', 'arm64')
        .map((b) => b.backend)
        .sort()
    ).toEqual(['linux-cpu-arm64', 'linux-cuda-13.4-arm64', 'linux-vulkan-arm64'])
    expect(parseManifestForPlatform(manifest, 'linux', 'x64').map((b) => b.backend)).toEqual([
      'linux-cpu-x64',
    ])
  })
  it('returns cpu + vulkan for Linux x64 under linux-* ids and nothing for Linux arm64 without arm64 assets', () => {
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
  it('still reports a reason when the race rejects with something other than an AggregateError', async () => {
    const any = vi.spyOn(Promise, 'any')
    try {
      any.mockRejectedValueOnce(new Error('engine bug'))
      await expect(fetchManifestWithFallbacks([okTransport()])).rejects.toThrow(
        'All manifest fetch attempts failed: engine bug'
      )
      any.mockRejectedValueOnce('a string')
      await expect(fetchManifestWithFallbacks([okTransport()])).rejects.toThrow(
        'All manifest fetch attempts failed: a string'
      )
    } finally {
      any.mockRestore()
    }
  })
})
