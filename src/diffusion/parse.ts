/**
 * Request bodies, read strictly. This stands where serde stood in the plugin: whole numbers where
 * Rust had `u32`/`u64`/`i64`, closed enums, `null` accepted for anything optional, unknown fields
 * ignored. A body that does not fit is `INVALID_REQUEST`, and nothing downstream has to doubt a
 * type again (ADR 2026-09-17-diffusion-speaks-the-apps-camelcase-and-error-codes-verbatim).
 */

import type {
  DiffusionBackend,
  DiffusionConfig,
  DiffusionEngineId,
  DiffusionFamilyDefaults,
  DiffusionFamilyRanges,
  DiffusionModality,
  DiffusionModelFiles,
  DiffusionOffloadPolicy,
  DiffusionVideoDefaults,
  FinalizeBackendInstallArgs,
  GalleryFlags,
  GalleryListOptions,
  ImageGenerateRequest,
  ImageSource,
  ImageWorkflowId,
  LoadDiffusionModelRequest,
  VideoGenerateRequest,
  VideoWorkflowId,
} from '../contracts/index.js'
import { diffusionError } from './errors.js'
import { isCanonicalBase64, stripDataUrl } from './validate.js'
import { IMAGE_WORKFLOWS, VIDEO_WORKFLOWS } from './workflow.js'

const U32_MAX = 0xffff_ffff

const ENGINES: readonly DiffusionEngineId[] = ['sd-cpp', 'diffusers']
const BACKENDS: readonly DiffusionBackend[] = ['cpu', 'metal', 'cuda', 'vulkan', 'rocm']
const OFFLOADS: readonly DiffusionOffloadPolicy[] = ['none', 'group', 'model']
const MODALITIES: readonly DiffusionModality[] = ['image', 'video']

type Fields = Record<string, unknown>

function invalid(field: string, expected: string): never {
  throw diffusionError('INVALID_REQUEST', 'The request is not valid.', `${field}: expected ${expected}`)
}

function fields(value: unknown, field: string): Fields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field, 'an object')
  return value as Fields
}

/** `undefined` for a field that is absent or `null`, which serde's `Option` treats alike. */
function present(source: Fields, key: string): unknown {
  const value = source[key]
  return value === null ? undefined : value
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(field, 'a string')
  return value
}

function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(field, 'a number')
  return value
}

function wholeNumber(value: unknown, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max)
    invalid(field, 'a whole number, zero or more')
  return value
}

function signedWholeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(field, 'a whole number')
  return value
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(field, 'true or false')
  return value
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value))
    invalid(field, `one of ${allowed.join(', ')}`)
  return value as T
}

/** Set `key` on `target` only when the source has a value, so absent stays absent on the way out. */
function copyOptional<T, K extends keyof T>(
  target: T,
  key: K,
  source: Fields,
  field: string,
  read: (value: unknown, field: string) => NonNullable<T[K]>
): void {
  const value = present(source, key as string)
  if (value !== undefined) target[key] = read(value, field)
}

const u32 = (value: unknown, field: string): number => wholeNumber(value, field, U32_MAX)
const u64 = (value: unknown, field: string): number => wholeNumber(value, field, Number.MAX_SAFE_INTEGER)

function pair(value: unknown, field: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) invalid(field, 'a pair of whole numbers')
  return [u32(value[0], `${field}[0]`), u32(value[1], `${field}[1]`)]
}

function parseFiles(value: unknown): DiffusionModelFiles {
  const source = fields(value, 'files')
  const files: DiffusionModelFiles = {
    diffusionModel: string(source['diffusionModel'], 'files.diffusionModel'),
  }
  for (const key of [
    'vae',
    'vaeFormat',
    'clipL',
    't5xxl',
    'llm',
    'llmVision',
    'qwen2vl',
    'audioVae',
    'embeddingsConnectors',
  ] as const)
    copyOptional(files, key, source, `files.${key}`, string)
  return files
}

function positive(value: unknown, field: string): number {
  const whole = u32(value, field)
  if (whole === 0) invalid(field, 'a whole number, one or more')
  return whole
}

function parseResolutionPresets(value: unknown, field: string): [number, number][] {
  if (!Array.isArray(value)) invalid(field, 'a list of [width, height] pairs')
  return value.map((item, index) => pair(item, `${field}[${index}]`))
}

