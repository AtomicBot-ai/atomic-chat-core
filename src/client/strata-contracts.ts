import { STRATA_FAMILIES } from '../contracts/index.js'
import type { StrataModelDescriptor } from '../contracts/index.js'
import type { AtomicCatalogEntry, AtomicModelCatalog } from './model-catalog.js'

const recipes = {
  qwen38: {
    weights: 2,
    drafting: 'dflash2',
    roles: {
      vision: 'vision',
      drafter: 'drafter',
      drafter_config: 'drafter-config',
      draft_vocab: 'draft-vocab',
      expert_profile: 'expert-profile',
    },
  },
  qwen36: {
    weights: 1,
    drafting: 'mtp-embedded',
    roles: { vision: 'vision', drafter_embedded_in: 'weights' },
  },
  deepseek41: {
    weights: 4,
    drafting: 'dspark',
    roles: {
      vision: 'vision',
      drafter: 'drafter',
      engram: 'engram',
      engram_metadata: 'engram-metadata',
      expert_profile: 'expert-profile',
    },
  },
} as const
const cudaProfiles = {
  'swift-iq2-xs': { family: 'qwen38', drafting: 'none' },
  'swift-iq3-xxs': { family: 'qwen38', drafting: 'none' },
  'swift-iq3-s': { family: 'qwen38', drafting: 'none' },
  'coder-iq1-m': { family: 'qwen38', drafting: 'none' },
  'unsloth-ud-iq4-xs-dflash2': { family: 'qwen38', weights: 3 },
  'unsloth-ud-q4-k-xl-dflash2': { family: 'qwen38', weights: 4 },
  'unsloth-ud-q5-k-xl-dflash2': { family: 'qwen38', weights: 6 },
  'unsloth-ud-q6-k-xl-dflash2': { family: 'qwen38', weights: 6 },
  'unsloth-q8-0-dflash2': { family: 'qwen38', weights: 6 },
  'unsloth-ud-iq1-m-dflash2': { family: 'qwen38', weights: 3 },
  'unsloth-ud-q2-0-dflash2': { family: 'qwen38', weights: 3 },
  'unsloth-ud-iq2-xs-dflash2': { family: 'qwen38', weights: 3 },
  'unsloth-ud-q2-k-xl-dflash2': { family: 'qwen38', weights: 4 },
  'unsloth-ud-iq3-xxs-dflash2': { family: 'qwen38', weights: 4 },
  'unsloth-ud-q3-k-xl-dflash2': { family: 'qwen38', weights: 4 },
  'unsloth-ud-iq4-xs-v31-dflash2': { family: 'qwen38', weights: 4 },
  'gyro-s-dflash2': { family: 'qwen38', weights: 1 },
  'gyro-m-dflash2': { family: 'qwen38', weights: 1 },
  'ud-q6-k-xl-mtp': { family: 'qwen36' },
  'q8-0-mtp': { family: 'qwen36' },
  'ista-1-75bpw-dspark': { family: 'deepseek41' },
  'ista-2-25bpw-dspark': { family: 'deepseek41' },
  'unsloth-ud-iq1-s-dspark': { family: 'deepseek41', weights: 4, externalEngram: true },
  'unsloth-ud-iq1-m-dspark': { family: 'deepseek41', weights: 4, externalEngram: true },
  'ista-coder-dspark': { family: 'deepseek41', weights: 5, externalEngram: true },
  'unsloth-ud-q8-k-xl': { family: 'deepseek41', weights: 9, drafting: 'none' },
  'nvfp4-gptq': { family: 'qwen38', weights: 1, drafting: 'none', readyPack: true },
  'nvfp4-nvidia': { family: 'qwen38', weights: 1, drafting: 'none', readyPack: true },
  'nvfp4-qad': { family: 'qwen38', weights: 1, drafting: 'none', readyPack: true },
} as const satisfies Record<
  string,
  {
    family: StrataModelDescriptor['family']
    weights?: number
    drafting?: 'none'
    readyPack?: boolean
    externalEngram?: boolean
  }
>

const baseProfiles = {
  'iq3-xxs-dflash2': 'qwen38',
  'q2-0-dflash2': 'qwen38',
  'iq3-s-dflash2': 'qwen38',
  'iq2-xs-dflash2': 'qwen38',
  'ud-q4-k-xl-mtp': 'qwen36',
  'ista-2-00bpw-dspark': 'deepseek41',
  'ista-2-00bpw-metal-text': 'deepseek41',
} as const

export function strataProfileId(d: StrataModelDescriptor): string {
  return d.profile_id ?? d.variant_id
}

