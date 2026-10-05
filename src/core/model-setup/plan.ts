/**
 * The model-setup plan, pure: given the compatibility verdict, the conf rule (when one matched), the
 * Hub's file facts, the Prism manifest and this machine, what a setup would download and install,
 * how many bytes that is, and what blocks it. `digest` hashes exactly what decides the work, so a
 * start computed against an older plan is refused as stale instead of doing something else.
 */

import type {
  EngineCapability,
  LocalProviderId,
  ModelCompatibilityResponse,
  ModelSetupArtifact,
  ModelSetupBlocker,
  ModelSetupEngine,
  ModelSetupPlan,
  ModelSetupPlanRequest,
} from '../../contracts/index.js'
import {
  determineBestPrismBackend,
  determinePrismSupportedBackends,
  filterPrismBackendsBySupport,
  findPrismRelease,
  prismArchiveSources,
  prismCatalogToBackends,
  prismTagBuild,
} from '../../backend/index.js'
import type { BackendFeatures, GpuProbeInfo, PrismManifest, PrismOfferOptions } from '../../backend/index.js'
import type { RuleMatch } from '../../models/index.js'
import { canonicalDigest } from '../../runtime/environment/index.js'

/** The engine a stock file is registered for when it needs no PrismML build. */
export const STOCK_SETUP_PROVIDER: LocalProviderId = 'llamacpp-upstream'

export interface PrismHost {
  osType: string
  arch: string
  features: BackendFeatures
  gpus: readonly GpuProbeInfo[]
}

export interface PrismPackRef {
  version: string
  backend: string
}

export interface ModelSetupPlanInput {
  request: ModelSetupPlanRequest
  verdict: ModelCompatibilityResponse
  rule?: RuleMatch
  /** The Hub's LFS facts for `request.file` when no rule pins it. */
  hubFile?: { size: number; sha256?: string }
  manifest: PrismManifest
  offer: PrismOfferOptions
  host: PrismHost
  installedPacks: readonly PrismPackRef[]
  /** The pack a load on `atomic-prism` would use now. */
  currentPack: PrismPackRef | null
  freeBytes: number | null
}

/** `owner/<file name without .gguf>`: unique per file, and a leaf of the model tree. */
export function defaultModelId(repo: string, file: string): string {
  const owner = repo.split('/')[0] ?? repo
  const name = (file.split('/').pop() ?? file).replace(/\.gguf$/i, '')
  return `${owner}/${name}`
}

/**
 * The best offered PrismML pack for this machine that runs a file needing `requires` from build
 * `minBuild` on; `null` when none does.
 */
export function choosePrismPack(input: {
  manifest: PrismManifest
  offer: PrismOfferOptions
  host: PrismHost
  requires: readonly EngineCapability[]
  minBuild?: number
}): (PrismPackRef & { download_size: number }) | null {
  const { manifest, host } = input
  const fits = prismCatalogToBackends(manifest, input.offer).filter((pack) => {
    const release = findPrismRelease(manifest, pack.version)
    const build = prismTagBuild(pack.version) ?? 0
    if (input.minBuild !== undefined && build < input.minBuild) return false
    return input.requires.every((capability) => release?.capabilities.includes(capability))
  })
  const supported = filterPrismBackendsBySupport(
    fits,
    determinePrismSupportedBackends(host.osType, host.arch, host.features)
  )
  const best = determineBestPrismBackend(supported, host.gpus)
  if (!best) return null
  const [version, backend] = best.split('/') as [string, string]
  const sources = prismArchiveSources(manifest, version, backend) ?? []
  return { version, backend, download_size: sources.reduce((sum, s) => sum + s.size, 0) }
}