function parseVideoDefaults(value: unknown, field: string): DiffusionVideoDefaults {
  const source = fields(value, field)
  return {
    fps: positive(source['fps'], `${field}.fps`),
    frames: positive(source['frames'], `${field}.frames`),
    frameStep: positive(source['frameStep'], `${field}.frameStep`),
    frameOffset: u32(source['frameOffset'], `${field}.frameOffset`),
    resolutionPresets: parseResolutionPresets(source['resolutionPresets'], `${field}.resolutionPresets`),
  }
}

function parseSigmas(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length === 0) invalid(field, 'a non-empty list of numbers')
  return value.map((item, index) => number(item, `${field}[${index}]`))
}

function parseDefaults(value: unknown): DiffusionFamilyDefaults {
  const source = fields(value, 'defaults')
  const defaults: DiffusionFamilyDefaults = {
    steps: u32(source['steps'], 'defaults.steps'),
    cfgScale: number(source['cfgScale'], 'defaults.cfgScale'),
    width: u32(source['width'], 'defaults.width'),
    height: u32(source['height'], 'defaults.height'),
  }
  copyOptional(defaults, 'guidance', source, 'defaults.guidance', number)
  copyOptional(defaults, 'samplingMethod', source, 'defaults.samplingMethod', string)
  copyOptional(defaults, 'flowShift', source, 'defaults.flowShift', number)
  copyOptional(defaults, 'sigmas', source, 'defaults.sigmas', parseSigmas)
  copyOptional(defaults, 'video', source, 'defaults.video', parseVideoDefaults)
  return defaults
}

function parseRanges(value: unknown): DiffusionFamilyRanges {
  const source = fields(value, 'ranges')
  const ranges: DiffusionFamilyRanges = {
    steps: pair(source['steps'], 'ranges.steps'),
    dims: pair(source['dims'], 'ranges.dims'),
    dimMultiple: u32(source['dimMultiple'], 'ranges.dimMultiple'),
  }
  copyOptional(ranges, 'frames', source, 'ranges.frames', pair)
  return ranges
}

export function parseLoadModelRequest(body: unknown): LoadDiffusionModelRequest {
  const source = fields(body, 'request')
  const request: LoadDiffusionModelRequest = {
    modelId: string(source['modelId'], 'modelId'),
    family: string(source['family'], 'family'),
    modality: oneOf(source['modality'], MODALITIES, 'modality'),
    displayName: string(source['displayName'], 'displayName'),
    files: parseFiles(source['files']),
    defaults: parseDefaults(source['defaults']),
    ranges: parseRanges(source['ranges']),
    offload: oneOf(source['offload'], OFFLOADS, 'offload'),
  }
  copyOptional(request, 'engine', source, 'engine', (value, field) => oneOf(value, ENGINES, field))
  copyOptional(request, 'threads', source, 'threads', u32)
  copyOptional(request, 'startupTimeoutSecs', source, 'startupTimeoutSecs', u64)
  // A video family must say how it counts frames, or nothing downstream can validate a request.
  if (request.modality === 'video') {
    if (request.defaults.video === undefined)
      invalid('defaults.video', 'the video defaults of a video family')
    if (request.ranges.frames === undefined) invalid('ranges.frames', 'the frame range of a video family')
  }
  return request
}

/** `{path}` is tried first, as the plugin's untagged enum did; an object with neither is refused. */
function parseSource(value: unknown, field: string): ImageSource {
  const source = fields(value, field)
  if (typeof source['path'] === 'string') return { path: source['path'] }
  if (typeof source['base64'] === 'string') return { base64: source['base64'] }
  return invalid(field, 'an image: {path} or {base64}')
}

export function parseImageGenerateRequest(body: unknown): ImageGenerateRequest {
  const source = fields(body, 'request')
  const request: ImageGenerateRequest = {
    prompt: string(source['prompt'], 'prompt'),
    width: u32(source['width'], 'width'),
    height: u32(source['height'], 'height'),
    steps: u32(source['steps'], 'steps'),
    cfgScale: number(source['cfgScale'], 'cfgScale'),
    batchSize: u32(source['batchSize'], 'batchSize'),
  }
  copyOptional(request, 'negativePrompt', source, 'negativePrompt', string)
  copyOptional(request, 'guidance', source, 'guidance', number)
  copyOptional(request, 'seed', source, 'seed', signedWholeNumber)
  copyOptional(request, 'samplingMethod', source, 'samplingMethod', string)
  copyOptional(request, 'flowShift', source, 'flowShift', number)
  copyOptional(request, 'workflow', source, 'workflow', (value, field) =>
    oneOf<ImageWorkflowId>(value, IMAGE_WORKFLOWS, field)
  )
  copyOptional(request, 'initImage', source, 'initImage', parseSource)
  copyOptional(request, 'maskImage', source, 'maskImage', parseSource)
  copyOptional(request, 'referenceImages', source, 'referenceImages', (value, field) => {
    if (!Array.isArray(value)) invalid(field, 'a list of images')
    return value.map((item, index) => parseSource(item, `${field}[${index}]`))
  })
  copyOptional(request, 'strength', source, 'strength', number)
  return request
}

