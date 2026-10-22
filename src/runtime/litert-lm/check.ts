/**
 * `POST /models/litert-lm/check` (openspec change `add-litert-lm-runtime`, task 6.5): whether a
 * variant would run here. Before a download, from what core already knows — the platform, this
 * machine's Intel NPU generation, the active build, whether OpenVINO is prepared — never the network.
 * For a file on disk, also from the file itself (`litert-host inspect`), whose facts come back in the
 * answer for the client to write into `model.yml`.
 */

import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { AtomicCoreError, LITERT_LM_BACKENDS, LITERT_LM_NPUS } from '../../contracts/index.js'
import type {
  LiteRtLmCheckRequest,
  LiteRtLmCheckResult,
  LiteRtLmFileMetadata,
  LiteRtLmNpu,
} from '../../contracts/index.js'
import type { LiteRtLmPlatform } from '../../engine-builds/manifest.js'
import type { ModelRegistry } from '../../models/index.js'
import { compareVersions } from '../../backend/index.js'
import { readLiteRtLmBlock } from './model-yml.js'
import { backendRunsOn } from './runtime.js'

export interface LiteRtLmCheckFacts {
  platform: LiteRtLmPlatform
  build: { dir: string; version: string } | null
  npu: LiteRtLmNpu | null
  openVinoPrepared: boolean
}

const verdict = (
  v: LiteRtLmCheckResult['verdict'],
  reason: string | null,
  metadata: LiteRtLmFileMetadata | null
): LiteRtLmCheckResult => ({ verdict: v, reason, ...(metadata ? { metadata } : {}) })

/** The verdict for a variant (`backend`, `npu`, `min_runtime_version`), and for a file its facts. */
export function liteRtLmVerdict(
  facts: LiteRtLmCheckFacts,
  request: Pick<LiteRtLmCheckRequest, 'backend' | 'npu' | 'min_runtime_version'>,
  file: LiteRtLmFileMetadata | null
): LiteRtLmCheckResult {
  const backend = request.backend ?? ''
  if (!LITERT_LM_BACKENDS.some((known) => known === backend))
    return verdict(
      'platform-unsupported',
      `This core runs no LiteRT-LM variant on the "${backend}" backend.`,
      file
    )
  if (!backendRunsOn(facts.platform, backend as (typeof LITERT_LM_BACKENDS)[number]))
    return verdict(
      'platform-unsupported',
      `LiteRT-LM runs ${backend.toUpperCase()} variants on Windows x64 only.`,
      file
    )
  if (backend === 'npu') {
    if (!LITERT_LM_NPUS.some((known) => known === request.npu))
      return verdict(
        'platform-unsupported',
        `This core runs no LiteRT-LM variant for the "${request.npu ?? ''}" NPU.`,
        file
      )
    if (facts.npu === null)
      return verdict(
        'accelerator-unavailable',
        'This computer has no Intel NPU LiteRT-LM has models for.',
        file
      )
    if (facts.npu !== request.npu)
      return verdict(
        'accelerator-unavailable',
        `This variant is built for the ${request.npu} NPU; this computer has ${facts.npu}.`,
        file
      )
  }
  if (!facts.build)
    return verdict('engine-not-installed', 'LiteRT-LM is not installed on this computer.', file)
  if (file && !file.backends.includes(backend as (typeof LITERT_LM_BACKENDS)[number]))
    return verdict(
      'platform-unsupported',
      `This file runs on ${file.backends.join(', ') || 'no backend'}, not ${backend}.`,
      file
    )
  const needs = file?.min_runtime_version ?? request.min_runtime_version ?? null
  if (needs && compareVersions(needs, facts.build.version) > 0)
    return verdict(
      'requires-newer-engine',
      `This model needs LiteRT-LM ${needs}; the installed one is ${facts.build.version}.`,
      file
    )
  if (backend === 'npu' && !facts.openVinoPrepared)
    return verdict(
      'accelerator-not-prepared',
      'OpenVINO is not prepared yet; prepare it on the LiteRT-LM page.',
      file
    )
  return verdict('ok', null, file)
}