const packFiles = [
  'pack/dense.bin',
  'pack/experts.bin',
  'pack/index.txt',
  'pack/native_experts.txt',
  'pack/tokenizer/chat_template.jinja',
  'pack/tokenizer/merges.txt',
  'pack/tokenizer/token_type.json',
  'pack/tokenizer/tokenizer.json',
  'pack/tokenizer/vocab.json',
]

export function strataCudaProfile(variant: string):
  | {
      family: StrataModelDescriptor['family']
      weights?: number
      drafting?: 'none'
      readyPack?: boolean
      externalEngram?: boolean
    }
  | undefined {
  return Object.hasOwn(cudaProfiles, variant) ? cudaProfiles[variant as keyof typeof cudaProfiles] : undefined
}

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const matches = (v: unknown, re: RegExp): v is string => typeof v === 'string' && re.test(v)
const positive = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
const id = (v: unknown): v is string => matches(v, /^[a-z0-9][a-z0-9._-]*$/)
function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error('Invalid Strata descriptor: ' + reason)
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  check(
    Object.keys(value).every((k) => allowed.includes(k)),
    'unknown field'
  )
}
function safePath(v: unknown): v is string {
  return (
    matches(v, /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/) &&
    v
      .split('/')
      .every(
        (p) =>
          p &&
          p !== '.' &&
          p !== '..' &&
          !p.endsWith('.') &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)
      )
  )
}
function same(value: unknown, expected: readonly string[]) {
  return Array.isArray(value) && value.length === expected.length && value.every((v, i) => v === expected[i])
}

