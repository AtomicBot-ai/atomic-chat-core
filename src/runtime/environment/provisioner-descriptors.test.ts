import { describe, expect, it } from 'vitest'
import { readRuntimeFixture } from '../../../test/helpers/runtime-fixtures.js'
import type { RuntimeDescriptor } from '../../contracts/index.js'
import { parseRuntimeDescriptor } from './descriptor.js'
import type { RuntimeDescriptorProvider } from './descriptor-provider.js'
import { descriptorForProbe, pinnedDescriptor } from './provisioner-descriptors.js'
import type { PersistedOperation } from './store.js'

const DESCRIPTOR = parseRuntimeDescriptor(readRuntimeFixture('tensorrt-llm.json')) as RuntimeDescriptor
const NEWER = { ...DESCRIPTOR, descriptor_id: 'tensorrt-llm-9.9.9-r1' }

const provider = (
  cached: RuntimeDescriptor[],
  latest: RuntimeDescriptor | null
): RuntimeDescriptorProvider => ({
  forInstallation: async (id) => {
    const found = cached.find((d) => d.descriptor_id === id)
    return found === undefined
      ? { kind: 'unsupported', error: new Error('not cached') as never }
      : { kind: 'available', descriptor: found }
  },
  forNewSetup: async () =>
    latest === null
      ? { kind: 'unsupported', error: Object.assign(new Error('none'), { details: undefined }) as never }
      : { kind: 'available', descriptor: latest },
  cachedForNewSetup: async () => ({ kind: 'available', descriptor: DESCRIPTOR }),
})

const operation = (consented: string | null, requested: string | null): PersistedOperation =>
  ({
    machine: { consented: consented === null ? null : { descriptor_id: consented } },
    requirement_plan: null,
    request: requested === null ? {} : { descriptor_id: requested },
  }) as unknown as PersistedOperation

describe('descriptorForProbe', () => {
  it('after a consent: only the consented descriptor, never a newer one', async () => {
    const answer = await descriptorForProbe(
      provider([DESCRIPTOR, NEWER], NEWER),
      operation(DESCRIPTOR.descriptor_id, null)
    )
    expect(answer).toEqual({ descriptor: DESCRIPTOR })
  })

  it('before one: the requested descriptor when cached, otherwise the newest', async () => {
    expect(
      await descriptorForProbe(provider([DESCRIPTOR], NEWER), operation(null, DESCRIPTOR.descriptor_id))
    ).toEqual({
      descriptor: DESCRIPTOR,
    })
    expect(await descriptorForProbe(provider([], NEWER), operation(null, 'gone'))).toEqual({
      descriptor: NEWER,
    })
  })

  it('none to be had: a blocker naming the missing metadata', async () => {
    const answer = await descriptorForProbe(provider([], null), operation(null, null))
    expect(answer).toMatchObject({
      blocker: { code: 'MANAGED_METADATA_INVALID', reason: 'descriptor-unavailable' },
    })
  })
})

describe('pinnedDescriptor', () => {
  it('answers the consented descriptor, and fails rather than picking another', async () => {
    expect(
      await pinnedDescriptor(provider([DESCRIPTOR], NEWER), operation(DESCRIPTOR.descriptor_id, null))
    ).toBe(DESCRIPTOR)
    await expect(pinnedDescriptor(provider([], NEWER), operation('gone', null))).rejects.toMatchObject({
      code: 'MANAGED_METADATA_INVALID',
    })
    await expect(pinnedDescriptor(provider([], NEWER), operation(null, null))).rejects.toMatchObject({
      code: 'MANAGED_METADATA_INVALID',
    })
  })
})
