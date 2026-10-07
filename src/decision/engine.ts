/**
 * Finding a `llama-server` that serves `--decision`: the I/O half of the engine gate.
 *
 * The gate has three steps, cheapest first. The release tag orders the installed packs
 * (`engine-candidates.ts`); `llama-server -h` must list `--decision` (the same probe the llama.cpp
 * runtime uses for `draft-dflash`, `checkSpecTypeSupport`); and once the process runs,
 * `/props.decision.api_version` must be 1 (`readiness.ts`). Only the first passing pack is used; a
 * pack that passed `-h` but failed readiness is handed back through `reject` and skipped, so the next
 * `resolve` finds a valid lower-ranked build (a newer tag on API version 2, a dev build with an
 * unfinished decision API). The skip lasts until the file changes or the owner calls
 * `forgetRejected` (a build was installed, the user asked for a load, the launch settings changed):
 * a refusal can depend on the launch (the spec, the model), and a user who asks again gets a real
 * second try.
 *
 * The packs are read from the TurboQuant provider's folder directly, not through the provider's
 * settings: which provider runs chat has nothing to do with which binary can run the decision model.
 * Probe results are remembered per executable, modification time and flag, so a start after an idle
 * unload does not pay for `-h` again, and a pack replaced by an update is probed afresh.
 *
 * A checkpoint folder needs one more flag, `--decision-convert-cache`: a build from before the
 * converter lists `--decision` but fails the load of a folder with `MODEL_LOAD_FAILED`, and the
 * search would never reach a build that can run it.
 *
 * An upstream decision GGUF (`<arch>.decision.type`, `dialect: 'upstream'`) is run by the stock
 * llama.cpp provider instead. Upstream has no flag to probe, so its gate is the build number in the
 * tag (`upstream-version.ts`): only packs at or above the model's floor are tried, newest first, and
 * readiness (`/v1/models` lists `decisions`) has the last word, with the same `reject` skip.
 */

import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AtomicCoreError } from '../contracts/index.js'
import type { DecisionDialect, DecisionEngineInfo, DecisionEngineProvider } from '../contracts/index.js'
import type { DataLayout } from '../config/index.js'
import { resolveBackendExe, scanInstalledBackends } from '../backend/index.js'
import { checkSpecTypeSupport } from '../runtime/llamacpp/index.js'
import { buildProcessEnv, discoverCudaPaths, nodeCudaProbeEnv } from '../runtime/shared/index.js'
import { orderEngineCandidates, orderUpstreamCandidates } from './engine-candidates.js'
import type { InstalledEnginePack } from './engine-candidates.js'
import { UPSTREAM_DECISION_MIN_BUILD } from './upstream-version.js'

/** The flag the `-h` output must contain. */
export const DECISION_FLAG = '--decision'
/** The flag a build that can convert a checkpoint folder (`-m DIR`) lists as well. */
export const DECISION_CONVERT_FLAG = '--decision-convert-cache'

export interface EngineRequirements {
  /** The engine the model needs; default `turboquant`. */
  dialect?: DecisionDialect
  /** The model is a checkpoint folder: the build must also list `DECISION_CONVERT_FLAG`. */
  checkpointDir?: boolean
  /** Upstream only: the oldest build that serves the model (`upstreamMinBuild`). */
  minBuild?: number
}

const REFUSED_AT_READINESS = 'refused at readiness'

/** The TurboQuant provider: the one whose builds serve `--decision` and the router. */
export const DECISION_ENGINE_PROVIDER = 'llamacpp' as const
/** The stock llama.cpp provider: its builds from b11370 on serve upstream decision GGUFs. */
export const UPSTREAM_DECISION_ENGINE_PROVIDER = 'llamacpp-upstream' as const
/** Every provider an install of which may let a decision model start. */
export const DECISION_ENGINE_PROVIDERS: readonly DecisionEngineProvider[] = [
  DECISION_ENGINE_PROVIDER,
  UPSTREAM_DECISION_ENGINE_PROVIDER,
]

