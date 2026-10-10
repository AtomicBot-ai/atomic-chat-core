/**
 * sd.cpp and MLX as engines of the `/engines` layer (change `unify-engine-lifecycle`, spec
 * `engine-lifecycle`, "Обновление sd.cpp и MLX"). Nothing new happens underneath: an update is the
 * `engine-builds` install (the build for this host, the checks, activation and cleanup, `download:*`
 * under the task id), answered in the common shape. The core picks the build, so a `target` is refused.
 */

import { AtomicCoreError } from '../contracts/index.js'
import type {
  EngineBuildDeleteResult,
  EngineBuildId,
  EngineBuildKey,
  EngineBuildRef,
  EngineUpdateRequest,
  EngineUpdateResult,
  EngineVersions,
  EngineVersionsRequest,
} from '../contracts/index.js'
import type { EngineBuildsService } from '../engine-builds/index.js'
import type { EngineHandle } from './service.js'
import { engineBuildVersions } from './versions.js'

export interface EngineBuildEngineDeps {
  engine: EngineBuildId
  builds: Pick<EngineBuildsService, 'catalog' | 'checkUpdates' | 'install' | 'remove'>
}

const keyOf = (ref: EngineBuildRef): EngineBuildKey => ({ version: ref.tag, variant: ref.backend_id })

export class EngineBuildEngine implements EngineHandle {
  readonly engine: EngineBuildId
  readonly kind = 'engine-build' as const

  constructor(private readonly deps: EngineBuildEngineDeps) {
    this.engine = deps.engine
  }

  versions(request: EngineVersionsRequest): Promise<EngineVersions> {
    const { builds, engine } = this.deps
    return engineBuildVersions(
      {
        engine,
        catalog: (r) => builds.catalog(engine, r),
        checkUpdates: (r) => builds.checkUpdates(engine, r),
      },
      request
    )
  }

  async update(request: EngineUpdateRequest): Promise<EngineUpdateResult> {
    if (!('task_id' in request))
      throw new AtomicCoreError('INVALID_ARGUMENT', `An update of ${this.engine} needs task_id.`)
    if (request.target !== undefined)
      throw new AtomicCoreError(
        'INVALID_ARGUMENT',
        `The core picks the ${this.engine} build for this computer; an update takes no target.`
      )
    const result = await this.deps.builds.install(this.engine, {
      task_id: request.task_id,
      ...(request.force !== undefined ? { force: request.force } : {}),
      ...(request.proxy !== undefined ? { proxy: request.proxy } : {}),
    })
    if (result.installed)
      return {
        updated: true,
        active: keyOf(result.build),
        retired: result.retired.map(keyOf),
        kept_in_use: result.kept_in_use.map(keyOf),
      }
    // Nothing was installed: the active build is still whichever the core picks.
    const active = (await this.deps.builds.catalog(this.engine, { proxy: request.proxy ?? null })).active
    return {
      updated: false,
      reason: result.reason === 'active-is-newer' ? 'no-update' : 'already-active',
      active: active ? keyOf(active) : null,
      retired: [],
      kept_in_use: [],
    }
  }

  /** Never the active build: judged inside `engine-builds`' load lock, like its other refusals. */
  remove(version: string, variant: string): Promise<EngineBuildDeleteResult> {
    return this.deps.builds.remove(this.engine, version, variant, { refuseActive: true })
  }
}