export function parseVideoGenerateRequest(body: unknown): VideoGenerateRequest {
  const source = fields(body, 'request')
  const request: VideoGenerateRequest = {
    prompt: string(source['prompt'], 'prompt'),
    width: u32(source['width'], 'width'),
    height: u32(source['height'], 'height'),
    steps: u32(source['steps'], 'steps'),
    cfgScale: number(source['cfgScale'], 'cfgScale'),
  }
  copyOptional(request, 'negativePrompt', source, 'negativePrompt', string)
  copyOptional(request, 'frames', source, 'frames', u32)
  copyOptional(request, 'fps', source, 'fps', u32)
  copyOptional(request, 'guidance', source, 'guidance', number)
  copyOptional(request, 'seed', source, 'seed', signedWholeNumber)
  copyOptional(request, 'samplingMethod', source, 'samplingMethod', string)
  copyOptional(request, 'flowShift', source, 'flowShift', number)
  copyOptional(request, 'workflow', source, 'workflow', (value, field) =>
    oneOf<VideoWorkflowId>(value, VIDEO_WORKFLOWS, field)
  )
  copyOptional(request, 'initImage', source, 'initImage', parseSource)
  copyOptional(request, 'endImage', source, 'endImage', parseSource)
  return request
}

/** `{png}`: the poster the app rendered, as base64 (a data-URL prefix accepted); the bare payload. */
export function parseVideoPoster(body: unknown): string {
  const payload = stripDataUrl(string(fields(body, 'body')['png'], 'png'))
  if (payload === '' || !isCanonicalBase64(payload)) invalid('png', 'a base64 PNG')
  return payload
}

export function parseDiffusionConfig(body: unknown): DiffusionConfig {
  const source = fields(body, 'config')
  const config: DiffusionConfig = { dataFolder: string(source['dataFolder'], 'dataFolder') }
  copyOptional(config, 'outputDir', source, 'outputDir', string)
  copyOptional(config, 'videoOutputDir', source, 'videoOutputDir', string)
  copyOptional(config, 'idleUnloadSecs', source, 'idleUnloadSecs', u64)
  return config
}

export function parseFinalizeArgs(body: unknown): FinalizeBackendInstallArgs {
  const source = fields(body, 'args')
  const args: FinalizeBackendInstallArgs = {
    dir: string(source['dir'], 'dir'),
    tag: string(source['tag'], 'tag'),
    backendId: string(source['backendId'], 'backendId'),
    backend: oneOf(source['backend'], BACKENDS, 'backend'),
    engine: oneOf(source['engine'], ENGINES, 'engine'),
  }
  copyOptional(args, 'sha256', source, 'sha256', string)
  return args
}

export function parseGalleryListOptions(body: unknown): GalleryListOptions {
  const source = fields(body, 'options')
  const options: GalleryListOptions = {
    offset: u64(source['offset'], 'offset'),
    limit: u64(source['limit'], 'limit'),
  }
  copyOptional(options, 'includeArchived', source, 'includeArchived', boolean)
  return options
}

export function parseGalleryFlags(body: unknown): GalleryFlags {
  const source = fields(body, 'flags')
  const flags: GalleryFlags = {}
  copyOptional(flags, 'pinned', source, 'pinned', boolean)
  copyOptional(flags, 'archived', source, 'archived', boolean)
  return flags
}

/** One required string out of a body, for the routes that take nothing else (`path`, `dir`, `id`). */
export function requireString(body: unknown, key: string): string {
  return string(fields(body, 'body')[key], key)
}

export function requireStringList(body: unknown, key: string): string[] {
  const value = fields(body, 'body')[key]
  if (!Array.isArray(value)) invalid(key, 'a list of strings')
  return value.map((item, index) => string(item, `${key}[${index}]`))
}
