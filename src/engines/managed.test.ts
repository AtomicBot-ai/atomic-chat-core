import { describe, expect, it } from 'vitest'
import type { BeginOperation, EnvironmentOperation, RuntimeDescriptor } from '../contracts/index.js'
import type { BeginReinstall, InstallationRecord } from '../runtime/environment/index.js'
import { ManagedEngine } from './managed.js'
import type { ManagedEngineDeps } from './managed.js'

const descriptor = (id: string): RuntimeDescriptor =>
  ({
    descriptor_id: id,
    engine_id: 'vllm',
    minimum_app_version: '0.0.0',
    download_bytes: 60e9,
  }) as RuntimeDescriptor

function engine(over: Partial<ManagedEngineDeps> = {}) {
  const reinstalls: BeginReinstall[] = []
  const begun: BeginOperation[] = []
  const deps: ManagedEngineDeps = {
    engine: 'vllm',
    environmentId: 'default',
    platform: 'linux/amd64',
    installations: async () => [
      {
        installation: {
          installation_id: 'vllm',
          engine_id: 'vllm',
          active_descriptor_id: 'vllm-0.31.0-r1',
          status: 'ready',
        },
        platform: 'linux/amd64',
      } as InstallationRecord,
    ],
    newSetup: async () => ({ kind: 'available', descriptor: descriptor('vllm-0.32.0-r1'), source: 'remote' }),
    residentModels: () => [],
    environment: {
      beginReinstall: async (_env, input) => {
        reinstalls.push(input)
        return { operation_id: 'op-1' } as EnvironmentOperation
      },
      planRemoval: async () => ({ plan_digest: `sha256:${'c'.repeat(64)}` }) as never,
      begin: async (_env, input) => {
        begun.push(input)
        return { operation_id: 'op-2' } as EnvironmentOperation
      },
    },
    ...over,
  }
  return { handle: new ManagedEngine(deps), reinstalls, begun }
}

describe('ManagedEngine.update', () => {
  it('begins a reinstall to the offered descriptor and answers its removal', async () => {
    const { handle, reinstalls } = engine()
    expect(await handle.update({ request_id: 'upd-1', app_version: '2.1.0' })).toEqual({
      operation_id: 'op-1',
    })
    expect(reinstalls).toEqual([
      {
        request_id: 'upd-1',
        target: { kind: 'runtime', installation_id: 'vllm', engine_id: 'vllm' },
        descriptor_id: 'vllm-0.32.0-r1',
      },
    ])
  })

  it('answers no-update and starts nothing without an offer', async () => {
    const { handle, reinstalls } = engine({
      newSetup: async () => ({
        kind: 'available',
        descriptor: descriptor('vllm-0.31.0-r1'),
        source: 'cache',
      }),
    })
    expect(await handle.update({ request_id: 'upd-1' })).toEqual({
      updated: false,
      reason: 'no-update',
      active: { version: 'vllm-0.31.0-r1', variant: 'linux/amd64' },
      retired: [],
      kept_in_use: [],
    })
    expect(reinstalls).toEqual([])
  })

  it('refuses a target and a body without request_id', async () => {
    const { handle } = engine()
    await expect(
      handle.update({ request_id: 'u', target: { variant: 'linux/amd64' } } as never)
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(handle.update({ task_id: 't' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('describes the installation as in use while a model of the engine is resident', async () => {
    const { handle } = engine({ residentModels: () => ['Qwen/Qwen3-8B'] })
    expect((await handle.versions({})).builds).toEqual([
      {
        version: 'vllm-0.31.0-r1',
        variant: 'linux/amd64',
        origin: 'managed',
        active: true,
        in_use: true,
        removable: true,
      },
    ])
  })
})

describe('ManagedEngine.remove', () => {
  it('begins the removal with the plan it consents to, keeping the models by default', async () => {
    const { handle, begun } = engine()
    expect(await handle.remove('vllm-0.31.0-r1', 'linux/amd64', {})).toEqual({ operation_id: 'op-2' })
    expect(begun).toEqual([
      {
        request_id: expect.stringMatching(/.+/),
        target: { kind: 'runtime', installation_id: 'vllm', engine_id: 'vllm' },
        kind: 'remove',
        retain_models: true,
        approved_plan_digest: `sha256:${'c'.repeat(64)}`,
      },
    ])
  })

  it('removes the models too when asked', async () => {
    const { handle, begun } = engine()
    await handle.remove('vllm-0.31.0-r1', 'linux/amd64', { retainModels: false })
    expect(begun[0]?.retain_models).toBe(false)
  })

  it('answers removed: false for a release that is not the one installed', async () => {
    const { handle, begun } = engine()
    expect(await handle.remove('vllm-0.30.0-r1', 'linux/amd64', {})).toEqual({ removed: false })
    expect(
      await engine({ installations: async () => [] }).handle.remove('vllm-0.31.0-r1', 'linux/amd64', {})
    ).toEqual({
      removed: false,
    })
    expect(begun).toEqual([])
  })
})
