import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import {
  BACKEND_INSTALL_HEADROOM_BYTES,
  buildWindowsCudartArchiveName,
  friendlyBackendLabel,
  getBackendArchiveName,
  getBackendDownloadUrl,
  getCudaToolkitVersion,
  getCudartArchiveName,
  getCudartDownloadUrl,
  GGML_ORG_DOWNLOAD_BASE,
  LINUX_BACKEND_BY_UPSTREAM_ASSET,
  requiredDiskSpaceForBackend,
  resolveBackendArchiveSource,
  WIN_ROCM_ARCHIVE_BYTES_FALLBACK,
  WIN_ROCM_UNPACKED_BYTES,
} from './archive.js'
import { BUNDLED_MANIFEST_BASELINE } from './bundled-manifest-baseline.js'
import { resolveGpuFamilyConcrete } from './cuda-family.js'
import { parseManifestForPlatform } from './manifest.js'
import type { UpstreamManifest } from '../types.js'

describe('getBackendArchiveName / getBackendDownloadUrl (app backend.test.ts)', () => {
  it('uses upstream ubuntu tarball names for Linux backend archives', () => {
    expect(getBackendArchiveName('b9691', 'linux-vulkan-x64')).toBe(
      'llama-b9691-bin-ubuntu-vulkan-x64.tar.gz'
    )
    expect(getBackendArchiveName('b9691', 'linux-cpu-x64')).toBe('llama-b9691-bin-ubuntu-x64.tar.gz')
    expect(LINUX_BACKEND_BY_UPSTREAM_ASSET['ubuntu-x64']).toBe('linux-cpu-x64')
  })
  it('uses tarballs for macOS and zips for Windows, and strips BOMs', () => {
    expect(getBackendArchiveName('b9702', 'macos-arm64')).toBe('llama-b9702-bin-macos-arm64.tar.gz')
    expect(getBackendArchiveName('b9691', 'win-cpu-x64')).toBe('llama-b9691-bin-win-cpu-x64.zip')
    expect(getBackendArchiveName('\uFEFFb9691', ' win-cpu-x64\uFEFF')).toBe('llama-b9691-bin-win-cpu-x64.zip')
  })
  it('maps supported ids to exact upstream release URLs', () => {
    expect(getBackendDownloadUrl('b10205', 'win-cuda-13.3-x64')).toBe(
      'https://github.com/ggml-org/llama.cpp/releases/download/b10205/llama-b10205-bin-win-cuda-13.3-x64.zip'
    )
    expect(getBackendDownloadUrl('b10205', 'linux-vulkan-x64')).toBe(
      'https://github.com/ggml-org/llama.cpp/releases/download/b10205/llama-b10205-bin-ubuntu-vulkan-x64.tar.gz'
    )
    expect(getBackendDownloadUrl('b9702', 'macos-arm64')).toBe(
      'https://github.com/ggml-org/llama.cpp/releases/download/b9702/llama-b9702-bin-macos-arm64.tar.gz'
    )
  })
  it("rejects the unresolved 'latest' sentinel with INVALID_ARGUMENT", () => {
    expect(() => getBackendDownloadUrl('latest', 'win-cpu-x64')).toThrow("unresolved 'latest' tag")
    try {
      getBackendDownloadUrl('latest', 'win-cpu-x64')
    } catch (err) {
      expect(err).toBeInstanceOf(AtomicCoreError)
      expect((err as AtomicCoreError).code).toBe('INVALID_ARGUMENT')
    }
  })
})