const VERSION_RE = /^\d+\.\d+(\.\d+)?$/
const FIELDS = ['backend', 'npu', 'min_runtime_version', 'path', 'model_id'] as const

/** The request body, strictly: a variant, a path with its backend, or a model id. */
export function parseLiteRtLmCheckRequest(body: unknown): LiteRtLmCheckRequest {
  const invalid = (why: string): never => {
    throw new AtomicCoreError('INVALID_ARGUMENT', why)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return invalid('The request body must be a JSON object.')
  const record = body as Record<string, unknown>
  const extra = Object.keys(record).filter((key) => !FIELDS.some((field) => field === key))
  if (extra.length > 0) invalid(`The request has fields this core does not know: ${extra.sort().join(', ')}.`)
  const out: LiteRtLmCheckRequest = {}
  for (const key of FIELDS) {
    const value = record[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value === '') invalid(`${key} must be text.`)
    out[key] = value as string
  }
  if (out.min_runtime_version !== undefined && !VERSION_RE.test(out.min_runtime_version))
    invalid('min_runtime_version must be X.Y or X.Y.Z.')
  if (out.model_id !== undefined) {
    if (Object.keys(out).length > 1) invalid('model_id is checked alone: its variant comes from model.yml.')
    return out
  }
  if (out.backend === undefined) invalid('backend is required for a variant or a file.')
  return out
}

export interface LiteRtLmCheckDeps {
  platform: LiteRtLmPlatform
  /** `<data>/litert-lm/models`: the only place a checked path may be. */
  modelsDir: string
  registry: ModelRegistry
  resolveBuild: () => Promise<{ dir: string; version: string } | undefined>
  npuGeneration: () => Promise<LiteRtLmNpu | null>
  openVinoLibs: () => Promise<string | undefined>
  /** The runtime's cached `inspect` (by path, mtime and build). */
  inspect: (buildDir: string, file: string) => Promise<LiteRtLmFileMetadata>
}

export class LiteRtLmCheckService {
  constructor(private readonly deps: LiteRtLmCheckDeps) {}

  /** A path inside the models root, links resolved, or `INVALID_ARGUMENT`. */
  private async inRoot(path: string): Promise<string> {
    const refuse = () =>
      new AtomicCoreError('INVALID_ARGUMENT', 'path must be a file inside the LiteRT-LM models folder.')
    if (!isAbsolute(path)) throw new AtomicCoreError('INVALID_ARGUMENT', 'path must be absolute.')
    const root = await realpath(this.deps.modelsDir).catch(() => resolve(this.deps.modelsDir))
    // A file that is not there yet is judged by its spelling; one that is, by where its links lead.
    const full = await realpath(path).catch(() => resolve(path))
    const rel = relative(root, full)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw refuse()
    return resolve(path)
  }

  async check(request: LiteRtLmCheckRequest): Promise<LiteRtLmCheckResult> {
    let variant: Pick<LiteRtLmCheckRequest, 'backend' | 'npu' | 'min_runtime_version'> = request
    let file: string | null = request.path !== undefined ? await this.inRoot(request.path) : null
    if (request.model_id !== undefined) {
      const yml = await this.deps.registry.read(request.model_id)
      const block = readLiteRtLmBlock(yml)
      variant = { backend: block.backend, ...(block.npu ? { npu: block.npu } : {}) }
      file = await this.inRoot(this.deps.registry.resolvePaths(yml).modelPath)
    }
    const build = (await this.deps.resolveBuild()) ?? null
    const facts: LiteRtLmCheckFacts = {
      platform: this.deps.platform,
      build,
      npu: await this.deps.npuGeneration(),
      openVinoPrepared: (await this.deps.openVinoLibs()) !== undefined,
    }
    const metadata = file && build ? await this.deps.inspect(build.dir, file) : null
    return liteRtLmVerdict(facts, variant, metadata)
  }
}
