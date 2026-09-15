import { describe, expect, it } from 'vitest'
import { BUNDLED_MANIFEST_BASELINE } from './bundled-manifest-baseline.js'
import {
  cudaFamilyMajor,
  gpuFamilyConcreteRe,
  isConcreteOfGpuFamily,
  isGpuFamilyId,
  matchWindowsCudaBackend,
  resolveGpuFamilyConcrete,
  resolveLatestVersionBackend,
  WIN_ROCM_FAMILY_ID,
} from './cuda-family.js'
import { parseManifestForPlatform } from './manifest.js'
import type { UpstreamManifest } from './types.js'

describe('family ids', () => {
  it.each([
    ['win-cuda-13-x64', '13'],
    ['win-cuda-12-x64', '12'],
    ['\uFEFFwin-cuda-12-x64 ', '12'],
    ['win-cuda-13.3-x64', null],
    ['win-rocm-x64', null],
    ['win-vulkan-x64', null],
  ])('cudaFamilyMajor(%j) = %j', (input, expected) => {
    expect(cudaFamilyMajor(input)).toBe(expected)
  })
  it('recognises the CUDA majors and the version-less ROCm id as families', () => {
    expect(isGpuFamilyId('win-cuda-13-x64')).toBe(true)
    expect(isGpuFamilyId(WIN_ROCM_FAMILY_ID)).toBe(true)
    expect(isGpuFamilyId('win-cuda-13.3-x64')).toBe(false)
    expect(gpuFamilyConcreteRe('win-cpu-x64')).toBeNull()
  })
  it('matches concrete ids to their family only', () => {
    expect(isConcreteOfGpuFamily('win-rocm-x64', 'win-rocm-7.14-x64')).toBe(true)
    expect(isConcreteOfGpuFamily('win-cuda-13-x64', 'win-cuda-13.3-x64')).toBe(true)
    expect(isConcreteOfGpuFamily('win-rocm-x64', 'win-cuda-13.3-x64')).toBe(false)
    expect(isConcreteOfGpuFamily('win-cuda-13-x64', 'win-rocm-7.14-x64')).toBe(false)
    expect(isConcreteOfGpuFamily('win-cuda-13-x64', 'win-cuda-12.4-x64')).toBe(false)
    expect(isConcreteOfGpuFamily('win-cuda-13.3-x64', 'win-cuda-13.3-x64')).toBe(false)
  })
  it.each([
    ['win-cuda-13.3-x64', '13.3'],
    ['win-cuda-12.4-x64', '12.4'],
    ['\uFEFFwin-cuda-13.4-x64', '13.4'],
    ['win-cuda-13-x64', null],
    ['win-cuda-11.7-x64', null],
    ['win-vulkan-x64', null],
  ])('matchWindowsCudaBackend(%j) = %j', (input, expected) => {
    expect(matchWindowsCudaBackend(input)).toBe(expected)
  })
})

describe('resolveGpuFamilyConcrete (app backend.test.ts)', () => {
  it('resolves the CUDA 13 family to the newest published minor', () => {
    expect(
      resolveGpuFamilyConcrete('win-cuda-13-x64', [
        { version: 'b9900', backend: 'win-cuda-13.1-x64', order: 0 },
        { version: 'b10205', backend: 'win-cuda-13.3-x64', order: 0 },
        { version: 'b10205', backend: 'win-cuda-12.4-x64', order: 0 },
      ])
    ).toBe('b10205/win-cuda-13.3-x64')
  })
  it('resolves the version-less ROCm family to the published HIP asset', () => {
    expect(
      resolveGpuFamilyConcrete('win-rocm-x64', [
        { version: 'b10405', backend: 'win-rocm-7.14-x64', order: 0 },
        { version: 'b10405', backend: 'win-vulkan-x64', order: 0 },
      ])
    ).toBe('b10405/win-rocm-7.14-x64')
  })
  it('picks the highest HIP version numerically, not lexicographically', () => {
    expect(
      resolveGpuFamilyConcrete('win-rocm-x64', [
        { version: 'b10405', backend: 'win-rocm-7.9-x64', order: 0 },
        { version: 'b10405', backend: 'win-rocm-7.14-x64', order: 0 },
      ])
    ).toBe('b10405/win-rocm-7.14-x64')
    expect(
      resolveGpuFamilyConcrete('win-rocm-x64', [
        { version: 'b10431', backend: 'win-rocm-7.14-x64', order: 0 },
        { version: 'b10809', backend: 'win-rocm-10.0-x64', order: 0 },
      ])
    ).toBe('b10809/win-rocm-10.0-x64')
  })
  it('returns null for a non-family id or an empty catalog', () => {
    expect(
      resolveGpuFamilyConcrete('win-cuda-13.3-x64', [{ version: 'b1', backend: 'win-cuda-13.3-x64' }])
    ).toBeNull()
    expect(resolveGpuFamilyConcrete('win-cuda-13-x64', [])).toBeNull()
  })
})

