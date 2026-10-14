/**
 * Remote media: the image and video models cloud providers and self-hosted servers offer through the
 * core (ADR 2026-10-13-remote-media-shares-the-diffusion-job-table). The catalog shapes are conf's
 * `providers/media.json` as the core serves it (snake_case, like the cloud provider routes); what a
 * generation request carries for a remote model sits in the camelCase diffusion requests
 * (`target`, `remote`).
 */

/** The adapters the core has: one per media API it speaks. */
export const MEDIA_DIALECTS = [
  'openai-images',
  'xai-images',
  'openrouter-images',
  'gemini-image',
  'minimax-image',
  'dashscope-image',
  'hf-images',
  'nvidia-genai',
  'mistral-agent-image',
  'a1111',
  'openai-videos',
  'openrouter-videos',
  'xai-videos',
  'gemini-veo',
  'minimax-video',
  'minimax-video-v2',
  'dashscope-video',
  'aimlapi-videos',
  'hf-videos',
] as const
export type MediaDialect = (typeof MEDIA_DIALECTS)[number]

export type MediaKind = 'image' | 'video'

/** Which kind of media each dialect makes. */
export const MEDIA_DIALECT_KIND: Readonly<Record<MediaDialect, MediaKind>> = {
  'openai-images': 'image',
  'xai-images': 'image',
  'openrouter-images': 'image',
  'gemini-image': 'image',
  'minimax-image': 'image',
  'dashscope-image': 'image',
  'hf-images': 'image',
  'nvidia-genai': 'image',
  'mistral-agent-image': 'image',
  'a1111': 'image',
  'openai-videos': 'video',
  'openrouter-videos': 'video',
  'xai-videos': 'video',
  'gemini-veo': 'video',
  'minimax-video': 'video',
  'minimax-video-v2': 'video',
  'dashscope-video': 'video',
  'aimlapi-videos': 'video',
  'hf-videos': 'video',
}

/** What a remote image model can be asked to do; a subset of `ImageWorkflowId`. */
export const REMOTE_IMAGE_WORKFLOWS = ['create', 'transform', 'inpaint', 'reference', 'edit'] as const
export type RemoteImageWorkflow = (typeof REMOTE_IMAGE_WORKFLOWS)[number]

export const REMOTE_VIDEO_WORKFLOWS = ['create', 'image-to-video'] as const
export type RemoteVideoWorkflow = (typeof REMOTE_VIDEO_WORKFLOWS)[number]

/** A closed list of values a control offers, with the one it starts on. */
export interface MediaChoice {
  values: string[]
  default?: string
}

export interface MediaNumberRange {
  min: number
  max: number
  default?: number
  step?: number
}

/** Pixel size: a list of `WxH` (and `auto`), or a free range on a grid. */
export type MediaSizeParam =
  | { kind: 'enum'; values: string[]; default?: string }
  | {
      kind: 'range'
      min: number
      max: number
      multiple: number
      default_width?: number
      default_height?: number
    }

/** What the generation form offers for an image model; a missing key is a hidden control. */
export interface MediaImageParams {
  size?: MediaSizeParam
  aspect_ratios?: MediaChoice
  resolutions?: MediaChoice
  n?: { max: number }
  seed?: boolean
  negative_prompt?: boolean
  quality?: MediaChoice
  background?: MediaChoice
  output_format?: MediaChoice
  steps?: MediaNumberRange
  cfg?: MediaNumberRange
  guidance?: MediaNumberRange
  strength?: MediaNumberRange
  /** The server lists samplers live (`MediaModelDescriptor.samplers`). */
  sampler?: boolean
  max_input_images?: number
}

/** Clip length in seconds: a list of values, or a range. */
export interface MediaDurations {
  values?: number[]
  min?: number
  max?: number
  default?: number
}

export interface MediaVideoParams {
  durations?: MediaDurations
  resolutions?: MediaChoice
  aspect_ratios?: MediaChoice
  sizes?: MediaChoice
  /** The model can generate sound; the form offers a switch. */
  audio?: boolean
  seed?: boolean
  negative_prompt?: boolean
  /** Image to video also takes a last frame. */
  last_frame?: boolean
}

export type MediaModelOptions = Record<string, string | number | boolean>

interface MediaModelCommon {
  id: string
  name: string
  description?: string
  /** The adapter that serves this model (the model's own, else its provider section's). */
  api: MediaDialect
  /** Offered as soon as the provider is connected. */
  default?: boolean
  options?: MediaModelOptions
  /** `catalog`: conf names it. `live`: only the provider's listing does; the dialect's defaults apply. */
  source: 'catalog' | 'live'
}

export interface ImageModelDescriptor extends MediaModelCommon {
  kind: 'image'
  workflows: RemoteImageWorkflow[]
  params: MediaImageParams
  /** Samplers the server listed, when `params.sampler` is set (A1111/Forge). */
  samplers?: string[]
}

export interface VideoModelDescriptor extends MediaModelCommon {
  kind: 'video'
  workflows: RemoteVideoWorkflow[]
  params: MediaVideoParams
}

export type MediaModelDescriptor = ImageModelDescriptor | VideoModelDescriptor

export interface MediaDialectDefaults {
  kind: MediaKind
  workflows: string[]
  params: MediaImageParams | MediaVideoParams
}

/** One provider's media, as `GET /atomic/v1/media/catalog` answers it. */
export interface MediaProviderSection {
  image?: { api: MediaDialect; models: ImageModelDescriptor[] }
  video?: { api: MediaDialect; models: VideoModelDescriptor[] }
}

/** `GET /atomic/v1/media/catalog`. */
export interface MediaCatalogView {
  catalog_version: number
  /** `live` when the conf document was fetched, `cache` from disk, `baseline` the bundled copy. */
  origin: 'live' | 'cache' | 'baseline'
  dialects: Partial<Record<MediaDialect, MediaDialectDefaults>>
  providers: Record<string, MediaProviderSection>
}

/** `GET /atomic/v1/media/providers/:provider/models?kind=`: the catalog's models plus the live listing. */
export interface MediaProviderModels {
  provider: string
  kind: MediaKind
  /** The adapter the provider's media of this kind go through; null when it has none. */
  api: MediaDialect | null
  models: MediaModelDescriptor[]
  /** Whether the provider was asked live; false for adapters without a listing. */
  live: boolean
  /** Why the live listing failed; the catalog's models are still answered. */
  error?: { code: string; message: string }
}

/** One enabled media model in a provider registration. */
export interface CloudProviderMediaModel {
  id: string
  kind: MediaKind
}

/**
 * The media part of `PUT /atomic/v1/cloud/providers/:provider`. Absent keeps what is stored, `null`
 * clears it. `image_api` / `video_api` name the adapter for a provider the catalog does not know
 * (a custom server); absent, the catalog's applies.
 */
export interface CloudProviderMedia {
  image_api?: MediaDialect | null
  video_api?: MediaDialect | null
  models: CloudProviderMediaModel[]
}

/** Which provider and model a generation request is for; absent on a request for the local model. */
export interface MediaTarget {
  provider: string
  model: string
}

/** Image settings only a remote model takes; every one optional, the model's default otherwise. */
export interface RemoteImageOptions {
  /** `auto` or `WxH`, for a model whose size is a list; a range model uses `width`/`height`. */
  size?: string
  aspectRatio?: string
  resolution?: string
  quality?: string
  background?: string
  outputFormat?: string
}

export interface RemoteVideoOptions {
  durationSecs?: number
  resolution?: string
  aspectRatio?: string
  /** `WxH`, for a model whose size is a list. */
  size?: string
  generateAudio?: boolean
}
