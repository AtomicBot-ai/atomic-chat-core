import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import catalog from '../../test/fixtures/strata/catalog.json' with { type: 'json' }
import manifest from '../../test/fixtures/strata/manifest.json' with { type: 'json' }
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { parseStrataDescriptor } from '../client/index.js'
import { parseStrataManifest, type Build, type StrataVariant } from '../engine-builds/index.js'
import type { StrataHostFacts } from '../runtime/strata/index.js'
import { wireStrata } from './strata.js'

it('checks a descriptor without writing and reports disk, unified memory and platform refusals', async () => {
  const data = await makeTmpDataFolder()
  try {
    const release = parseStrataManifest(manifest, '0.23.6').releases[0]!
    const variant = release.variants[0]!
    const build = { tag: release.release_id, strata: { release, variant } } as Build
    const descriptor = parseStrataDescriptor(Object.values(catalog.models)[0]!.definition)
    const facts: StrataHostFacts = {
      os: 'macos',
      osVersion: '15.4',
      arch: 'arm64',
      ramBytes: 64 * 2 ** 30,
      devices: [
        {
          id: 'apple:0',
          vendor: 'apple',
          architecture: 'apple-gpu',
          memoryBytes: 64 * 2 ** 30,
          unified: true,
        },
      ],
    }
    let freeBytes = 0
    const strata = await wireStrata({
      layout: data.layout,
      platform: 'darwin',
      env: {},
      instanceId: 'check-only',
      builds: () => ({ activeBuild: async () => build }),
      facts: async () => facts,
      availableSpace: async () => freeBytes,
      settings: () => ({}),
      trustedHosts: [],
      claimGpu: async () => {},
      emit: () => {},
    })
    const request = { descriptor }
    expect(await strata.check(request)).toMatchObject({
      verdict: 'insufficient-disk',
      estimates: { download_bytes: descriptor.requirements.download_bytes, ram_bytes: 0, vram_bytes: 0 },
      qualification: descriptor.qualification,
    })
    freeBytes = 128 * 2 ** 30
    facts.devices[0]!.memoryBytes = 8 * 2 ** 30
    expect(await strata.check(request)).toMatchObject({ verdict: 'insufficient-memory' })
    facts.osVersion = '14.9'
    expect(await strata.check(request)).toMatchObject({ verdict: 'platform-unsupported' })
    await expect(lstat(join(data.layout.provider('strata').root, 'prepared'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  } finally {
    await data.cleanup()
  }
})

it('advises about Qwen3.6 CUDA Auto host RAM but still rejects insufficient disk or VRAM', async () => {
  const data = await makeTmpDataFolder()
  try {
    const release = parseStrataManifest(manifest, '0.23.6').releases[0]!
    const descriptor = parseStrataDescriptor(catalog.models['strata-qwen36-ud-q4-k-xl'].definition)
    const variant: StrataVariant = {
      ...release.variants[0]!,
      id: 'windows-x64-cuda13',
      platform: 'windows-x64',
      backend: 'cuda13',
      families: ['qwen36'],
      host: {
        os: 'windows',
        arch: 'x64',
        minimum_os_version: '10',
        cpu_features: [],
        gpu_vendor: 'nvidia',
        gpu_architectures: ['sm_120'],
      },
    }
    const build = { tag: descriptor.engine_release, strata: { release, variant } } as Build
    const facts: StrataHostFacts = {
      os: 'windows',
      arch: 'x64',
      osVersion: '10',
      ramBytes: 30 * 2 ** 30,
      devices: [
        {
          id: 'GPU-test',
          ordinal: 0,
          vendor: 'nvidia',
          architecture: 'sm_120',
          memoryBytes: 24 * 2 ** 30,
          unified: false,
        },
      ],
    }
    let disk = 48 * 2 ** 30
    let memoryMode = 'auto'
    const strata = await wireStrata({
      layout: data.layout,
      platform: 'win32',
      env: {},
      instanceId: 'qwen36-check',
      builds: () => ({ activeBuild: async () => build }),
      facts: async () => facts,
      availableSpace: async () => disk,
      settings: () => ({ memory_mode: memoryMode }),
      trustedHosts: [],
      claimGpu: async () => {},
      emit: () => {},
    })
    const request = { descriptor }
    expect(await strata.check(request)).toMatchObject({
      verdict: 'ok',
      reason: null,
      warnings: expect.arrayContaining([expect.stringContaining('may run out of memory at launch')]),
    })
    memoryMode = 'ram'
    expect(await strata.check(request)).toMatchObject({ verdict: 'insufficient-memory' })
    memoryMode = 'auto'
    facts.devices[0]!.memoryBytes = 6 * 2 ** 30
    expect(await strata.check(request)).toMatchObject({ verdict: 'insufficient-memory' })
    disk = 15 * 2 ** 30
    expect(await strata.check(request)).toMatchObject({
      verdict: 'insufficient-disk',
      reason: expect.stringContaining('15.00 GiB free'),
    })
  } finally {
    await data.cleanup()
  }
})
