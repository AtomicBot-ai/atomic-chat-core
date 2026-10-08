/**
 * One llama.cpp provider as an engine of the `/engines` layer (change `unify-engine-lifecycle`, spec
 * `engine-lifecycle`, "Обновление llama.cpp применяет core"; design D3, D5). The desktop's three
 * extensions used to apply an update themselves; the core does it now, in this order:
 *
 *   1. install the target pack, under the caller's task id — before the lock: the download is long
 *      and the models keep running meanwhile;
 *   2. in the load queue's turn, write `version_backend` (clients get `settings:changed`), so the
 *      next load, the desktop's automatic reload included, starts from the new pack;
 *   3. unload the provider's sessions, as an ordinary unload would;
 *   4. delete the other versions of the same variant, but not the installer's pack and not one
 *      something still runs from (`kept_in_use`);
 *   5. `engine:changed {reason: update}`.
 *
 * A failure or a cancel before step 2 changes nothing: the pack moves into place only once complete,
 * and the setting still names the old one. The whole update holds the provider's operation slot, so
 * a second update, an activation or a removal of the same provider is `ENGINE_INSTALL_IN_PROGRESS`.
 */

import { AtomicCoreError } from '../contracts/index.js'
import type {
  CoreEvents,
  EngineActivateResult,
  EngineBuildDeleteResult,
  EngineBuildKey,
  EngineSwapUpdateRequest,
  EngineUpdateRequest,
  EngineUpdateResult,
  EngineVersions,
  EngineVersionsRequest,
  LlamacppProviderId,
} from '../contracts/index.js'
import type { BackendAdvisor, BackendOperation, BackendService } from '../backend/index.js'
import { DOWNLOAD_CANCELLED } from '../downloads/index.js'
import type { EngineHandle } from './service.js'
import { llamacppVersions } from './versions.js'

export interface LlamacppEngineDeps {
  engine: LlamacppProviderId
  backends: Pick<
    BackendService,
    | 'operate'
    | 'install'
    | 'exclusive'
    | 'listInstalled'
    | 'bundledPack'
    | 'busyChecker'
    | 'retireOthers'
    | 'remove'
  >
  advisor: Pick<BackendAdvisor, 'catalog' | 'checkUpdates'>
  /** The provider's `version_backend` in the core's settings. */
  currentVersionBackend: () => string
  /** Write `version_backend`; the settings store publishes `settings:changed`. */
  selectVersionBackend: (versionBackend: string) => Promise<void>
  /** Unload every session of this provider through the facade, the way a client's unload goes. */
  unloadSessions: () => Promise<void>
  emit: (name: 'engine:changed', payload: CoreEvents['engine:changed']) => void
  /** A pack was downloaded: the decision and embedding models may now find a build to run on. */
  onInstalled?: (installed: boolean) => void
  log?: (level: 'info' | 'warn', message: string) => void
}

const keyOf = (pack: { version: string; backend: string }): EngineBuildKey => ({
  version: pack.version,
  variant: pack.backend,
})

function parseKey(versionBackend: string): EngineBuildKey | null {
  const [version, variant, ...rest] = versionBackend.trim().split('/')
  if (!version || !variant || rest.length > 0 || version === 'latest' || version === 'none') return null
  return { version, variant }
}

/**
 * The downloader speaks in message strings; this surface speaks in codes, like `engine-builds`. The
 * message stays as it was: the app reads the disk tags (`[disk_full]` …) out of it.
 */
