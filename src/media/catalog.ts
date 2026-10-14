/**
 * The remote media catalog (conf `providers/media.json`), parsed leniently: conf reaches every
 * released core within an hour, so an entry this core cannot read (a dialect it has no adapter for,
 * a parameter it does not know) is dropped or ignored, never the whole document. Pure.
 */

import {
  MEDIA_DIALECT_KIND,
  MEDIA_DIALECTS,
  REMOTE_IMAGE_WORKFLOWS,
  REMOTE_VIDEO_WORKFLOWS,
} from '../contracts/index.js'
import type {
  ImageModelDescriptor,
  MediaChoice,
  MediaDialect,
  MediaDialectDefaults,
  MediaDurations,
  MediaImageParams,
  MediaKind,
  MediaModelDescriptor,
  MediaModelOptions,
  MediaNumberRange,
  MediaProviderSection,
  MediaSizeParam,
  MediaVideoParams,
  RemoteImageWorkflow,
  RemoteVideoWorkflow,
  VideoModelDescriptor,
} from '../contracts/index.js'

export const MEDIA_CATALOG_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/providers/media.json'
export const SUPPORTED_MEDIA_SCHEMA_VERSION = 1

export interface MediaCatalog {
  catalog_version: number
  dialects: Partial<Record<MediaDialect, MediaDialectDefaults>>
  providers: Record<string, MediaProviderSection>
}

type Fields = Record<string, unknown>

const isObject = (value: unknown): value is Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === 'string' && value !== ''
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export const isMediaDialect = (value: unknown): value is MediaDialect =>
  typeof value === 'string' && (MEDIA_DIALECTS as readonly string[]).includes(value)

function choice(value: unknown): MediaChoice | undefined {
  if (!isObject(value) || !Array.isArray(value['values'])) return undefined
  const values = value['values'].filter(isString)
  if (values.length === 0) return undefined
  const fallback = value['default']
  return isString(fallback) && values.includes(fallback) ? { values, default: fallback } : { values }
}

function range(value: unknown): MediaNumberRange | undefined {
  if (!isObject(value) || !isNumber(value['min']) || !isNumber(value['max'])) return undefined
  if (value['min'] > value['max']) return undefined
  const out: MediaNumberRange = { min: value['min'], max: value['max'] }
  const fallback = value['default']
  if (isNumber(fallback) && fallback >= out.min && fallback <= out.max) out.default = fallback
  if (isNumber(value['step']) && value['step'] > 0) out.step = value['step']
  return out
}

const SIZE_TEXT = /^(auto|[1-9][0-9]*x[1-9][0-9]*)$/

function size(value: unknown): MediaSizeParam | undefined {
  if (!isObject(value)) return undefined
  if (value['kind'] === 'enum') {
    const listed = choice(value)
    if (!listed) return undefined
    const values = listed.values.filter((v) => SIZE_TEXT.test(v))
    if (values.length === 0) return undefined
    return listed.default !== undefined && values.includes(listed.default)
      ? { kind: 'enum', values, default: listed.default }
      : { kind: 'enum', values }
  }
  if (value['kind'] === 'range') {
    const { min, max, multiple } = value
    if (!isNumber(min) || !isNumber(max) || !isNumber(multiple) || min > max || multiple < 1) return undefined
    const out: MediaSizeParam = { kind: 'range', min, max, multiple }
    for (const key of ['default_width', 'default_height'] as const) {
      const dim = value[key]
      if (isNumber(dim) && dim >= min && dim <= max) out[key] = dim
    }
    return out
  }
  return undefined
}

/** An image model's parameters; each one that does not read is left out. */
export function parseImageParams(value: unknown): MediaImageParams {
  if (!isObject(value)) return {}
  const out: MediaImageParams = {}
  const sized = size(value['size'])
  if (sized) out.size = sized
  for (const key of ['aspect_ratios', 'resolutions', 'quality', 'background', 'output_format'] as const) {
    const listed = choice(value[key])
    if (listed) out[key] = listed
  }
  for (const key of ['steps', 'cfg', 'guidance', 'strength'] as const) {
    const ranged = range(value[key])
    if (ranged) out[key] = ranged
  }
  const n = value['n']
  if (isObject(n) && isNumber(n['max']) && Number.isInteger(n['max']) && n['max'] >= 1)
    out.n = { max: Math.min(n['max'], 10) }
  for (const key of ['seed', 'negative_prompt', 'sampler'] as const) if (value[key] === true) out[key] = true
  const inputs = value['max_input_images']
  if (isNumber(inputs) && Number.isInteger(inputs) && inputs >= 1) out.max_input_images = Math.min(inputs, 16)
  return out
}

