/**
 * TensorRT-LLM and vLLM as engines of the `/engines` layer (change `unify-engine-lifecycle`, spec
 * `engine-lifecycle`, "Обновление managed-движка переустановкой"; design D6, D7). A managed engine has
 * one installation, pinned to the descriptor it was set up with; a newer descriptor in conf is offered
 * as a reinstall, which the environment runs as a durable removal (models kept) followed by a setup
 * that asks for consent. There is no update in place: the provisioners do not implement `kind: update`.
 */

import { randomUUID } from 'node:crypto'
import { AtomicCoreError } from '../contracts/index.js'
import type {
  EngineBuildDeleteResult,
  EngineId,
  EngineOperationStarted,
  EngineUpdateRequest,
  EngineUpdateResult,
  EngineVersions,
  EngineVersionsRequest,
} from '../contracts/index.js'
import type {
  EnvironmentService,
  InstallationRecord,
  RuntimeDescriptorProvider,
} from '../runtime/environment/index.js'
import type { EngineHandle, EngineRemoveOptions } from './service.js'
import { managedVersions } from './versions.js'
import type { LatestDescriptor } from './versions.js'

export interface ManagedEngineDeps {
  engine: EngineId
  environmentId: string
  /** The image platform a setup on this host pulls. */
  platform: 'linux/amd64' | 'linux/arm64'
  /** Every installation of this user's environment (shared by both scopes). */
  installations: () => Promise<InstallationRecord[]>
  /** What a fresh setup of the engine would use now (`RuntimeDescriptorProvider.forNewSetup`). */
  newSetup: RuntimeDescriptorProvider['forNewSetup']
  /** The engine's models loaded right now. */
  residentModels: () => readonly string[]
  environment: Pick<EnvironmentService, 'beginReinstall' | 'planRemoval' | 'begin'>
  /** The request id of a removal asked for through `DELETE`, which has no body to carry one. */
  newId?: () => string
}

export class ManagedEngine implements EngineHandle {
  readonly engine: EngineId
  readonly kind = 'managed' as const

  constructor(private readonly deps: ManagedEngineDeps) {
    this.engine = deps.engine
  }

  /** The installation `installation_id` = `engine_id` (the clients' convention), with a pinned descriptor. */
  private async installation(): Promise<InstallationRecord | null> {
    const records = await this.deps.installations()
    return (
      records.find(
        (record) =>
          record.installation.engine_id === this.engine && record.installation.active_descriptor_id !== null
      ) ?? null
    )
  }

  private async latest(): Promise<LatestDescriptor> {
    const result = await this.deps.newSetup(this.engine)
    return result.kind === 'available'
      ? { kind: 'available', descriptor: result.descriptor, source: result.source ?? 'cache' }
      : { kind: 'unavailable', error: result.error }
  }

  versions(request: EngineVersionsRequest): Promise<EngineVersions> {
    return managedVersions(
      {
        engine: this.engine,
        installation: () => this.installation(),
        latest: () => this.latest(),
        inUse: () => this.deps.residentModels().length > 0,
        platform: this.deps.platform,
      },
      request
    )
  }

  /**
   * `POST /engines/:engine/update`: with an offer, the reinstall's removal (`202`); without one,
   * `no-update` and no operation. The call itself is the consent to remove, the setup asks its own.
   */
  async update(request: EngineUpdateRequest): Promise<EngineUpdateResult | EngineOperationStarted> {
    if (!('request_id' in request))
      throw new AtomicCoreError('INVALID_ARGUMENT', `An update of ${this.engine} needs request_id.`)
    if ('target' in request)
      throw new AtomicCoreError(
        'INVALID_ARGUMENT',
        `The core picks the ${this.engine} release; an update takes no target.`
      )
    const entry = await this.versions({ app_version: request.app_version ?? null })
    const target = entry.update.needed ? entry.update.target : null
    if (target === null)
      return { updated: false, reason: 'no-update', active: entry.active, retired: [], kept_in_use: [] }
    const removal = await this.deps.environment.beginReinstall(this.deps.environmentId, {
      request_id: request.request_id,
      target: { kind: 'runtime', installation_id: this.engine, engine_id: this.engine },
      descriptor_id: target.version,
    })
    return { operation_id: removal.operation_id }
  }

  /**
   * `DELETE /engines/:engine/builds/:version/:variant`: the durable removal of the installation, the
   * request itself being the consent (the plan it approves is the one the removal's probe computes).
   * `202` with the operation; a release that is not the one installed is `removed: false`.
   */
  async remove(
    version: string,
    variant: string,
    options: EngineRemoveOptions
  ): Promise<EngineBuildDeleteResult | EngineOperationStarted> {
    const record = await this.installation()
    if (
      record === null ||
      record.installation.active_descriptor_id !== version ||
      record.platform !== variant
    )
      return { removed: false }
    const target = { kind: 'runtime' as const, installation_id: this.engine, engine_id: this.engine }
    const retainModels = options.retainModels ?? true
    const plan = await this.deps.environment.planRemoval(this.deps.environmentId, target, retainModels)
    const removal = await this.deps.environment.begin(this.deps.environmentId, {
      request_id: (this.deps.newId ?? randomUUID)(),
      target,
      kind: 'remove',
      retain_models: retainModels,
      approved_plan_digest: plan.plan_digest,
    })
    return { operation_id: removal.operation_id }
  }
}