export interface EngineResolverDeps {
  layout: DataLayout
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Every installed pack of `provider` with its executable. Default: a scan of `<data>/<provider>/backends`. */
  listPacks?: (provider: DecisionEngineProvider) => Promise<InstalledEnginePack[]>
  /** Whether `exe -h` lists `flag` (`DECISION_FLAG`, `DECISION_CONVERT_FLAG`); rejects when the probe could not run. */
  probe?: (exe: string, flag: string) => Promise<boolean>
  /** Modification time of a file, `undefined` when it does not exist. */
  mtime?: (path: string) => Promise<number | undefined>
  log?: (level: 'info' | 'warn' | 'debug', msg: string) => void
}

const defaultMtime = (path: string): Promise<number | undefined> =>
  stat(path).then(
    (s) => (s.isFile() ? s.mtimeMs : undefined),
    () => undefined
  )

export class DecisionEngineResolver {
  private readonly probed = new Map<string, boolean>()
  /** `exe\0mtime` → why readiness refused it. A replaced file has a new mtime and is tried again. */
  private readonly rejected = new Map<string, string>()
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv

  constructor(private readonly deps: EngineResolverDeps) {
    this.platform = deps.platform ?? process.platform
    this.env = deps.env ?? process.env
  }

  /**
   * The engine to run: `enginePath` when given (it must still pass the probe), otherwise the first
   * installed pack that does. `DECISION_ENGINE_UNSUPPORTED` names every pack it tried and why.
   */
  async resolve(enginePath = '', needs: EngineRequirements = {}): Promise<DecisionEngineInfo> {
    if (needs.dialect === 'upstream')
      return this.resolveUpstream(enginePath, needs.minBuild ?? UPSTREAM_DECISION_MIN_BUILD)
    const flags = needs.checkpointDir ? [DECISION_FLAG, DECISION_CONVERT_FLAG] : [DECISION_FLAG]
    if (enginePath !== '') {
      const reason = await this.check(enginePath, flags)
      if (reason === undefined) return explicitEngine(enginePath, 'turboquant')
      throw new AtomicCoreError(
        'DECISION_ENGINE_UNSUPPORTED',
        'The configured engine does not serve the decision model.',
        `${enginePath}: ${reason}`
      )
    }
    const packs = await this.packsOf(DECISION_ENGINE_PROVIDER)
    const tried: string[] = []
    let refusedAtReadiness = 0
    for (const candidate of orderEngineCandidates(packs)) {
      const reason = await this.check(candidate.path, flags)
      if (reason === undefined) return candidate.info
      if (reason.startsWith(REFUSED_AT_READINESS)) refusedAtReadiness++
      tried.push(`${candidate.info.version_backend}: ${reason}`)
    }
    // A build that lists `--decision` and was refused at readiness is already 1.7.0-like: telling the
    // user to install 1.7.0 would send them after what they have.
    throw new AtomicCoreError(
      'DECISION_ENGINE_UNSUPPORTED',
      refusedAtReadiness > 0
        ? `No installed engine build can run the decision model: ${refusedAtReadiness} that list${refusedAtReadiness === 1 ? 's' : ''} ${DECISION_FLAG} ${refusedAtReadiness === 1 ? 'was' : 'were'} ${REFUSED_AT_READINESS}, not serving decision API version 1.`
        : 'No installed engine build can run the decision model. Install TurboQuant 1.7.0 or newer.',
      tried.length > 0
        ? tried.join('\n')
        : `no TurboQuant build in ${this.deps.layout.provider(DECISION_ENGINE_PROVIDER).backendsDir}`
    )
  }

