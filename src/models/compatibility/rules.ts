/**
 * PrismML model compatibility rules, pure half: `atomic-chat-conf/models/atomic-prism-models.json`
 * (schema `schema.atomic-prism-models.json` next to it). Which Bonsai files need `atomic-prism`,
 * which run on stock llama.cpp too, which are legacy layouts, and how GGUF header evidence (tensor
 * type ids, metadata keys) turns into capabilities — so a new packing or revision ships as a conf
 * edit, not a release. Lenient per entry, strict per field, like the backend manifest.
 */

import type { EngineCapability } from '../../contracts/index.js'

export const PRISM_MODEL_RULES_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/models/atomic-prism-models.json'
export const PRISM_MODEL_RULES_SCHEMA_VERSION = 1

const CAPABILITIES: ReadonlySet<string> = new Set([
  'q1_0',
  'q2_0_g64',
  'pq2_0',
  'ptq1_0',
  'hadamard',
  'vision',
])

export type PrismFileTreatment = 'prism_required' | 'any' | 'legacy' | 'excluded'
/** What a tensor type id means: a capability, or `q2_0`, which its bits per weight resolves. */
export type TensorTypeRule = EngineCapability | 'q2_0'

export interface PrismModelFile {
  file: string
  size: number
  sha256: string
  packing?: string
  treatment: PrismFileTreatment
  requires: EngineCapability[]
  min_prism_build?: number
  default?: boolean
  replacement?: string
  summary?: string
}

export interface PrismModelProjector {
  file: string
  size: number
  sha256: string
  default?: boolean
}

export interface PrismModelFamily {
  id: string
  title: string
  repo: string
  revision: string
  featured?: boolean
  default_packing?: string
  sampling?: { temperature?: number; top_p?: number; top_k?: number; min_p?: number }
  default_ctx?: number
  files: PrismModelFile[]
  projectors: PrismModelProjector[]
}