/** Validate the entire pinned recipe; never accept executable configuration from a catalog. */
export function parseStrataDescriptor(value: unknown): StrataModelDescriptor {
  check(record(value), 'object required')
  const d = value
  keys(d, [
    'family',
    'variant_id',
    'profile_id',
    'name',
    'license',
    'gated',
    'context_length',
    'engine_release',
    'preparation_abi',
    'preparation_recipe_id',
    'sources',
    'files',
    'inputs',
    'compatible_variants',
    'capabilities',
    'capability_requirements',
    'requirements',
    'qualification',
  ])
  check(typeof d.family === 'string' && (STRATA_FAMILIES as readonly string[]).includes(d.family), 'family')
  const family = d.family as StrataModelDescriptor['family']
  const recipe = recipes[family]
  check(id(d.variant_id) && safePath(d.variant_id), 'variant id')
  // These profiles are qualified for the CUDA catalog of this release.
  const profileId = d.profile_id === undefined ? d.variant_id : d.profile_id
  check(id(profileId), 'profile id')
  const profile = strataCudaProfile(profileId)
  if (d.profile_id !== undefined) {
    const profileFamily =
      profile?.family ??
      (Object.hasOwn(baseProfiles, profileId)
        ? baseProfiles[profileId as keyof typeof baseProfiles]
        : undefined)
    check(profileFamily === family, 'unknown or incompatible profile')
  }
  check(!profile || profile.family === family, 'profile family')
  const metalText = profileId === 'ista-2-00bpw-metal-text'
  const drafting = metalText ? 'none' : (profile?.drafting ?? recipe.drafting)
  const weightCount = profile?.weights ?? recipe.weights
  const splitCount = weightCount + Number(profile?.externalEngram ?? false)
  const roles = metalText
    ? { engram: 'engram', engram_metadata: 'engram-metadata', expert_profile: 'expert-profile' }
    : drafting !== 'none'
      ? { ...recipe.roles, ...(profile?.externalEngram ? { engram_metadata: 'weights' } : {}) }
      : profile?.readyPack
        ? { vision: 'vision', ple: 'ple', embedding: 'embedding', expert_profile: 'expert-profile' }
        : family === 'qwen38'
          ? { vision: 'vision', expert_profile: 'expert-profile' }
          : { vision: 'vision' }
  check(
    typeof d.name === 'string' &&
      d.name.trim() &&
      typeof d.license === 'string' &&
      d.license.trim() &&
      typeof d.gated === 'boolean',
    'metadata'
  )
  check(positive(d.context_length) && Number(d.context_length) <= 2147483647, 'context length')
  check(
    matches(d.engine_release, /^strata-\d+\.\d+\.\d+(?:\.\d+)?-r[1-9]\d*$/) &&
      d.preparation_abi === 'strata-v1' &&
      d.preparation_recipe_id === `strata-${family}-v1`,
    'recipe/ABI'
  )
  check(Array.isArray(d.sources) && d.sources.length && Array.isArray(d.files) && d.files.length, 'file plan')
  const sources = new Set<string>()
  for (const s of d.sources) {
    check(record(s), 'source')
    keys(s, ['id', 'host', 'repo', 'revision'])
    check(
      id(s.id) &&
        !sources.has(s.id) &&
        ['huggingface', 'github'].includes(String(s.host)) &&
        matches(s.repo, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) &&
        s.repo.split('/').every((p) => p !== '.' && p !== '..') &&
        matches(s.revision, /^[a-f0-9]{40}$/),
      'immutable source'
    )
    sources.add(s.id)
  }
  const files = new Map<string, Record<string, unknown>>(),
    folded = new Set<string>(),
    directories = new Map<string, string>(),
    usedSources = new Set<string>()
  let bytes = 0
  for (const f of d.files) {
    check(record(f), 'file')
    keys(f, ['source', 'source_path', 'path', 'size', 'sha256', 'role'])
    check(
      typeof f.source === 'string' &&
        sources.has(f.source) &&
        safePath(f.path) &&
        safePath(f.source_path) &&
        positive(f.size) &&
        matches(f.sha256, /^[a-f0-9]{64}$/),
      'file identity'
    )
    const lower = f.path.toLowerCase()
    check(
      lower !== 'model.yml' && !lower.startsWith('model.yml/') && !folded.has(lower),
      'duplicate or reserved file'
    )
    folded.add(lower)
    files.set(f.path, f)
    usedSources.add(f.source)
    bytes += Number(f.size)
  }
  check(usedSources.size === sources.size, 'unused source')
  for (const path of files.keys()) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/'),
        lower = dir.toLowerCase()
      check(
        !folded.has(lower) && (!directories.has(lower) || directories.get(lower) === dir),
        'file/directory alias'
      )
      directories.set(lower, dir)
    }
  }
  check(record(d.inputs), 'inputs')
  const inputs = d.inputs,
    referenced = new Set<string>()
  keys(inputs, [
    'weights',
    'tokenizer_from',
    'chat_template_from',
    'drafting',
    ...Object.keys(roles),
    ...(profile?.readyPack ? ['pack_files'] : []),
    ...(family === 'deepseek41' ? ['experts_per_token'] : []),
  ])
  const requireFile = (path: unknown, role: string) => {
    check(typeof path === 'string' && files.get(path)?.role === role, 'missing ' + role + ' input')
    referenced.add(path)
  }
  check(
    Array.isArray(inputs.weights) &&
      inputs.weights.length === weightCount &&
      new Set(inputs.weights).size === weightCount,
    'missing weight shard'
  )
  inputs.weights.forEach((p) => requireFile(p, 'weights'))
  if (splitCount > 1) {
    const shards = (inputs.weights as string[]).map((p) => /^(.*)-(\d{5})-of-(\d{5})\.gguf$/.exec(p))
    check(
      shards.every(
        (s, i) => s && Number(s[3]) === splitCount && Number(s[2]) === i + 1 && s[1] === shards[0]?.[1]
      ),
      'incomplete or mixed shards'
    )
  }
  if (profile?.externalEngram) {
    const prefix = String(inputs.weights[0]).replace(/-00001-of-\d{5}\.gguf$/, '')
    const final = String(splitCount).padStart(5, '0')
    const engram =
      profileId === 'ista-coder-dspark'
        ? 'DeepSeek-V4.1-Flash-Engram-IQ4_NL.gguf'
        : `${prefix}-${final}-of-${final}.gguf`
    check(
      inputs.engram === engram && inputs.engram_metadata === inputs.weights[0],
      'invalid final Engram shard'
    )
  }
  if (profile?.readyPack) {
    check(
      Array.isArray(inputs.pack_files) && same([...inputs.pack_files].sort(), packFiles),
      'invalid ready pack'
    )
    inputs.pack_files.forEach((p) => requireFile(p, 'pack'))
  }
  for (const [key, role] of Object.entries(roles)) requireFile(inputs[key], role)
  check(
    inputs.tokenizer_from === inputs.weights[0] &&
      inputs.chat_template_from === inputs.weights[0] &&
      inputs.drafting === drafting,
    'tokenizer/template/drafting'
  )
  check(
    family !== 'deepseek41' || inputs.experts_per_token === 6,
    'DeepSeek must preserve all six active experts'
  )
  check(referenced.size === files.size, 'unreferenced file')
  check(
    Array.isArray(d.compatible_variants) &&
      d.compatible_variants.length &&
      new Set(d.compatible_variants).size === d.compatible_variants.length,
    'host variants'
  )
  if (metalText)
    check(same(d.compatible_variants, ['macos-arm64-metal']), 'text-only DeepSeek requires Metal')
  for (const v of d.compatible_variants) {
    check(id(v), 'host variant')
    check(!profile || /-cuda(?:12|13)$/.test(v), 'CUDA-only profile')
    check(
      !(family === 'qwen36' && /metal|sycl|spark/.test(v)) &&
        !(family === 'deepseek41' && /sycl|cuda12/.test(v)),
      'unsupported family/backend'
    )
  }
  const caps = d.capabilities
  check(
    record(caps) &&
      caps.chat === true &&
      ['tools', 'reasoning', 'vision', 'structured_output'].every((k) => typeof caps[k] === 'boolean'),
    'capabilities'
  )
  keys(caps, ['chat', 'tools', 'reasoning', 'vision', 'structured_output'])
  if (metalText) check(caps.vision === false, 'text-only DeepSeek cannot declare vision')
  const req = d.requirements
  check(
    record(req) &&
      Number.isSafeInteger(bytes) &&
      req.download_bytes === bytes &&
      req.memory_accounting === 'separate-ram-vram-or-unified' &&
      req.resource_estimator === d.preparation_recipe_id &&
      req.requires_core_check === true,
    'resource accounting'
  )
  keys(req, [
    'download_bytes',
    'memory_accounting',
    'resource_estimator',
    'disk_components',
    'memory_components',
    'memory_modes',
    'requires_core_check',
  ])
  check(
    same(req.disk_components, ['sources', 'derivatives', 'temporary', 'previous-installation']) &&
      same(req.memory_components, ['ram', 'vram', 'unified-memory']) &&
      same(req.memory_modes, family === 'qwen36' ? ['auto', 'ram'] : ['auto', 'ram', 'ssd']),
    'resource components'
  )
  const capReq = d.capability_requirements
  check(
    record(capReq) &&
      same(capReq.vision, ['compatible-picture-reader']) &&
      same(capReq.structured_output, ['full-json-schema-validator']) &&
      same(capReq.drafting, ['verified-family-profile']),
    'capability prerequisites'
  )
  keys(capReq, ['vision', 'structured_output', 'drafting'])
  const q = d.qualification
  check(
    record(q) &&
      ['upstream-supported', 'atomic-qualified'].includes(String(q.status)) &&
      Array.isArray(q.evidence) &&
      q.evidence.length &&
      q.evidence.every((v) => {
        if (typeof v !== 'string') return false
        try {
          const url = new URL(v)
          return url.protocol === 'https:' && !url.username && !url.password
        } catch {
          return false
        }
      }),
    'qualification'
  )
  keys(q, ['status', 'evidence'])
  return structuredClone(d) as unknown as StrataModelDescriptor
}