describe('resolveLatestVersionBackend', () => {
  const remote = [
    { version: 'b10809', backend: 'win-cpu-x64', order: 0 },
    { version: 'b10809', backend: 'win-cuda-13.3-x64', order: 0 },
  ]
  it('prefers an exact id, then the family, then null', () => {
    expect(resolveLatestVersionBackend('win-cpu-x64', remote)).toBe('b10809/win-cpu-x64')
    expect(resolveLatestVersionBackend('win-cuda-13-x64', remote)).toBe('b10809/win-cuda-13.3-x64')
    expect(resolveLatestVersionBackend('win-vulkan-x64', remote)).toBeNull()
  })
})

// Reference copy of `resolveCudaFamily` from Atomic-Chat/scripts/resolve-upstream-backend.mjs so
// the build script can be deleted once the app consumes this module.
function scriptResolveCudaFamily(backend: string, tag: string, assetNames: string[]): string | null {
  const family = /^win-cuda-(\d+)-x64$/.exec(backend)
  if (!family) return backend
  const major = family[1]
  const re = new RegExp(`^llama-${tag}-bin-win-cuda-${major}\\.(\\d+)-x64\\.zip$`)
  let best: number | null = null
  for (const name of assetNames) {
    const match = re.exec(name)
    if (!match) continue
    const minor = Number(match[1])
    if (best === null || minor > best) best = minor
  }
  if (best === null) return null
  return `win-cuda-${major}.${best}-x64`
}

describe('equivalence with scripts/resolve-upstream-backend.mjs resolveCudaFamily', () => {
  const twoMinors: UpstreamManifest = {
    tag_name: 'b20000',
    assets: [
      { name: 'llama-b20000-bin-win-cuda-13.3-x64.zip' },
      { name: 'llama-b20000-bin-win-cuda-13.10-x64.zip' },
      { name: 'llama-b20000-bin-win-cuda-12.4-x64.zip' },
    ],
  }
  it.each([
    ['win-cuda-13-x64', BUNDLED_MANIFEST_BASELINE],
    ['win-cuda-12-x64', BUNDLED_MANIFEST_BASELINE],
    ['win-cuda-13-x64', twoMinors],
    ['win-cuda-12-x64', twoMinors],
  ])('%s resolves to the same concrete id on %o', (backend, manifest) => {
    const assetNames = manifest.assets.map((a) => a.name)
    const expected = scriptResolveCudaFamily(backend, manifest.tag_name, assetNames)
    const ours = resolveGpuFamilyConcrete(backend, parseManifestForPlatform(manifest, 'windows', 'x64'))
    expect(ours?.split('/')[1] ?? null).toBe(expected)
  })
  it('both report nothing when the family has no asset in the tag', () => {
    const manifest: UpstreamManifest = { tag_name: 'b1', assets: [{ name: 'llama-b1-bin-win-cpu-x64.zip' }] }
    expect(scriptResolveCudaFamily('win-cuda-13-x64', 'b1', ['llama-b1-bin-win-cpu-x64.zip'])).toBeNull()
    expect(
      resolveGpuFamilyConcrete('win-cuda-13-x64', parseManifestForPlatform(manifest, 'windows', 'x64'))
    ).toBeNull()
  })
})
