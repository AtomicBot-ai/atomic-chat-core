import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { RuntimeDescriptor, RuntimeInstallation } from '../../contracts/index.js'
import { InstallationStore, parseRuntimeDescriptor } from '../environment/index.js'
import type { InstallationRecord } from '../environment/index.js'
import { readRuntimeFixture } from '../../../test/helpers/runtime-fixtures.js'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { containerPlatformFor, resolveReadyInstallation } from './installation.js'

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

/** Records as the setup operation writes them (`InstallationStore`). */
const recordOf = (installation: RuntimeInstallation): InstallationRecord => ({
  schema_version: 1,
  installation,
  image: descriptor.image['linux/amd64'],
  platform: 'linux/amd64',
  installed_at: '2026-09-29T00:00:00.000Z',
})
const store = (list: RuntimeInstallation[]) => ({ list: async () => list.map(recordOf) })

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
    ['arm', null],
    ['ppc64', null],
    ['s390x', null],
    ['riscv64', null],
    // `uname -m` spellings are the setup's (`linux-provisioner.ts`), never `process.arch`'s.
    ['aarch64', null],
    ['x86_64', null],
  ])('%s → %s', (arch, platform) => {
    expect(containerPlatformFor(arch)).toBe(platform)
  })
})

describe('resolveReadyInstallation', () => {
  it("resolves the ready installation to its pinned descriptor and this host's image", async () => {
    const ready = await resolveReadyInstallation({
      installations: store([installation()]),
      descriptors: descriptors(),
      platform: 'linux/arm64',
    })
    expect(ready.installation.installation_id).toBe('trt-1')
    expect(ready.descriptor.descriptor_id).toBe(descriptor.descriptor_id)
    expect(ready.image).toEqual(descriptor.image['linux/arm64'])
  })

  it('prefers a ready installation over one that is not', async () => {
    const ready = await resolveReadyInstallation({
      installations: store([
        installation({ installation_id: 'old', status: 'failed' }),
        installation({ installation_id: 'new' }),
      ]),
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
        installations: store(list),
        descriptors: descriptors(),
        platform: 'linux/amd64',
      })
    ).rejects.toMatchObject({ code: 'MANAGED_ADAPTER_UNAVAILABLE' })
  })

  it("passes on the descriptor provider's own error when the pinned descriptor is no longer cached", async () => {
    await expect(
      resolveReadyInstallation({
        installations: store([installation()]),
        descriptors: descriptors([]),
        platform: 'linux/amd64',
      })
    ).rejects.toMatchObject({ code: 'MANAGED_METADATA_INVALID' })
  })

  it('answers MANAGED_METADATA_INVALID when the pinned descriptor belongs to another engine', async () => {
    const foreign = { ...descriptor, engine_id: 'vllm' }
    await expect(
      resolveReadyInstallation({
        installations: store([installation()]),
        descriptors: descriptors([foreign]),
        platform: 'linux/amd64',
      })
    ).rejects.toMatchObject({ code: 'MANAGED_METADATA_INVALID' })
  })

  it('answers MANAGED_ADAPTER_UNAVAILABLE on a CPU architecture the descriptor has no image for', async () => {
    await expect(
      resolveReadyInstallation({
        installations: store([installation()]),
        descriptors: descriptors(),
        platform: null,
      })
    ).rejects.toMatchObject({ code: 'MANAGED_ADAPTER_UNAVAILABLE' })
  })
})

describe('resolveReadyInstallation over the setup operation’s own store', () => {
  let data: TmpDataFolder
  beforeEach(async () => {
    data = await makeTmpDataFolder('trt-installations-')
  })
  afterEach(() => data.cleanup())

  it('finds the record the setup wrote under the shared root, and skips a torn one', async () => {
    const root = join(data.root, 'managed')
    const installations = new InstallationStore(root)
    await expect(
      resolveReadyInstallation({ installations, descriptors: descriptors(), platform: 'linux/amd64' })
    ).rejects.toMatchObject({ code: 'MANAGED_ADAPTER_UNAVAILABLE' })
    await installations.write(recordOf(installation()))
    await mkdir(join(root, 'installations', 'torn'), { recursive: true })
    await writeFile(join(root, 'installations', 'torn', 'installation.json'), '{"schema_version": 1, ')
    const ready = await resolveReadyInstallation({
      installations,
      descriptors: descriptors(),
      platform: 'linux/amd64',
    })
    expect(ready.installation).toEqual(installation())
  })
})