export function parseStrataDefinition(entry: AtomicCatalogEntry): StrataModelDescriptor {
  check(
    (entry.kind === 'strata' || entry.kind === 'strata-cuda' || entry.kind === 'strata-profile') &&
      entry.format === 'strata' &&
      entry.files === undefined &&
      entry.omit_revisions === undefined,
    'catalog format'
  )
  const d = parseStrataDescriptor(entry.definition)
  check((d.profile_id !== undefined) === (entry.kind === 'strata-profile'), 'entry profile')
  if (!d.profile_id)
    check(Boolean(strataCudaProfile(d.variant_id)) === (entry.kind === 'strata-cuda'), 'entry kind')
  check(
    Object.keys(entry.variants).length === 1 &&
      Object.hasOwn(entry.variants, d.variant_id) &&
      entry.variants[d.variant_id]?.family === d.family,
    'catalog variant'
  )
  return d
}

/** Older clients keep reading the original collection without parsing CUDA-only profiles. */
export function projectStrataCollection(catalog: AtomicModelCatalog) {
  const seen = new Set<string>()
  const models: StrataModelDescriptor[] = []
  for (const [name, kind] of [
    ['strata-models', 'strata'],
    ['strata-cuda-models', 'strata-cuda'],
    ['strata-profile-models', 'strata-profile'],
  ] as const) {
    const collection = catalog.collections[name]
    if (collection === undefined) continue
    check(
      record(collection.header) &&
        collection.header.schema_version === 1 &&
        Array.isArray(collection.entries),
      'collection'
    )
    for (const ref of collection.entries) {
      check(
        record(ref) &&
          typeof ref.model === 'string' &&
          Object.hasOwn(catalog.models, ref.model) &&
          catalog.models[ref.model]?.kind === kind,
        'collection reference'
      )
      const d = parseStrataDefinition(catalog.models[ref.model]!)
      check(ref.variant === d.variant_id, 'collection variant')
      check(!seen.has(d.variant_id), 'duplicate variant id')
      seen.add(d.variant_id)
      models.push(d)
    }
  }
  return { schema_version: 1, models }
}
