import type { FastFlowLmDefinition } from '../contracts/index.js'
import { parseFastFlowLmDescriptor } from './fastflowlm-installation.js'
import type { AtomicCatalogEntry, AtomicModelCatalog } from './model-catalog.js'

export interface FastFlowLmCatalogOptions {
  allowCandidates?: boolean
}

const roles = ['weights', 'tokenizer', 'config', 'chat_template', 'kernels', 'metadata'] as const

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error('Invalid FastFlowLM catalog: ' + message)
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const matches = (v: unknown, pattern: RegExp): v is string => typeof v === 'string' && pattern.test(v)
/** Validate the complete installer plan before exposing any file to clients. */
export function parseFastFlowLmDefinition(
  entry: AtomicCatalogEntry,
  options: FastFlowLmCatalogOptions = {}
): FastFlowLmDefinition {
  const d = entry.definition
  check(
    entry.kind === 'fastflowlm' &&
      entry.format === 'fastflowlm' &&
      entry.files === undefined &&
      entry.omit_revisions === undefined,
    'format'
  )
  const descriptor = parseFastFlowLmDescriptor(d)
  check(
    Object.keys(entry.variants).length === 1 &&
      Object.hasOwn(entry.variants, descriptor.variant_id) &&
      record(entry.variants[descriptor.variant_id]),
    'variant'
  )
  check(
    typeof d.name === 'string' &&
      d.name.trim() &&
      typeof d.license === 'string' &&
      d.license.trim() &&
      typeof d.gated === 'boolean',
    'metadata'
  )
  const q = d.qualification
  check(
    record(q) &&
      (q.status === 'qualified' || q.status === 'candidate') &&
      Array.isArray(q.evidence) &&
      q.evidence.every((v) => matches(v, /^https:\/\//)) &&
      (q.status === 'candidate' || q.evidence.length > 0),
    'qualification'
  )
  check(q.status === 'qualified' || options.allowCandidates === true, 'unqualified candidate')
  const paths = new Map(descriptor.files.map((f) => [f.path.toLowerCase(), f.path]))
  check(record(d.components), 'components')
  const covered = new Set<string>()
  for (const role of roles) {
    const files = d.components[role]
    check(
      Array.isArray(files) &&
        (files.length || role === 'metadata' || role === 'kernels') &&
        new Set(files).size === files.length,
      role
    )
    for (const path of files) {
      check(typeof path === 'string' && paths.get(path.toLowerCase()) === path, role)
      covered.add(path)
    }
  }
  check(covered.size === paths.size, 'file outside component inventory')
  return structuredClone(d) as unknown as FastFlowLmDefinition
}

/** Older catalogs have no FLM collection. Each current reference selects exactly one full variant. */
export function projectFastFlowLmCollection(
  catalog: AtomicModelCatalog,
  options: FastFlowLmCatalogOptions = {}
) {
  const collection = catalog.collections['fastflowlm-models']
  if (collection === undefined) return { schema_version: 1, models: [] as FastFlowLmDefinition[] }
  check(
    record(collection) &&
      record(collection.header) &&
      collection.header.schema_version === 1 &&
      Array.isArray(collection.entries),
    'collection'
  )
  const seen = new Set<string>()
  const models = collection.entries.map((ref) => {
    check(
      record(ref) &&
        typeof ref.model === 'string' &&
        Object.hasOwn(catalog.models, ref.model) &&
        !seen.has(ref.model),
      'collection reference'
    )
    seen.add(ref.model)
    const entry = catalog.models[ref.model]!
    check(ref.variant === entry.definition.variant_id, 'collection variant')
    return parseFastFlowLmDefinition(entry, options)
  })
  return { ...collection.header, schema_version: 1, models }
}
