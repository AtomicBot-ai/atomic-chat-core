/**
 * `POST /models/geniex/check` (openspec change `add-geniex-runtime`, task 6.5): whether a variant
 * would run here. Before a download, from what core already knows — this machine's chip, the
 * active build and the devices its probe found — never the network. For a model on disk, also from
 * the model itself (`geniex-host inspect`, no library needed), whose facts come back in the answer
 * for the client to write into `model.yml`.
 */

import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { AtomicCoreError, GENIEX_CHIPS, GENIEX_DEVICES, GENIEX_PLUGINS } from '../../contracts/index.js'
import type {
  GeniexCheckRequest,
  GeniexCheckResult,
  GeniexChip,
  GeniexDevice,
  GeniexModelMetadata,
} from '../../contracts/index.js'
import type { ModelRegistry } from '../../models/index.js'
import { compareVersions } from '../../backend/index.js'
import { deviceFound, deviceMissingReason } from './devices.js'
import { readGeniexBlock } from './model-yml.js'
import type { GeniexBuild } from './runtime.js'

export interface GeniexCheckFacts {
  chip: GeniexChip
  build: GeniexBuild | null
}

const verdict = (
  v: GeniexCheckResult['verdict'],
  reason: string | null,
  metadata: GeniexModelMetadata | null
): GeniexCheckResult => ({
  verdict: v,
  reason,
  ...(metadata ? { metadata } : {}),
})

/** The verdict for a variant (`plugin`, `device`, `chip`, `min_runtime_version`), and for a model its facts. */
export function geniexVerdict(
  facts: GeniexCheckFacts,
  request: Pick<GeniexCheckRequest, 'plugin' | 'device' | 'chip' | 'min_runtime_version'>,
  model: GeniexModelMetadata | null
): GeniexCheckResult {
  const plugin = request.plugin ?? ''
  if (!GENIEX_PLUGINS.some((known) => known === plugin))
    return verdict(
      'platform-unsupported',
      `This core runs no GenieX model with the "${plugin}" plugin.`,
      model
    )
  const device = request.device ?? ''
  if (!GENIEX_DEVICES.some((known) => known === device))
    return verdict('platform-unsupported', `This core runs no GenieX model on the "${device}" device.`, model)
  if (plugin === 'qairt') {
    if (device !== 'npu') return verdict('platform-unsupported', 'AI Hub bundles run on the NPU only.', model)
    const chip = model?.kind === 'qairt' && model.chip ? model.chip : request.chip
    if (chip === undefined || chip === null)
      return verdict(
        'platform-unsupported',
        'This bundle does not say which Snapdragon chip it is built for.',
        model
      )
    if (!GENIEX_CHIPS.some((known) => known === chip))
      return verdict('platform-unsupported', `This core knows no Snapdragon "${chip}".`, model)
    if (chip !== facts.chip)
      return verdict(
        'platform-unsupported',
        `This bundle is built for the Snapdragon ${chip}; this computer has the ${facts.chip}.`,
        model
      )
  }
  if (model && (model.kind === 'qairt') !== (plugin === 'qairt'))
    return verdict(
      'platform-unsupported',
      model.kind === 'qairt'
        ? 'This folder holds an AI Hub bundle, which runs with the qairt plugin.'
        : 'This file is a GGUF, which runs with the llama_cpp plugin.',
      model
    )
  if (!facts.build) return verdict('engine-not-installed', 'GenieX is not installed on this computer.', model)
  if (!deviceFound(device as GeniexDevice, facts.build.devices))
    return verdict('accelerator-unavailable', deviceMissingReason(device as GeniexDevice), model)
  const needs =
    (model?.kind === 'qairt' ? model.min_runtime_version : null) ?? request.min_runtime_version ?? null
  if (needs && compareVersions(needs, facts.build.version) > 0)
    return verdict(
      'requires-newer-engine',
      `This model needs GenieX ${needs}; the installed one is ${facts.build.version}.`,
      model
    )
  return verdict('ok', null, model)
}

const VERSION_RE = /^\d+\.\d+(\.\d+)?$/
const FIELDS = ['plugin', 'device', 'chip', 'min_runtime_version', 'path', 'model_id'] as const

/** The request body, strictly: a variant, a path with its plugin and device, or a model id. */
export function parseGeniexCheckRequest(body: unknown): GeniexCheckRequest {
  const invalid = (why: string): never => {
    throw new AtomicCoreError('INVALID_ARGUMENT', why)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return invalid('The request body must be a JSON object.')
  const record = body as Record<string, unknown>
  const extra = Object.keys(record).filter((key) => !FIELDS.some((field) => field === key))
  if (extra.length > 0) invalid(`The request has fields this core does not know: ${extra.sort().join(', ')}.`)
  const out: GeniexCheckRequest = {}
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
  if (out.plugin === undefined || out.device === undefined)
    invalid('plugin and device are required for a variant or a path.')
  return out
}

export interface GeniexCheckDeps {
  chip: GeniexChip
  /** `<data>/geniex/models`: the only place a checked path may be. */
  modelsDir: string
  registry: ModelRegistry
  resolveBuild: () => Promise<GeniexBuild | undefined>
  /** The runtime's cached `inspect` (by path and mtime); needs no build. */
  inspect: (path: string) => Promise<GeniexModelMetadata>
}

export class GeniexCheckService {
  constructor(private readonly deps: GeniexCheckDeps) {}

  /** A path inside the models root, links resolved, or `INVALID_ARGUMENT`. */
  private async inRoot(path: string): Promise<string> {
    const refuse = () =>
      new AtomicCoreError(
        'INVALID_ARGUMENT',
        'path must be a file or folder inside the GenieX models folder.'
      )
    if (!isAbsolute(path)) throw new AtomicCoreError('INVALID_ARGUMENT', 'path must be absolute.')
    const root = await realpath(this.deps.modelsDir).catch(() => resolve(this.deps.modelsDir))
    // A model that is not there yet is judged by its spelling; one that is, by where its links lead.
    const full = await realpath(path).catch(() => resolve(path))
    const rel = relative(root, full)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw refuse()
    return resolve(path)
  }

  async check(request: GeniexCheckRequest): Promise<GeniexCheckResult> {
    let variant: Pick<GeniexCheckRequest, 'plugin' | 'device' | 'chip' | 'min_runtime_version'> = request
    let path: string | null = request.path !== undefined ? await this.inRoot(request.path) : null
    if (request.model_id !== undefined) {
      const yml = await this.deps.registry.read(request.model_id)
      const block = readGeniexBlock(yml)
      variant = { plugin: block.plugin, device: block.backend, ...(block.chip ? { chip: block.chip } : {}) }
      // The registry's own path: an installed model may be a link, which the runtime loads as it is.
      path = this.deps.registry.resolvePaths(yml).modelPath
    }
    const facts: GeniexCheckFacts = { chip: this.deps.chip, build: (await this.deps.resolveBuild()) ?? null }
    const metadata = path ? await this.deps.inspect(path) : null
    return geniexVerdict(facts, variant, metadata)
  }
}