function installError(error: unknown): AtomicCoreError {
  if (error instanceof AtomicCoreError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (message === DOWNLOAD_CANCELLED)
    return new AtomicCoreError('CANCELLED', 'The engine update was cancelled.')
  return new AtomicCoreError('ENGINE_INSTALL_FAILED', message)
}

export class LlamacppEngine implements EngineHandle {
  readonly engine: LlamacppProviderId
  readonly kind = 'llamacpp' as const

  constructor(private readonly deps: LlamacppEngineDeps) {
    this.engine = deps.engine
  }

  versions(request: EngineVersionsRequest): Promise<EngineVersions> {
    const { deps } = this
    // One look at what runs, for every pack of this answer.
    let busy: ReturnType<typeof deps.backends.busyChecker> | undefined
    return llamacppVersions(
      {
        engine: deps.engine,
        current: deps.currentVersionBackend,
        checkUpdates: (r) => deps.advisor.checkUpdates(r),
        catalog: (r) => deps.advisor.catalog(r),
        listInstalled: (current) => deps.backends.listInstalled(current),
        bundledPack: () => deps.backends.bundledPack(),
        inUse: async (version, backend) => (await (busy ??= deps.backends.busyChecker()))(version, backend),
      },
      request
    )
  }

  /** `POST /engines/:engine/update`. Answers once applied, which can take as long as the download. */
  async update(request: EngineUpdateRequest): Promise<EngineUpdateResult> {
    if (!('task_id' in request))
      throw new AtomicCoreError('INVALID_ARGUMENT', `An update of ${this.engine} needs task_id.`)
    return this.deps.backends.operate('update', (operation) => this.updateHeld(request, operation))
  }

  private async updateHeld(
    request: EngineSwapUpdateRequest,
    operation: BackendOperation
  ): Promise<EngineUpdateResult> {
    const active = parseKey(this.deps.currentVersionBackend())
    const unchanged = (reason: 'no-update' | 'already-active'): EngineUpdateResult => ({
      updated: false,
      reason,
      active,
      retired: [],
      kept_in_use: [],
    })
    const target = await this.target(request)
    if (target === null) return unchanged('no-update')
    if (active !== null && active.version === target.version && active.variant === target.variant)
      return unchanged('already-active')

    let installed: boolean
    try {
      installed = (
        await this.deps.backends.install(target.version, target.variant, {
          taskId: request.task_id,
          ...(request.force !== undefined ? { force: request.force } : {}),
          ...(request.proxy !== undefined ? { proxy: request.proxy } : {}),
          operation,
        })
      ).installed
    } catch (error) {
      throw installError(error)
    }
    this.deps.onInstalled?.(installed)

    const { retired, kept } = await this.deps.backends.exclusive(async () => {
      await this.deps.selectVersionBackend(`${target.version}/${target.variant}`)
      await this.unload()
      return this.deps.backends.retireOthers({ version: target.version, backend: target.variant }, operation)
    })
    this.deps.emit('engine:changed', { engine: this.engine, reason: 'update' })
    return { updated: true, active: target, retired: retired.map(keyOf), kept_in_use: kept.map(keyOf) }
  }

  /**
   * `POST /engines/:engine/builds/:version/:variant/activate` (design D11): steps 2, 3 and 5 of an
   * update — write `version_backend` and unload the provider's sessions in the load queue's turn, then
   * `engine:changed {reason: activate}` — with nothing downloaded and nothing removed. Under the same
   * operation slot as an update, so the two never race on the setting.
   */
  activate(version: string, variant: string): Promise<EngineActivateResult> {
    const target = { version, variant }
    return this.deps.backends.operate('activate', async () => {
      const active = parseKey(this.deps.currentVersionBackend())
      if (active !== null && active.version === version && active.variant === variant)
        return { activated: false, reason: 'already-active', active: target }
      const packs = await this.deps.backends.listInstalled()
      if (!packs.some((pack) => pack.version === version && pack.backend === variant))
        throw new AtomicCoreError(
          'INVALID_REQUEST',
          `${version}/${variant} is not installed.`,
          'not-installed'
        )
      await this.deps.backends.exclusive(async () => {
        await this.deps.selectVersionBackend(`${version}/${variant}`)
        await this.unload()
      })
      this.deps.emit('engine:changed', { engine: this.engine, reason: 'activate' })
      return { activated: true, active: target }
    })
  }

  /**
   * `DELETE /engines/:engine/builds/:version/:variant`: in the load queue's turn, so it waits for a load
   * in flight; never the active pack (`INVALID_REQUEST`, `active`), the installer's (`bundled`) or one
   * something runs from (`BACKEND_IN_USE`).
   */
  async remove(version: string, variant: string): Promise<EngineBuildDeleteResult> {
    // `engine:changed {reason: uninstall}` comes from the backend service, for this route and `/backends`.
    const removed = await this.deps.backends.remove(version, variant, this.deps.currentVersionBackend, {
      refuseActiveAs: 'INVALID_REQUEST',
    })
    return { removed }
  }

  /**
   * The build to move to: the offer of the update check; an explicit `<version>/<variant>` (no family
   * check: the client chose); or only a variant — the newest of it in the provider's catalog.
   */
  private async target(request: EngineSwapUpdateRequest): Promise<EngineBuildKey | null> {
    const current = this.deps.currentVersionBackend().trim()
    const common = {
      force: request.force ?? false,
      app_version: request.app_version ?? null,
      proxy: request.proxy ?? null,
    }
    if (request.target === undefined) {
      const check = await this.deps.advisor.checkUpdates({ current, ...common })
      return check.offer ? parseKey(check.offer) : null
    }
    const { version, variant } = request.target
    if (version !== undefined) return { version, variant }
    const catalog = await this.deps.advisor.catalog({ current_backend: current, ...common })
    const newest = catalog.available.find((entry) => entry.backend === variant)
    if (newest === undefined)
      throw new AtomicCoreError(
        'BACKEND_TAG_UNRESOLVED',
        `The ${this.engine} catalog has no ${variant} build for this computer.`,
        variant
      )
    return { version: newest.version, variant }
  }

  /**
   * The switch is already written when this runs: a session that does not stop keeps its old pack in
   * use (and on disk, through `kept_in_use`), and the answer still says the update applied.
   */
  private async unload(): Promise<void> {
    try {
      await this.deps.unloadSessions()
    } catch (error) {
      this.deps.log?.('warn', `${this.engine}: a session did not unload after the switch: ${String(error)}`)
    }
  }
}
