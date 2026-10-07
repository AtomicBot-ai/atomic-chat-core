/**
 * Composition of the model setup for `create.ts`: the plan's facts (the verdict, the conf rule, the
 * Hub's file facts, the PrismML manifest, this machine, the packs on disk, free space) gathered from
 * the core's services, and the runner's I/O (engine install, downloads, header check, `model.yml`).
 */

import type { DataLayout } from '../../config/index.js'
import { AtomicCoreError } from '../../contracts/index.js'
import type {
  CoreEvents,
  LocalProviderId,
  ModelCompatibilityRequest,
  ModelCompatibilityResponse,
  ModelSetup,
  ModelSetupPlan,
  ModelSetupPlanRequest,
  ProxyConfig,
} from '../../contracts/index.js'
import { getPrismSupportedFeatures, scanInstalledBackends } from '../../backend/index.js'
import type { PrismCatalogService, PrismOfferOptions, RocmHostProbe } from '../../backend/index.js'
import type { DownloadItem } from '../../downloads/index.js'
import type { HardwareFacts } from '../../hardware/index.js'
import { fetchHfGgufFiles, hfToken } from '../../models/index.js'
import type { ModelCompatibilityService, ModelYmlInput } from '../../models/index.js'
import { planModelSetup } from './plan.js'
import type { PrismPackRef } from './plan.js'
import { ModelSetupService } from './service.js'
import { ModelSetupStore } from './store.js'

export interface ModelSetupWiringDeps {
  layout: DataLayout
  compatibility: Pick<ModelCompatibilityService, 'check' | 'ruleFor'>
  prismCatalog: Pick<PrismCatalogService, 'catalog'>
  hardware: () => Promise<HardwareFacts>
  offer: () => PrismOfferOptions
  currentPack: () => Promise<PrismPackRef | null>
  installEngine: (
    version: string,
    backend: string,
    options: { taskId: string; proxy: ProxyConfig | null }
  ) => Promise<unknown>
  selectEngine: (versionBackend: string) => Promise<unknown>
  downloader: {
    download: (
      taskId: string,
      items: DownloadItem[],
      options: { headers?: Record<string, string>; resume?: boolean }
    ) => Promise<unknown>
    cancel: (taskId: string) => unknown
  }
  register: (provider: LocalProviderId, modelId: string, yml: ModelYmlInput) => Promise<unknown>
  /** A registered model's file: absolute path and the sha256 its `model.yml` records. */
  modelFile: (provider: LocalProviderId, modelId: string) => Promise<{ modelPath: string; sha256?: string }>
  emit: <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) => void
  freeBytes: () => Promise<number | null>
  /** The fetch for one request's proxy policy. */
  fetchFor: (proxy?: ProxyConfig | null) => typeof fetch
  newId: () => string
  /** Test hook `ATOMIC_HF_ENDPOINT`: where model files are downloaded from. */
  hfEndpoint?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  rocmProbe?: () => Promise<RocmHostProbe>
  installedPacks?: () => Promise<PrismPackRef[]>
  log?: (level: 'info' | 'warn', message: string) => void
}

function assertPlanRequest(request: ModelSetupPlanRequest): void {
  const ok = (v: unknown) => typeof v === 'string' && v.trim() !== ''
  if (!ok(request.repo) || !ok(request.file)) {
    throw new AtomicCoreError('INVALID_ARGUMENT', 'A model setup needs the Hugging Face repo and file.')
  }
  if (!/\.gguf$/i.test(request.file)) {
    throw new AtomicCoreError('INVALID_ARGUMENT', 'A model setup downloads a .gguf file.', request.file)
  }
  if (request.revision !== undefined && !ok(request.revision)) {
    throw new AtomicCoreError('INVALID_ARGUMENT', 'The revision must be a non-empty string.')
  }
}