export interface PrismModelRules {
  schema_version: 1
  updated_at: string
  rules_version: number
  tensor_types: Record<string, TensorTypeRule>
  metadata_capabilities: Record<string, EngineCapability>
  upstream_capabilities: EngineCapability[]
  families: PrismModelFamily[]
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const isCapability = (v: unknown): v is EngineCapability => typeof v === 'string' && CAPABILITIES.has(v)
const isSha = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const isSize = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0
const TREATMENTS: ReadonlySet<string> = new Set(['prism_required', 'any', 'legacy', 'excluded'])

function parseFile(raw: unknown): PrismModelFile | null {
  if (!isRecord(raw)) return null
  const { file, size, sha256, treatment } = raw
  if (!isString(file) || !isSize(size) || !isSha(sha256)) return null
  if (typeof treatment !== 'string' || !TREATMENTS.has(treatment)) return null
  const out: PrismModelFile = {
    file,
    size,
    sha256,
    treatment: treatment as PrismFileTreatment,
    requires: Array.isArray(raw['requires']) ? raw['requires'].filter(isCapability) : [],
  }
  if (isString(raw['packing'])) out.packing = raw['packing']
  if (typeof raw['min_prism_build'] === 'number' && Number.isInteger(raw['min_prism_build'])) {
    out.min_prism_build = raw['min_prism_build']
  }
  if (raw['default'] === true) out.default = true
  if (isString(raw['replacement'])) out.replacement = raw['replacement']
  if (isString(raw['summary'])) out.summary = raw['summary']
  return out
}

function parseProjector(raw: unknown): PrismModelProjector | null {
  if (!isRecord(raw)) return null
  const { file, size, sha256 } = raw
  if (!isString(file) || !isSize(size) || !isSha(sha256)) return null
  return { file, size, sha256, ...(raw['default'] === true ? { default: true } : {}) }
}

function parseFamily(raw: unknown): PrismModelFamily | null {
  if (!isRecord(raw)) return null
  const { id, title, repo, revision } = raw
  if (!isString(id) || !isString(title) || !isString(repo) || !/^[0-9a-f]{40}$/.test(String(revision)))
    return null
  const files = (Array.isArray(raw['files']) ? raw['files'].map(parseFile) : []).filter(
    (f): f is PrismModelFile => f !== null
  )
  if (files.length === 0) return null
  const family: PrismModelFamily = {
    id,
    title,
    repo,
    revision: revision as string,
    files,
    projectors: (Array.isArray(raw['projectors']) ? raw['projectors'].map(parseProjector) : []).filter(
      (p): p is PrismModelProjector => p !== null
    ),
  }
  if (raw['featured'] === true) family.featured = true
  if (isString(raw['default_packing'])) family.default_packing = raw['default_packing']
  if (isRecord(raw['sampling'])) {
    const s = raw['sampling']
    const sampling: NonNullable<PrismModelFamily['sampling']> = {}
    for (const key of ['temperature', 'top_p', 'top_k', 'min_p'] as const) {
      if (typeof s[key] === 'number') sampling[key] = s[key] as number
    }
    family.sampling = sampling
  }
  if (typeof raw['default_ctx'] === 'number' && Number.isInteger(raw['default_ctx']))
    family.default_ctx = raw['default_ctx']
  return family
}

/** Parsed rules, or `null` for a document this core does not understand. */
export function parsePrismModelRules(value: unknown): PrismModelRules | null {
  if (!isRecord(value)) return null
  if (value['schema_version'] !== PRISM_MODEL_RULES_SCHEMA_VERSION) return null
  const rulesVersion = value['rules_version']
  if (typeof rulesVersion !== 'number' || !Number.isInteger(rulesVersion) || rulesVersion < 1) return null
  const tensorTypes: Record<string, TensorTypeRule> = {}
  if (isRecord(value['tensor_types'])) {
    for (const [id, cap] of Object.entries(value['tensor_types'])) {
      if (/^\d+$/.test(id) && (cap === 'q2_0' || isCapability(cap))) tensorTypes[id] = cap
    }
  }
  const metadataCapabilities: Record<string, EngineCapability> = {}
  if (isRecord(value['metadata_capabilities'])) {
    for (const [key, cap] of Object.entries(value['metadata_capabilities'])) {
      if (isCapability(cap)) metadataCapabilities[key] = cap
    }
  }
  return {
    schema_version: 1,
    updated_at: isString(value['updated_at']) ? value['updated_at'] : '',
    rules_version: rulesVersion,
    tensor_types: tensorTypes,
    metadata_capabilities: metadataCapabilities,
    upstream_capabilities: Array.isArray(value['upstream_capabilities'])
      ? value['upstream_capabilities'].filter(isCapability)
      : [],
    families: (Array.isArray(value['families']) ? value['families'].map(parseFamily) : []).filter(
      (f): f is PrismModelFamily => f !== null
    ),
  }
}

export interface RuleMatch {
  family: PrismModelFamily
  file: PrismModelFile
}

/**
 * The rule for one file: by sha256 when known (a renamed file is still itself), else by
 * repository + file name (case-insensitive repo, exact file name).
 */
export function findPrismModelRule(
  rules: PrismModelRules,
  query: { sha256?: string; repo?: string; file?: string }
): RuleMatch | undefined {
  if (query.sha256) {
    for (const family of rules.families) {
      const file = family.files.find((f) => f.sha256 === query.sha256)
      if (file) return { family, file }
    }
  }
  if (query.repo && query.file) {
    const repo = query.repo.toLowerCase()
    const name = query.file.split('/').pop()
    const family = rules.families.find((f) => f.repo.toLowerCase() === repo)
    const file = family?.files.find((f) => f.file === name)
    if (family && file) return { family, file }
  }
  return undefined
}

/** The family a projector file belongs to, by sha256 or repository + name. */
export function findPrismProjector(
  rules: PrismModelRules,
  query: { sha256?: string; repo?: string; file?: string }
): { family: PrismModelFamily; projector: PrismModelProjector } | undefined {
  for (const family of rules.families) {
    const projector = family.projectors.find(
      (p) =>
        (query.sha256 && p.sha256 === query.sha256) ||
        (query.repo &&
          query.file &&
          family.repo.toLowerCase() === query.repo.toLowerCase() &&
          p.file === query.file.split('/').pop())
    )
    if (projector) return { family, projector }
  }
  return undefined
}