describe('resolveBackendArchiveSource', () => {
  const tag = BUNDLED_MANIFEST_BASELINE.tag_name
  it('uses the signed mirror with hash and size when the manifest lists this exact asset', () => {
    expect(resolveBackendArchiveSource(`\uFEFF${tag}`, 'macos-arm64', BUNDLED_MANIFEST_BASELINE)).toEqual({
      url: `${BUNDLED_MANIFEST_BASELINE.download_base}/${tag}/llama-${tag}-bin-macos-arm64.tar.gz`,
      sha256: '60bd20e22dcaee096da9147f3ab49eee37020191faafd636af398e099930b753',
      size: 11224595,
    })
  })
  it.each([
    ['no manifest', null],
    ['another tag', { ...BUNDLED_MANIFEST_BASELINE, tag_name: 'b1' }],
    ['no download_base', { tag_name: tag, assets: BUNDLED_MANIFEST_BASELINE.assets }],
    [
      'asset without hash',
      { ...BUNDLED_MANIFEST_BASELINE, assets: [{ name: `llama-${tag}-bin-macos-arm64.tar.gz` }] },
    ],
    ['asset missing', { ...BUNDLED_MANIFEST_BASELINE, assets: [] }],
  ])('falls back to the ggml-org CDN without a hash: %s', (_label, manifest) => {
    expect(resolveBackendArchiveSource(tag, 'macos-arm64', manifest as UpstreamManifest | null)).toEqual({
      url: `${GGML_ORG_DOWNLOAD_BASE}/${tag}/llama-${tag}-bin-macos-arm64.tar.gz`,
    })
  })
})

describe('friendlyBackendLabel', () => {
  it.each([
    ['win-cpu-x64', 'CPU'],
    ['linux-cpu-x64', 'CPU'],
    ['win-cuda-13-x64', 'CUDA 13'],
    ['win-cuda-12.4-x64', 'CUDA 12'],
    ['win-rocm-7.14-x64', 'ROCm 7.14 (~1 GB)'],
    ['win-rocm-10.0-x64', 'ROCm 10.0 (~1 GB)'],
    ['win-rocm-x64', 'ROCm (~1 GB)'],
    ['win-vulkan-x64', 'Vulkan'],
    ['macos-arm64', 'Apple Silicon'],
    ['macos-x64', 'Intel'],
    ['something-else', 'something-else'],
  ])('friendlyBackendLabel(%j) = %j', (input, expected) => {
    expect(friendlyBackendLabel(input)).toBe(expected)
  })
})

describe('requiredDiskSpaceForBackend (app backend.test.ts)', () => {
  it('demands room for the archive plus the ~1 GB unpacked HIP tree', () => {
    const archive = 232.9 * 1024 * 1024
    const required = requiredDiskSpaceForBackend('win-rocm-10.0-x64', archive)
    expect(required).toBe(archive + WIN_ROCM_UNPACKED_BYTES + BACKEND_INSTALL_HEADROOM_BYTES)
    expect(required!).toBeGreaterThan(archive + 1072 * 1024 * 1024)
    expect(required!).toBeLessThan(1.6 * 1024 ** 3)
  })
  it('falls back to a measured archive size for an unmirrored tag', () => {
    expect(requiredDiskSpaceForBackend('win-rocm-10.0-x64')).toBe(
      requiredDiskSpaceForBackend('win-rocm-10.0-x64', WIN_ROCM_ARCHIVE_BYTES_FALLBACK)
    )
    expect(requiredDiskSpaceForBackend('win-rocm-10.0-x64', 0)).toBe(
      requiredDiskSpaceForBackend('win-rocm-10.0-x64')
    )
  })
  it('imposes no precondition on the backends that unpack small', () => {
    expect(requiredDiskSpaceForBackend('win-cuda-13.3-x64', 1)).toBeNull()
    expect(requiredDiskSpaceForBackend('win-vulkan-x64', 1)).toBeNull()
    expect(requiredDiskSpaceForBackend('macos-arm64', 1)).toBeNull()
  })
})

describe('cudart companion', () => {
  it('names and locates the companion for Windows CUDA backends only', () => {
    expect(buildWindowsCudartArchiveName('13.3')).toBe('cudart-llama-bin-win-cuda-13.3-x64.zip')
    expect(getCudartArchiveName('win-cuda-12.4-x64')).toBe('cudart-llama-bin-win-cuda-12.4-x64.zip')
    expect(getCudartDownloadUrl('\uFEFFb10205', 'win-cuda-13.3-x64')).toBe(
      `${GGML_ORG_DOWNLOAD_BASE}/b10205/cudart-llama-bin-win-cuda-13.3-x64.zip`
    )
    expect(getCudaToolkitVersion('win-cuda-13.3-x64')).toBe('13.3')
  })
  it.each(['win-vulkan-x64', 'win-cuda-13-x64', 'linux-cpu-x64', 'macos-arm64'])(
    'is null for %s',
    (backend) => {
      expect(getCudartArchiveName(backend)).toBeNull()
      expect(getCudartDownloadUrl('b10205', backend)).toBeNull()
      expect(getCudaToolkitVersion(backend)).toBeNull()
    }
  )
})