/** The plan for one request, from what the core knows now. */
export async function planFor(
  deps: ModelSetupWiringDeps,
  request: ModelSetupPlanRequest
): Promise<ModelSetupPlan> {
  assertPlanRequest(request)
  const query = {
    repo: request.repo,
    file: request.file,
    ...(request.revision ? { revision: request.revision } : {}),
  }
  const [verdict, rule, catalog, facts, current, installedPacks, freeBytes] = await Promise.all([
    deps.compatibility.check({ ...query, inspectRemote: true }),
    deps.compatibility.ruleFor(query),
    deps.prismCatalog.catalog({ force: false, proxy: request.proxy ?? null }),
    deps.hardware(),
    deps.currentPack(),
    deps.installedPacks
      ? deps.installedPacks()
      : scanInstalledBackends(deps.layout, 'atomic-prism', deps.platform ?? process.platform).catch(() => []),
    deps.freeBytes().catch(() => null),
  ])
  let hubFile: { size: number; sha256?: string } | undefined
  if (!rule) {
    const token = hfToken(deps.env ?? process.env)
    const files = await fetchHfGgufFiles(request.repo, {
      fetch: deps.fetchFor(request.proxy ?? null),
      ...(token ? { token } : {}),
    })
    const found = files.find((f) => f.filename === request.file)
    if (!found)
      throw new AtomicCoreError(
        'INVALID_ARGUMENT',
        `"${request.file}" is not a GGUF file of ${request.repo}.`
      )
    hubFile = { size: found.size, ...(found.sha256 ? { sha256: found.sha256 } : {}) }
  }
  const rocm =
    facts.osType === 'linux' && deps.rocmProbe ? await deps.rocmProbe().catch(() => undefined) : undefined
  return planModelSetup({
    request,
    verdict,
    ...(rule ? { rule } : {}),
    ...(hubFile ? { hubFile } : {}),
    manifest: catalog.manifest,
    offer: deps.offer(),
    host: {
      osType: facts.osType,
      arch: facts.arch,
      features: getPrismSupportedFeatures(facts.osType, facts.cpuExtensions ?? [], facts.gpus, rocm),
      gpus: facts.gpus,
    },
    installedPacks: installedPacks.map((p) => ({ version: p.version, backend: p.backend })),
    currentPack: current,
    freeBytes,
  })
}

/**
 * `POST /models/compatibility`: a registered model by id (its file on disk), or a Hub file before
 * download (the conf rule, then — when asked — its header over HTTP ranges).
 */
export async function compatibilityFor(
  deps: Pick<ModelSetupWiringDeps, 'compatibility' | 'modelFile'>,
  request: ModelCompatibilityRequest
): Promise<ModelCompatibilityResponse> {
  if (typeof request.model_id === 'string' && request.model_id !== '') {
    const target = await deps.modelFile(request.provider ?? 'llamacpp-upstream', request.model_id)
    return deps.compatibility.check({
      modelPath: target.modelPath,
      ...(target.sha256 ? { sha256: target.sha256 } : {}),
    })
  }
  if (
    typeof request.repo !== 'string' ||
    request.repo === '' ||
    typeof request.file !== 'string' ||
    request.file === ''
  ) {
    throw new AtomicCoreError('INVALID_ARGUMENT', 'A compatibility check needs model_id, or repo and file.')
  }
  return deps.compatibility.check({
    repo: request.repo,
    file: request.file,
    ...(request.revision ? { revision: request.revision } : {}),
    ...(request.sha256 ? { sha256: request.sha256 } : {}),
    inspectRemote: request.inspect_remote === true,
  })
}

export function wireModelSetups(deps: ModelSetupWiringDeps): ModelSetupService {
  return new ModelSetupService({
    layout: deps.layout,
    store: new ModelSetupStore(deps.layout.core.prismSetupsDir),
    plan: (request) => planFor(deps, request),
    installEngine: async (engine, taskId, proxy) => {
      await deps.installEngine(engine.version, engine.backend, { taskId, proxy })
    },
    selectEngine: async (engine) => {
      await deps.selectEngine(`${engine.version}/${engine.backend}`)
    },
    download: async (taskId, items) => {
      const token = hfToken(deps.env ?? process.env)
      await deps.downloader.download(taskId, items, {
        resume: true,
        ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      })
    },
    cancelDownload: (taskId) => {
      deps.downloader.cancel(taskId)
    },
    verify: (modelPath) => deps.compatibility.check({ modelPath }),
    register: async (modelId, yml) => {
      await deps.register(
        typeof yml['atomic_runtime'] === 'object' ? 'atomic-prism' : 'llamacpp-upstream',
        modelId,
        yml
      )
    },
    emit: (record: ModelSetup) => deps.emit('model-setup:changed', record),
    imported: (event) => deps.emit('model:imported', event),
    newId: deps.newId,
    ...(deps.hfEndpoint ? { hfEndpoint: deps.hfEndpoint } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  })
}