  /**
   * An upstream decision GGUF: `enginePath` when given (it only has to exist, and not be refused at
   * readiness), otherwise the newest installed upstream pack at or above `minBuild`. Older packs are
   * named in the error, which tells the user which build to update to.
   */
  private async resolveUpstream(enginePath: string, minBuild: number): Promise<DecisionEngineInfo> {
    if (enginePath !== '') {
      const reason = await this.check(enginePath, [])
      if (reason === undefined) return explicitEngine(enginePath, 'upstream')
      throw new AtomicCoreError(
        'DECISION_ENGINE_UNSUPPORTED',
        'The configured engine does not serve the decision model.',
        `${enginePath}: ${reason}`
      )
    }
    const { eligible, tooOld } = orderUpstreamCandidates(
      await this.packsOf(UPSTREAM_DECISION_ENGINE_PROVIDER),
      minBuild
    )
    const tried: string[] = []
    for (const candidate of eligible) {
      const reason = await this.check(candidate.path, [])
      if (reason === undefined) return candidate.info
      tried.push(`${candidate.info.version_backend}: ${reason}`)
    }
    for (const pack of tooOld) tried.push(`${pack.version}/${pack.backend}: older than b${minBuild}`)
    throw new AtomicCoreError(
      'DECISION_ENGINE_UNSUPPORTED',
      eligible.length > 0
        ? `No installed llama.cpp build can run the decision model: every build at b${minBuild} or newer was ${REFUSED_AT_READINESS}.`
        : `No installed llama.cpp build can run the decision model. Update llama.cpp to b${minBuild} or newer.`,
      tried.length > 0
        ? tried.join('\n')
        : `no llama.cpp build in ${this.deps.layout.provider(UPSTREAM_DECISION_ENGINE_PROVIDER).backendsDir}`
    )
  }

  /**
   * `exe` started and passed `-h`, but readiness refused it: skip it in every later `resolve` until
   * the file changes. A file that is gone is not remembered.
   */
  async reject(exe: string, why: string): Promise<void> {
    const mtime = await (this.deps.mtime ?? defaultMtime)(exe)
    if (mtime === undefined) return
    this.rejected.set(`${exe}\u0000${mtime}`, why)
    this.deps.log?.('debug', `decision engine ${exe} rejected at readiness: ${why}`)
  }

  /** Every build refused at readiness is tried again by the next `resolve`. */
  forgetRejected(): void {
    if (this.rejected.size === 0) return
    this.rejected.clear()
    this.deps.log?.('debug', 'decision engines refused at readiness will be tried again')
  }

  /** `undefined` when `exe` lists every one of `flags`, otherwise why not. */
  private async check(exe: string, flags: readonly string[]): Promise<string | undefined> {
    const mtime = await (this.deps.mtime ?? defaultMtime)(exe)
    if (mtime === undefined) return 'no such file'
    const key = `${exe}\u0000${mtime}`
    const refused = this.rejected.get(key)
    if (refused !== undefined) return `${REFUSED_AT_READINESS}: ${refused}`
    const probe = this.deps.probe ?? ((path: string, flag: string) => this.probeHelp(path, flag))
    for (const flag of flags) {
      const flagKey = `${key}\u0000${flag}`
      let supported = this.probed.get(flagKey)
      if (supported === undefined) {
        try {
          supported = await probe(exe, flag)
        } catch (error) {
          // A probe that could not run is not remembered: the next start tries again.
          return `probe failed: ${error instanceof Error ? error.message : String(error)}`
        }
        this.probed.set(flagKey, supported)
        this.deps.log?.('debug', `decision probe ${exe}: ${supported ? 'lists' : 'no'} ${flag}`)
      }
      if (!supported) return `${flag} is not in its -h output`
    }
    return undefined
  }

  private async probeHelp(exe: string, flag: string): Promise<boolean> {
    const { env, cwd } = buildProcessEnv({
      platform: this.platform,
      baseEnv: this.env,
      exeDir: dirname(exe),
      cuda: discoverCudaPaths(nodeCudaProbeEnv(this.platform, this.env)),
      userEnv: {},
    })
    return checkSpecTypeSupport(exe, flag, env, cwd)
  }

  private packsOf(provider: DecisionEngineProvider): Promise<InstalledEnginePack[]> {
    return this.deps.listPacks ? this.deps.listPacks(provider) : this.scan(provider)
  }

  private async scan(provider: DecisionEngineProvider): Promise<InstalledEnginePack[]> {
    const { layout } = this.deps
    const packs: InstalledEnginePack[] = []
    for (const pack of await scanInstalledBackends(layout, provider, this.platform)) {
      const path = await resolveBackendExe(layout, provider, pack.version, pack.backend, this.platform)
      if (path) packs.push({ version: pack.version, backend: pack.backend, path })
    }
    return packs
  }
}

/** An explicit `engine_path`: nothing is known about it but the file and the dialect it is started for. */
function explicitEngine(path: string, dialect: DecisionDialect): DecisionEngineInfo {
  return { path, version_backend: null, fork_version: null, version_gate: null, dialect, provider: null }
}
