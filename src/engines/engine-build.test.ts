import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import type {
  EngineBuildCatalog,
  EngineBuildInstallRequest,
  EngineBuildInstallResult,
  InstalledEngineBuild,
} from '../contracts/index.js'
import { EngineBuildEngine } from './engine-build.js'
import type { EngineBuildEngineDeps } from './engine-build.js'
import { EnginesService } from './service.js'

const ref = (tag: string, origin: 'downloaded' | 'bundled' = 'downloaded') => ({
  tag,
  backend_id: 'macos-arm64',
  origin,
})
const installed = (tag: string, origin: 'downloaded' | 'bundled', active: boolean): InstalledEngineBuild => ({
  ...ref(tag, origin),
  installed_at_ms: null,
  removable: origin === 'downloaded',
  in_use: false,
  active,
})

function builds(result: EngineBuildInstallResult | Error, seen: EngineBuildInstallRequest[] = []) {
  const deps: EngineBuildEngineDeps['builds'] = {
    catalog: async (): Promise<EngineBuildCatalog> => ({
      engine: 'mlx',
      manifest: null,
      manifest_error: null,
      host_backend_id: 'macos-arm64',
      host_reason: null,
      installed: [installed('v1', 'bundled', true)],
      active: installed('v1', 'bundled', true),
    }),
    checkUpdates: async () => ({ update_needed: false, current: null, target: null }),
    install: async (_engine, request) => {
      seen.push(request)
      if (result instanceof Error) throw result
      return result
    },
    remove: async () => ({ removed: true }),
  }
  return deps
}

const service = (deps: EngineBuildEngineDeps['builds']) =>
  new EnginesService({ engines: [new EngineBuildEngine({ engine: 'mlx', builds: deps })] })

describe('updating sd.cpp and MLX through the dispatcher', () => {
  it('installs through engine-builds under the task id and answers in the common shape', async () => {
    const seen: EngineBuildInstallRequest[] = []
    const result = await service(
      builds(
        {
          installed: true,
          build: ref('v2'),
          retired: [ref('v0')],
          kept_in_use: [],
        },
        seen
      )
    ).update('mlx', { task_id: 'engine-update-mlx-v2', force: false })
    expect(result).toEqual({
      updated: true,
      active: { version: 'v2', variant: 'macos-arm64' },
      retired: [{ version: 'v0', variant: 'macos-arm64' }],
      kept_in_use: [],
    })
    expect(seen).toEqual([{ task_id: 'engine-update-mlx-v2', force: false }])
  })

  it('maps already-installed to already-active and active-is-newer to no-update', async () => {
    expect(
      await service(
        builds({
          installed: false,
          reason: 'already-installed',
          build: ref('v1', 'bundled'),
          retired: [],
          kept_in_use: [],
        })
      ).update('mlx', { task_id: 't' })
    ).toEqual({
      updated: false,
      reason: 'already-active',
      active: { version: 'v1', variant: 'macos-arm64' },
      retired: [],
      kept_in_use: [],
    })
    expect(
      await service(
        builds({
          installed: false,
          reason: 'active-is-newer',
          build: ref('v0'),
          retired: [],
          kept_in_use: [],
        })
      ).update('mlx', { task_id: 't' })
    ).toEqual({
      updated: false,
      reason: 'no-update',
      active: { version: 'v1', variant: 'macos-arm64' },
      retired: [],
      kept_in_use: [],
    })
  })

  it('refuses a target: the core picks the build', async () => {
    const seen: EngineBuildInstallRequest[] = []
    await expect(
      service(builds(new Error('unreachable'), seen)).update('mlx', {
        task_id: 't',
        target: { variant: 'macos-arm64' },
      })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(seen).toEqual([])
  })

  it('passes the install refusals through', async () => {
    await expect(
      service(builds(new AtomicCoreError('ENGINE_INSTALL_IN_PROGRESS', 'busy'))).update('mlx', {
        task_id: 't',
      })
    ).rejects.toMatchObject({ code: 'ENGINE_INSTALL_IN_PROGRESS' })
  })

  it('refuses an engine this host does not have, and one that does not exist', async () => {
    const engines = service(builds(new Error('unreachable')))
    await expect(engines.update('sd-cpp', { task_id: 't' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    await expect(engines.update('whisper', { task_id: 't' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })
})

describe('removing an sd.cpp or MLX build through the dispatcher', () => {
  it('removes through engine-builds, refusing the active build there', async () => {
    const seen: unknown[] = []
    const deps = builds(new Error('unused'))
    deps.remove = async (engine, tag, backendId, options) => {
      seen.push([engine, tag, backendId, options])
      return { removed: true }
    }
    expect(await service(deps).remove('mlx', 'v0', 'macos-arm64', {})).toEqual({ removed: true })
    expect(seen).toEqual([['mlx', 'v0', 'macos-arm64', { refuseActive: true }]])
  })
})
