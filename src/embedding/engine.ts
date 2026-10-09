/**
 * Finding a stock llama.cpp `llama-server` new enough for the embedding model: the I/O half of the
 * engine gate, the upstream half of the decision module's (`DecisionEngineResolver.resolveUpstream`).
 *
 * The installed packs of `llamacpp-upstream` are read from its folder directly: any of them may run
 * the embedding model. The release tag is the gate (`orderUpstreamCandidates`): only packs at or above
 * the model's floor, the build the user picked for chat first (it is known to run on this machine),
 * then newest first, GPU before CPU. Readiness has the last word; a pack it refuses, or one that dies
 * while loading, is handed back through `reject` and skipped until the file changes or the owner calls
 * `forgetRejected` (a build was installed, the user asked for a load, the launch settings changed).
 */

import { stat } from 'node:fs/promises'
import { AtomicCoreError } from '../contracts/index.js'
import type { EmbeddingEngineInfo, EmbeddingEngineProvider } from '../contracts/index.js'
import type { DataLayout } from '../config/index.js'
import { resolveBackendExe, scanInstalledBackends } from '../backend/index.js'
import { orderUpstreamCandidates } from '../decision/index.js'
import type { InstalledEnginePack } from '../decision/index.js'

/** The provider whose builds run embedding models. */
export const EMBEDDING_ENGINE_PROVIDER: EmbeddingEngineProvider = 'llamacpp-upstream'

const REFUSED_AT_READINESS = 'refused at readiness'

export interface EmbeddingEngineResolverDeps {
  layout: DataLayout
  platform?: NodeJS.Platform
  /** Every installed pack with its executable. Default: a scan of `<data>/llamacpp-upstream/backends`. */
  listPacks?: () => Promise<InstalledEnginePack[]>
  /** Modification time of a file, `undefined` when it does not exist. */
  mtime?: (path: string) => Promise<number | undefined>
  /**
   * The `llamacpp-upstream` build the user picked (`version_backend`, `b11463/win-vulkan-x64`): tried
   * first when it can run the model (`orderUpstreamCandidates`).
   */
  preferredUpstream?: () => string
  log?: (level: 'info' | 'warn' | 'debug', msg: string) => void
}

const defaultMtime = (path: string): Promise<number | undefined> =>
  stat(path).then(
    (s) => (s.isFile() ? s.mtimeMs : undefined),
    () => undefined
  )

export class EmbeddingEngineResolver {
  /** `exe\0mtime` → why readiness refused it. A replaced file has a new mtime and is tried again. */
  private readonly rejected = new Map<string, string>()
  private readonly platform: NodeJS.Platform

  constructor(private readonly deps: EmbeddingEngineResolverDeps) {
    this.platform = deps.platform ?? process.platform
  }

  /**
   * `enginePath` when given (it only has to exist and not be refused at readiness), otherwise the
   * newest installed pack at or above `minBuild`. `EMBEDDING_ENGINE_UNSUPPORTED` names every pack it
   * tried, and the build to update to.
   */
  async resolve(enginePath: string, minBuild: number): Promise<EmbeddingEngineInfo> {
    if (enginePath !== '') {
      const reason = await this.check(enginePath)
      if (reason === undefined) return { path: enginePath, version_backend: null, provider: null }
      throw new AtomicCoreError(
        'EMBEDDING_ENGINE_UNSUPPORTED',
        'The configured engine cannot run the embedding model.',
        `${enginePath}: ${reason}`
      )
    }
    const { eligible, tooOld } = orderUpstreamCandidates(
      await this.packs(),
      minBuild,
      this.deps.preferredUpstream?.() ?? ''
    )
    const tried: string[] = []
    for (const candidate of eligible) {
      const reason = await this.check(candidate.path)
      if (reason === undefined)
        return {
          path: candidate.path,
          version_backend: candidate.info.version_backend,
          provider: EMBEDDING_ENGINE_PROVIDER,
        }
      tried.push(`${candidate.info.version_backend}: ${reason}`)
    }
    for (const pack of tooOld) tried.push(`${pack.version}/${pack.backend}: older than b${minBuild}`)
    const message =
      eligible.length > 0
        ? `No installed llama.cpp build can run the embedding model: every build at b${minBuild} or newer was ${REFUSED_AT_READINESS}.`
        : minBuild > 0
          ? `No installed llama.cpp build can run the embedding model. Update llama.cpp to b${minBuild} or newer.`
          : 'No llama.cpp build is installed. Install llama.cpp to run the embedding model.'
    throw new AtomicCoreError(
      'EMBEDDING_ENGINE_UNSUPPORTED',
      message,
      tried.length > 0
        ? tried.join('\n')
        : `no llama.cpp build in ${this.deps.layout.provider(EMBEDDING_ENGINE_PROVIDER).backendsDir}`
    )
  }

  /** `exe` started but readiness refused it: skip it in every later `resolve` until the file changes. */
  async reject(exe: string, why: string): Promise<void> {
    const mtime = await (this.deps.mtime ?? defaultMtime)(exe)
    if (mtime === undefined) return
    this.rejected.set(`${exe}\u0000${mtime}`, why)
    this.deps.log?.('debug', `embedding engine ${exe} rejected at readiness: ${why}`)
  }

  /** Every build refused at readiness is tried again by the next `resolve`. */
  forgetRejected(): void {
    if (this.rejected.size === 0) return
    this.rejected.clear()
    this.deps.log?.('debug', 'embedding engines refused at readiness will be tried again')
  }

  /** `undefined` when `exe` may be tried, otherwise why not. */
  private async check(exe: string): Promise<string | undefined> {
    const mtime = await (this.deps.mtime ?? defaultMtime)(exe)
    if (mtime === undefined) return 'no such file'
    const refused = this.rejected.get(`${exe}\u0000${mtime}`)
    return refused === undefined ? undefined : `${REFUSED_AT_READINESS}: ${refused}`
  }

  private async packs(): Promise<InstalledEnginePack[]> {
    if (this.deps.listPacks) return this.deps.listPacks()
    const { layout } = this.deps
    const packs: InstalledEnginePack[] = []
    for (const pack of await scanInstalledBackends(layout, EMBEDDING_ENGINE_PROVIDER, this.platform)) {
      const path = await resolveBackendExe(
        layout,
        EMBEDDING_ENGINE_PROVIDER,
        pack.version,
        pack.backend,
        this.platform
      )
      if (path) packs.push({ version: pack.version, backend: pack.backend, path })
    }
    return packs
  }
}
