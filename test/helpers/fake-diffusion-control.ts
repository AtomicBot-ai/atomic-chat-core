/**
 * An in-memory `DiffusionControl` for the control server and client tests: records what it was
 * asked and answers canned values in the app's shapes. The real service is exercised by
 * `src/diffusion/service.test.ts`.
 */
import type {
  DiffusionBackendInstallRecord,
  DiffusionStatus,
  GalleryImageItem,
  ImageCapabilities,
  ImageJob,
  LoadedDiffusionModel,
} from '../../src/contracts/index.js'
import type { DiffusionControl } from '../../src/server/control/index.js'

export const FAKE_DIFFUSION_STATUS: DiffusionStatus = {
  configured: true,
  install: { state: 'not-installed' },
  model: { state: 'unloaded', loaded: null },
  activeJob: null,
  outputDir: '/tmp/data/images',
  idleUnloadSecs: 600,
}

export const FAKE_INSTALL_RECORD: DiffusionBackendInstallRecord = {
  tag: 'master-849-d04e895',
  backendId: 'macos-arm64',
  backend: 'metal',
  engine: 'sd-cpp',
  sha256: null,
  installedAtMs: 1,
  dir: '/tmp/data/diffusion/backends/master-849-d04e895/macos-arm64',
}

export const FAKE_LOADED_MODEL: LoadedDiffusionModel = {
  modelId: 'z-image:q4_k_m',
  family: 'z-image',
  modality: 'image',
  displayName: 'Z-Image Turbo',
  engine: 'sd-cpp',
  backend: 'metal',
  offload: 'none',
  cpuFallback: false,
  port: 3456,
  pid: 777,
  loadedAtMs: 2,
}

export const FAKE_CAPABILITIES: ImageCapabilities = {
  workflows: ['create', 'transform', 'inpaint', 'extend', 'upscale'],
  minDim: 256,
  maxDim: 2048,
  dimMultiple: 16,
  supportsNegativePrompt: false,
  supportsGuidance: false,
  cancelGenerating: false,
  maxBatch: 4,
  defaults: { steps: 8, cfgScale: 1, width: 1024, height: 1024 },
  ranges: { steps: [1, 50], dims: [256, 2048], dimMultiple: 16 },
}

export const FAKE_GALLERY_ITEM: GalleryImageItem = {
  id: '00000000000000000000000000000007-00',
  path: '/tmp/data/images/00000000000000000000000000000007-00.png',
  thumbnailPath: null,
  width: 64,
  height: 48,
  sizeBytes: 1234,
  createdAtMs: 3,
  pinned: false,
  archived: false,
  recipe: {
    jobId: '00000000000000000000000000000007',
    index: 0,
    prompt: 'a cat',
    negativePrompt: null,
    width: 64,
    height: 48,
    steps: 8,
    cfgScale: 1,
    guidance: null,
    seed: 100,
    batchSeed: 100,
    batchSize: 1,
    samplingMethod: null,
    flowShift: null,
    workflow: 'create',
    strength: null,
    model: { modelId: 'z-image:q4_k_m', family: 'z-image', displayName: 'Z-Image Turbo', filename: 'z.gguf' },
    engine: {
      kind: 'sd-cpp',
      backend: 'metal',
      tag: 'master-849-d04e895',
      offload: 'none',
      cpuFallback: false,
    },
    createdAtMs: 3,
    durationMs: 4,
  },
}

export const FAKE_JOB: ImageJob = {
  id: 'job-1',
  state: 'queued',
  modelId: 'z-image:q4_k_m',
  request: { prompt: 'a cat', width: 512, height: 512, steps: 8, cfgScale: 1, batchSize: 1 },
  createdAtMs: 5,
  progress: null,
  outputs: [],
}

export interface FakeDiffusionControl extends DiffusionControl {
  /** `getJob` and `getGalleryItem` answer `null` for any other id. */
  knownJobId: string
  knownItemId: string
}

export function fakeDiffusionControl(calls: string[]): FakeDiffusionControl {
  const note = (call: string) => calls.push(`diffusion ${call}`)
  const fake: FakeDiffusionControl = {
    knownJobId: FAKE_JOB.id,
    knownItemId: FAKE_GALLERY_ITEM.id,
    configure: async (config) => {
      note(`configure ${JSON.stringify(config)}`)
      return { ...FAKE_DIFFUSION_STATUS, outputDir: config.outputDir ?? FAKE_DIFFUSION_STATUS.outputDir }
    },
    getStatus: async () => FAKE_DIFFUSION_STATUS,
    setOutputDir: async (path) => {
      note(`setOutputDir ${path}`)
      return { ...FAKE_DIFFUSION_STATUS, outputDir: path }
    },
    finalizeBackendInstall: async (args) => {
      note(`finalize ${JSON.stringify(args)}`)
      return {
        ...FAKE_INSTALL_RECORD,
        dir: args.dir,
        tag: args.tag,
        backendId: args.backendId,
        sha256: args.sha256 ?? null,
      }
    },
    listInstalledBackends: async () => [FAKE_INSTALL_RECORD],
    removeBackend: async (dir) => {
      note(`removeBackend ${dir}`)
    },
    listModelFiles: async () => [
      { path: '/tmp/data/diffusion/models/z-image/z.gguf', relativePath: 'z-image/z.gguf', bytes: 5 },
    ],
    deleteModelFile: async (path) => {
      note(`deleteModelFile ${path}`)
    },
    loadModel: async (request) => {
      note(`loadModel ${request.modelId}`)
      return { ...FAKE_LOADED_MODEL, modelId: request.modelId }
    },
    unloadModel: async () => {
      note('unloadModel')
    },
    getCapabilities: () => FAKE_CAPABILITIES,
    touchIdle: () => note('touchIdle'),
    generate: async (request) => {
      note(`generate ${request.prompt} ${request.width}x${request.height}`)
      return { jobId: FAKE_JOB.id }
    },
    getJob: (jobId) => (jobId === fake.knownJobId ? FAKE_JOB : null),
    cancelJob: async (jobId) => {
      note(`cancelJob ${jobId}`)
      return { cancelled: true, serverStopped: false }
    },
    listGallery: async (options) => {
      note(`listGallery ${JSON.stringify(options)}`)
      return { items: [FAKE_GALLERY_ITEM], hasMore: false, total: 1 }
    },
    getGalleryItem: async (id) => (id === fake.knownItemId ? FAKE_GALLERY_ITEM : null),
    deleteGalleryItems: async (ids) => {
      note(`deleteGalleryItems ${ids.join(',')}`)
    },
    setGalleryFlags: async (id, flags) => {
      note(`setGalleryFlags ${id} ${JSON.stringify(flags)}`)
      return { ...FAKE_GALLERY_ITEM, id, pinned: flags.pinned ?? false, archived: flags.archived ?? false }
    },
    exportGalleryItem: async (id, targetPath) => {
      note(`exportGalleryItem ${id} ${targetPath}`)
    },
  }
  return fake
}