// Reference copies of `assetNameFor` and `pickSource` from Atomic-Chat/scripts/resolve-upstream-backend.mjs.
const LINUX_ASSET_INFIX: Record<string, string> = {
  'linux-cpu-x64': 'ubuntu-x64',
  'linux-vulkan-x64': 'ubuntu-vulkan-x64',
}
function scriptAssetNameFor(tag: string, backend: string): string {
  const infix = LINUX_ASSET_INFIX[backend]
  if (infix) return `llama-${tag}-bin-${infix}.tar.gz`
  const extension = backend.startsWith('macos-') ? 'tar.gz' : 'zip'
  return `llama-${tag}-bin-${backend}.${extension}`
}
function scriptPickSource(manifest: UpstreamManifest | null, tag: string, asset: string) {
  const fallback = { url: `${GGML_ORG_DOWNLOAD_BASE}/${tag}/${asset}` }
  if (!manifest || manifest.tag_name !== tag || !manifest.download_base) return fallback
  const entry = (manifest.assets ?? []).find((a) => a.name === asset)
  if (!entry?.sha256 || !entry.size) return fallback
  return { url: `${manifest.download_base}/${tag}/${asset}`, sha256: entry.sha256, size: entry.size }
}

describe('equivalence with scripts/resolve-upstream-backend.mjs (its three usage cases)', () => {
  const manifest = BUNDLED_MANIFEST_BASELINE
  const tag = manifest.tag_name

  it('--backend macos-arm64 (manifest tag, mirrored)', () => {
    const asset = scriptAssetNameFor(tag, 'macos-arm64')
    expect(getBackendArchiveName(tag, 'macos-arm64')).toBe(asset)
    expect(resolveBackendArchiveSource(tag, 'macos-arm64', manifest)).toEqual(
      scriptPickSource(manifest, tag, asset)
    )
  })
  it('--backend win-cuda-13-x64 (family resolved against the manifest, mirrored)', () => {
    const concrete = resolveGpuFamilyConcrete(
      'win-cuda-13-x64',
      parseManifestForPlatform(manifest, 'windows', 'x64')
    )
    const backend = concrete!.split('/')[1]!
    expect(backend).toBe('win-cuda-13.3-x64')
    const asset = scriptAssetNameFor(tag, backend)
    expect(getBackendArchiveName(tag, backend)).toBe(asset)
    expect(resolveBackendArchiveSource(tag, backend, manifest)).toEqual(
      scriptPickSource(manifest, tag, asset)
    )
  })
  it('--backend linux-cpu-x64 --tag b10344 (pinned tag, no manifest → upstream CDN, no hash)', () => {
    const asset = scriptAssetNameFor('b10344', 'linux-cpu-x64')
    expect(getBackendArchiveName('b10344', 'linux-cpu-x64')).toBe(asset)
    expect(resolveBackendArchiveSource('b10344', 'linux-cpu-x64', null)).toEqual(
      scriptPickSource(null, 'b10344', asset)
    )
    expect(resolveBackendArchiveSource('b10344', 'linux-cpu-x64', manifest)).toEqual(
      scriptPickSource(manifest, 'b10344', asset)
    )
  })
  it('agrees on every asset the baseline lists', () => {
    for (const backend of [
      'win-cpu-x64',
      'win-cuda-12.4-x64',
      'win-rocm-10.0-x64',
      'win-vulkan-x64',
      'linux-vulkan-x64',
    ]) {
      const asset = scriptAssetNameFor(tag, backend)
      expect(getBackendArchiveName(tag, backend)).toBe(asset)
      expect(resolveBackendArchiveSource(tag, backend, manifest)).toEqual(
        scriptPickSource(manifest, tag, asset)
      )
    }
  })
})