function durations(value: unknown): MediaDurations | undefined {
  if (!isObject(value)) return undefined
  const listed = Array.isArray(value['values']) ? value['values'].filter((v) => isNumber(v) && v > 0) : []
  const fallback = value['default']
  if (listed.length > 0) {
    const out: MediaDurations = { values: listed as number[] }
    if (isNumber(fallback) && listed.includes(fallback)) out.default = fallback
    return out
  }
  const { min, max } = value
  if (!isNumber(min) || !isNumber(max) || min <= 0 || min > max) return undefined
  const out: MediaDurations = { min, max }
  if (isNumber(fallback) && fallback >= min && fallback <= max) out.default = fallback
  return out
}

/** A video model's parameters; each one that does not read is left out. */
export function parseVideoParams(value: unknown): MediaVideoParams {
  if (!isObject(value)) return {}
  const out: MediaVideoParams = {}
  const lengths = durations(value['durations'])
  if (lengths) out.durations = lengths
  for (const key of ['resolutions', 'aspect_ratios', 'sizes'] as const) {
    const listed = choice(value[key])
    if (listed) out[key] = listed
  }
  for (const key of ['audio', 'seed', 'negative_prompt', 'last_frame'] as const)
    if (value[key] === true) out[key] = true
  return out
}

function options(value: unknown): MediaModelOptions | undefined {
  if (!isObject(value)) return undefined
  const out: MediaModelOptions = {}
  for (const [key, item] of Object.entries(value))
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') out[key] = item
  return Object.keys(out).length > 0 ? out : undefined
}

function workflowsOf(kind: MediaKind, value: unknown): string[] {
  const known: readonly string[] = kind === 'image' ? REMOTE_IMAGE_WORKFLOWS : REMOTE_VIDEO_WORKFLOWS
  return Array.isArray(value)
    ? [...new Set(value.filter((w): w is string => isString(w) && known.includes(w)))]
    : []
}

/** One catalog model, or `undefined` when its adapter, id or workflows are unusable here. */
export function parseCatalogModel(
  kind: MediaKind,
  sectionApi: MediaDialect,
  raw: unknown
): MediaModelDescriptor | undefined {
  if (!isObject(raw) || !isString(raw['id'])) return undefined
  const own = raw['api']
  if (own !== undefined && !isMediaDialect(own)) return undefined
  const api = own ?? sectionApi
  if (MEDIA_DIALECT_KIND[api] !== kind) return undefined
  const workflows = workflowsOf(kind, raw['workflows'])
  if (workflows.length === 0) return undefined
  const common = {
    id: raw['id'],
    name: isString(raw['name']) ? raw['name'] : raw['id'],
    api,
    source: 'catalog' as const,
    ...(isString(raw['description']) ? { description: raw['description'] } : {}),
    ...(raw['default'] === true ? { default: true } : {}),
  }
  const extra = options(raw['options'])
  if (kind === 'image') {
    const model: ImageModelDescriptor = {
      ...common,
      kind: 'image',
      workflows: workflows as RemoteImageWorkflow[],
      params: parseImageParams(raw['params']),
    }
    if (extra) model.options = extra
    return model
  }
  const model: VideoModelDescriptor = {
    ...common,
    kind: 'video',
    workflows: workflows as RemoteVideoWorkflow[],
    params: parseVideoParams(raw['params']),
  }
  if (extra) model.options = extra
  return model
}

function section(
  kind: MediaKind,
  raw: unknown
): { api: MediaDialect; models: MediaModelDescriptor[] } | undefined {
  if (!isObject(raw) || !isMediaDialect(raw['api']) || MEDIA_DIALECT_KIND[raw['api']] !== kind)
    return undefined
  const api = raw['api']
  const models: MediaModelDescriptor[] = []
  const seen = new Set<string>()
  let defaults = 0
  for (const item of Array.isArray(raw['models']) ? raw['models'] : []) {
    const model = parseCatalogModel(kind, api, item)
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    // At most one default per provider and kind: the first one wins.
    if (model.default && defaults++ > 0) delete model.default
    models.push(model)
  }
  return { api, models }
}