function engineOf(input: ModelSetupPlanInput, blockers: ModelSetupBlocker[]): ModelSetupEngine | null {
  const { verdict } = input
  if (verdict.provider !== 'atomic-prism') return null
  if (verdict.outcome === 'compatible') {
    return input.currentPack
      ? { provider: 'atomic-prism', ...input.currentPack, installed: true, download_size: 0 }
      : null
  }
  if (verdict.outcome !== 'engine_required' && verdict.outcome !== 'engine_update_required') return null
  const pack = choosePrismPack({
    manifest: input.manifest,
    offer: input.offer,
    host: input.host,
    requires: verdict.requires,
    ...(verdict.min_prism_build !== undefined ? { minBuild: verdict.min_prism_build } : {}),
  })
  if (!pack) {
    blockers.push({
      code: 'no_engine_build',
      message: 'No approved PrismML llama.cpp build runs this model on this computer yet.',
    })
    return null
  }
  const installed = input.installedPacks.some((p) => p.version === pack.version && p.backend === pack.backend)
  return {
    provider: 'atomic-prism',
    version: pack.version,
    backend: pack.backend,
    installed,
    download_size: installed ? 0 : pack.download_size,
  }
}

function artifactsOf(input: ModelSetupPlanInput): {
  model: ModelSetupArtifact
  projector: ModelSetupArtifact | null
} {
  const { request, rule } = input
  if (!rule) {
    return {
      model: {
        repo: request.repo,
        file: request.file,
        revision: request.revision ?? 'main',
        ...(input.hubFile?.sha256 ? { sha256: input.hubFile.sha256 } : {}),
        size: input.hubFile?.size ?? 0,
      },
      projector: null,
    }
  }
  const { family, file } = rule
  const projector =
    request.include_projector === false ? undefined : family.projectors?.find((p) => p.default)
  return {
    model: {
      repo: family.repo,
      file: file.file,
      revision: family.revision,
      sha256: file.sha256,
      size: file.size,
    },
    projector: projector
      ? {
          repo: family.repo,
          file: projector.file,
          revision: family.revision,
          sha256: projector.sha256,
          size: projector.size,
        }
      : null,
  }
}

/** What `digest` covers: everything that decides the work, nothing that drifts on its own. */
export function planDigest(plan: Omit<ModelSetupPlan, 'digest'>): string {
  return canonicalDigest({
    model_id: plan.model_id,
    provider: plan.provider,
    outcome: plan.verdict.outcome,
    engine: plan.engine && {
      version: plan.engine.version,
      backend: plan.engine.backend,
      installed: plan.engine.installed,
    },
    model: plan.model,
    projector: plan.projector,
    blockers: plan.blockers.map((b) => b.code),
  })
}

export function planModelSetup(input: ModelSetupPlanInput): ModelSetupPlan {
  const { verdict } = input
  const blockers: ModelSetupBlocker[] = []
  if (verdict.outcome === 'unsupported') blockers.push({ code: 'unsupported', message: verdict.reason })
  if (verdict.outcome === 'legacy_artifact') {
    blockers.push({
      code: 'legacy_artifact',
      message: verdict.reason,
      ...(verdict.replacement ? { replacement: verdict.replacement } : {}),
    })
  }
  const engine = engineOf(input, blockers)
  const { model, projector } = artifactsOf(input)
  const total = (engine?.download_size ?? 0) + model.size + (projector?.size ?? 0)
  if (input.freeBytes !== null && total > input.freeBytes) {
    blockers.push({
      code: 'insufficient_disk_space',
      message: `The setup needs ${total} bytes and ${input.freeBytes} are free.`,
    })
  }
  const body: Omit<ModelSetupPlan, 'digest'> = {
    model_id: input.request.model_id ?? defaultModelId(model.repo, model.file),
    provider: verdict.provider ?? STOCK_SETUP_PROVIDER,
    verdict,
    engine,
    model,
    projector,
    total_download_bytes: total,
    free_bytes: input.freeBytes,
    blockers,
    ...(verdict.defaults ? { defaults: verdict.defaults } : {}),
  }
  return { digest: planDigest(body), ...body }
}
