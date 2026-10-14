import { describe, expect, it } from 'vitest'
import type { InstallationRecord } from './installations.js'
import { runtimeRemovalPlan } from './runtime-removal-plan.js'
import type { PersistedOperation } from './store.js'

/** A removal is planned from the installation alone, on Linux and Windows (Windows acceptance, 2026-10-13). */
const TARGET = { kind: 'runtime' as const, installation_id: 'tensorrt-llm', engine_id: 'tensorrt-llm' }
const IMAGE = { repository: 'nvcr.io/nvidia/tensorrt-llm/release', digest: `sha256:${'e'.repeat(64)}` }

const installed = (installationId: string, engineId: string, descriptorId: string): InstallationRecord =>
  ({
    installation: {
      installation_id: installationId,
      engine_id: engineId,
      status: 'ready',
      active_descriptor_id: descriptorId,
    },
    image: IMAGE,
  }) as InstallationRecord

const removal = (retainModels?: boolean): PersistedOperation =>
  ({
    request: {
      kind: 'remove',
      target: TARGET,
      ...(retainModels === undefined ? {} : { retain_models: retainModels }),
    },
  }) as PersistedOperation

const storeOf = (records: InstallationRecord[]) => ({
  read: async (id: string) => records.find((entry) => entry.installation.installation_id === id) ?? null,
  list: async () => records,
})

describe('runtimeRemovalPlan', () => {
  it('names the installation’s own descriptor and image, blocks nothing and changes nothing on the system', async () => {
    const plan = await runtimeRemovalPlan({
      record: removal(),
      target: TARGET,
      environmentId: 'default',
      installations: storeOf([installed('tensorrt-llm', 'tensorrt-llm', 'tensorrt-llm-1.3.0rc29-r2')]),
    })

    expect(plan.descriptor_id).toBe('tensorrt-llm-1.3.0rc29-r2')
    expect(plan.image_digest).toBe(IMAGE.digest)
    expect(plan.availability).toBe('supported')
    expect(plan.blockers).toEqual([])
    expect(plan.environment_manifest_id).toBeNull()
    expect(plan.requires_elevation).toBe(false)
    expect(plan.download_bytes).toBeNull()
    expect(plan.system_changes.map((change) => change.code)).toEqual([
      'unload-sessions',
      'remove-containers',
      'remove-image',
      'remove-engine-caches',
      'remove-installation',
    ])
  })

  it('has nothing installed to name when the record is already gone', async () => {
    const plan = await runtimeRemovalPlan({
      record: removal(),
      target: TARGET,
      environmentId: 'default',
      installations: storeOf([]),
    })

    expect(plan.availability).toBe('setup-required')
    expect(plan.descriptor_id).toBeNull()
    expect(plan.system_changes.map((change) => change.code)).toEqual([
      'unload-sessions',
      'remove-containers',
      'remove-installation',
    ])
  })

  it('deletes the store’s models only with the last engine, and the choice is part of the consented plan', async () => {
    const alone = storeOf([installed('tensorrt-llm', 'tensorrt-llm', 'tensorrt-llm-1.3.0rc29-r2')])
    const withVllm = storeOf([
      installed('tensorrt-llm', 'tensorrt-llm', 'tensorrt-llm-1.3.0rc29-r2'),
      installed('vllm', 'vllm', 'vllm-0.31.0-r1'),
    ])
    const plan = (retain: boolean, installations: ReturnType<typeof storeOf>) =>
      runtimeRemovalPlan({ record: removal(retain), target: TARGET, environmentId: 'default', installations })

    const deletes = await plan(false, alone)
    const keeps = await plan(true, alone)
    expect(deletes.system_changes.map((change) => change.code)).toContain('remove-models')
    expect((await plan(false, withVllm)).system_changes.map((change) => change.code)).toContain('keep-models')
    expect(keeps.system_changes.map((change) => change.code)).not.toContain('remove-models')
    expect(deletes.plan_digest).not.toBe(keeps.plan_digest)
  })
})
