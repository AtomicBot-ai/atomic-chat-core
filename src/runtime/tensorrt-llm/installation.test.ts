import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { RuntimeDescriptor, RuntimeInstallation } from '../../contracts/index.js'
import { parseRuntimeDescriptor } from '../environment/index.js'
import { readRuntimeFixture } from '../../../test/helpers/runtime-fixtures.js'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { containerPlatformFor, listInstallations, resolveReadyInstallation } from './installation.js'

const descriptor = parseRuntimeDescriptor(readRuntimeFixture('tensorrt-llm.json'))

const installation = (over: Partial<RuntimeInstallation> = {}): RuntimeInstallation => ({
  installation_id: 'trt-1',
  engine_id: 'tensorrt-llm',
  environment_id: 'default',
  active_descriptor_id: descriptor.descriptor_id,
  candidate_descriptor_id: null,
  availability: 'supported',
  status: 'ready',
  ...over,
})

const descriptors = (known: RuntimeDescriptor[] = [descriptor]) => ({
  forInstallation: async (id: string) => {
    const found = known.find((d) => d.descriptor_id === id)
    return found
      ? ({ kind: 'available', descriptor: found } as const)
      : ({
          kind: 'unsupported',
          error: new AtomicCoreError('MANAGED_METADATA_INVALID', 'not cached', id),
        } as const)
  },
})

describe('containerPlatformFor', () => {
  it.each([
    ['x64', 'linux/amd64'],
    ['arm64', 'linux/arm64'],
    ['ia32', null],
  ])('%s → %s', (arch, platform) => {
    expect(containerPlatformFor(arch)).toBe(platform)
  })
})

describe('resolveReadyInstallation', () => {
  it("resolves the ready installation to its pinned descriptor and this host's image", async () => {
    const ready = await resolveReadyInstallation({
      installations: async () => [installation()],
      descriptors: descriptors(),
      platform: 'linux/arm64',
    })
    expect(ready.installation.installation_id).toBe('trt-1')
    expect(ready.descriptor.descriptor_id).toBe(descriptor.descriptor_id)
    expect(ready.image).toEqual(descriptor.image['linux/arm64'])
  })

  it('prefers a ready installation over one that is not', async () => {
    const ready = await resolveReadyInstallation({
      installations: async () => [
        installation({ installation_id: 'old', status: 'failed' }),
        installation({ installation_id: 'new' }),
      ],
      descriptors: descriptors(),
      platform: 'linux/amd64',
    })
    expect(ready.installation.installation_id).toBe('new')
  })

  it.each<[string, RuntimeInstallation[]]>([
    ['no installation at all', []],
    ['one still installing', [installation({ status: 'installing', active_descriptor_id: null })]],
    ['one of another engine', [installation({ engine_id: 'vllm' })]],
    ['a ready one with no pinned descriptor', [installation({ active_descriptor_id: null })]],
  ])('answers MANAGED_ADAPTER_UNAVAILABLE for %s', async (_label, list) => {
    await expect(
      resolveReadyInstallation({
        installations: async () => list,
        descriptors: descriptors(),
        platform: 'linux/amd64',
      })
    ).rejects.toMatchObject({ code: 'MANAGED_ADAPTER_UNAVAILABLE' })
  })

  it("passes on the descriptor provider's own error when the pinned descriptor is no longer cached", async () => {
    await expect(
      resolveReadyInstallation({
        installations: async () => [installation()],
        descriptors: descriptors([]),
        platform: 'linux/amd64',
      })
    ).rejects.toMatchObject({ code: 'MANAGED_METADATA_INVALID' })
  })

  it('answers MANAGED_METADATA_INVALID when the pinned descriptor belongs to another engine', async () => {
    const foreign = { ...descriptor, engine_id: 'vllm' }
    await expect(
      resolveReadyInstallation({
        installations: async () => [installation()],
        descriptors: descriptors([foreign]),
        platform: 'linux/amd64',
      })
    ).rejects.toMatchObject({ code: 'MANAGED_METADATA_INVALID' })
  })

  it('answers MANAGED_ADAPTER_UNAVAILABLE on a CPU architecture the descriptor has no image for', async () => {
    await expect(
      resolveReadyInstallation({
        installations: async () => [installation()],
        descriptors: descriptors(),
        platform: null,
      })
    ).rejects.toMatchObject({ code: 'MANAGED_ADAPTER_UNAVAILABLE' })
  })
})

describe('listInstallations', () => {
  let data: TmpDataFolder
  beforeEach(async () => {
    data = await makeTmpDataFolder('trt-installations-')
  })
  afterEach(() => data.cleanup())

  it('reads every installation record under the shared root and skips what it cannot read', async () => {
    const root = join(data.root, 'managed')
    const write = async (id: string, text: string) => {
      await mkdir(join(root, 'installations', id), { recursive: true })
      await writeFile(join(root, 'installations', id, 'installation.json'), text)
    }
    await write('trt-1', JSON.stringify({ schema_version: 1, installation: installation() }))
    await write('torn', '{"schema_version": 1, "installation": ')
    await write('foreign', JSON.stringify({ schema_version: 2, installation: installation() }))
    expect(await listInstallations(root)).toEqual([installation()])
    expect(await listInstallations(join(data.root, 'nothing-here'))).toEqual([])
  })
})