/** conf's document, or `undefined` when it is not a catalog this core reads at all. */
export function parseMediaCatalog(raw: unknown): MediaCatalog | undefined {
  if (!isObject(raw) || raw['schema_version'] !== SUPPORTED_MEDIA_SCHEMA_VERSION) return undefined
  const version = raw['catalog_version']
  if (!isNumber(version) || !Number.isInteger(version) || version < 1) return undefined
  const dialects: MediaCatalog['dialects'] = {}
  if (isObject(raw['dialects']))
    for (const [name, value] of Object.entries(raw['dialects'])) {
      if (!isMediaDialect(name) || !isObject(value)) continue
      const kind = MEDIA_DIALECT_KIND[name]
      const workflows = workflowsOf(kind, value['workflows'])
      if (workflows.length === 0) continue
      dialects[name] = {
        kind,
        workflows,
        params: kind === 'image' ? parseImageParams(value['params']) : parseVideoParams(value['params']),
      }
    }
  const providers: MediaCatalog['providers'] = {}
  if (isObject(raw['providers']))
    for (const [name, value] of Object.entries(raw['providers'])) {
      if (!isObject(value)) continue
      const entry: MediaProviderSection = {}
      const image = section('image', value['image'])
      const video = section('video', value['video'])
      if (image) entry.image = image as NonNullable<MediaProviderSection['image']>
      if (video) entry.video = video as NonNullable<MediaProviderSection['video']>
      if (entry.image || entry.video) providers[name] = entry
    }
  return { catalog_version: version, dialects, providers }
}

/**
 * The adapter a provider's media of `kind` go through: the registration's own (a custom server)
 * first, then the catalog's; `undefined` when it has none.
 */
export function providerDialect(
  catalog: MediaCatalog,
  provider: string,
  kind: MediaKind,
  override?: MediaDialect | null
): MediaDialect | undefined {
  if (override && MEDIA_DIALECT_KIND[override] === kind) return override
  return catalog.providers[provider]?.[kind]?.api
}

/** A model the catalog does not name, described by its adapter's defaults. */
export function defaultDescriptor(
  catalog: MediaCatalog,
  kind: MediaKind,
  api: MediaDialect,
  id: string,
  name?: string
): MediaModelDescriptor {
  const defaults = catalog.dialects[api]
  const base = { id, name: name ?? id, api, source: 'live' as const }
  if (kind === 'image')
    return {
      ...base,
      kind: 'image',
      workflows: (defaults?.workflows ?? ['create']) as RemoteImageWorkflow[],
      params: structuredClone((defaults?.params ?? {}) as MediaImageParams),
    }
  return {
    ...base,
    kind: 'video',
    workflows: (defaults?.workflows ?? ['create']) as RemoteVideoWorkflow[],
    params: structuredClone((defaults?.params ?? {}) as MediaVideoParams),
  }
}

/**
 * What a model is: the catalog's entry under its provider when there is one (its own adapter
 * applies), else the adapter's defaults.
 */
export function describeModel(
  catalog: MediaCatalog,
  provider: string,
  kind: MediaKind,
  api: MediaDialect,
  id: string
): MediaModelDescriptor {
  const listed = catalog.providers[provider]?.[kind]?.models.find((model) => model.id === id)
  if (listed) return structuredClone(listed)
  return defaultDescriptor(catalog, kind, api, id)
}

/** A model a provider listed live, with whatever its listing said about it. */
export interface LiveMediaModel {
  id: string
  name?: string
  description?: string
  workflows?: string[]
  params?: MediaImageParams | MediaVideoParams
  options?: MediaModelOptions
  samplers?: string[]
}

/**
 * The catalog's models of a provider, then what its listing adds: a model both name keeps the
 * catalog's description (with the listing's samplers); a model only the listing names takes the
 * listing's parameters over the adapter's defaults.
 */
export function mergeLiveModels(
  catalog: MediaCatalog,
  provider: string,
  kind: MediaKind,
  api: MediaDialect,
  live: readonly LiveMediaModel[]
): MediaModelDescriptor[] {
  const out = (catalog.providers[provider]?.[kind]?.models ?? []).map((model) => structuredClone(model))
  const byId = new Map(out.map((model) => [model.id, model]))
  for (const entry of live) {
    const known = byId.get(entry.id)
    if (known) {
      if (known.kind === 'image' && entry.samplers?.length) known.samplers = [...entry.samplers]
      continue
    }
    const model = defaultDescriptor(catalog, kind, api, entry.id, entry.name)
    if (entry.description) model.description = entry.description
    const workflows = workflowsOf(kind, entry.workflows)
    if (workflows.length > 0) model.workflows = workflows as never
    if (entry.params) model.params = structuredClone(entry.params) as never
    if (entry.options) model.options = { ...entry.options }
    if (model.kind === 'image' && entry.samplers?.length) model.samplers = [...entry.samplers]
    byId.set(model.id, model)
    out.push(model)
  }
  return out
}
