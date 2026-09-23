import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import {
  parseDiffusionConfig,
  parseFinalizeArgs,
  parseGalleryFlags,
  parseGalleryListOptions,
  parseImageGenerateRequest,
  parseLoadModelRequest,
  parseVideoGenerateRequest,
  parseVideoPoster,
  requireString,
  requireStringList,
} from './parse.js'

/** The details of the `INVALID_REQUEST` a parser raises. */
function refusal(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(AtomicCoreError)
    const core = error as AtomicCoreError
    expect(core.code).toBe('INVALID_REQUEST')
    expect(core.message).toBe('The request is not valid.')
    return core.details ?? ''
  }
  throw new Error('expected the parser to refuse')
}

const load = () => ({
  modelId: 'z-image:q4_k_m',
  family: 'z-image',
  modality: 'image',
  displayName: 'Z-Image Turbo',
  files: { diffusionModel: '/m/z.gguf', vae: '/m/ae.safetensors', llm: '/m/qwen.gguf' },
  defaults: { steps: 8, cfgScale: 1, width: 1024, height: 1024 },
  ranges: { steps: [1, 50], dims: [256, 2048], dimMultiple: 16 },
  offload: 'none',
})

describe('parseLoadModelRequest', () => {
  it('reads what the web app sends, and leaves absent optionals absent', () => {
    expect(parseLoadModelRequest(load())).toEqual(load())
    const full = {
      ...load(),
      files: {
        ...load().files,
        vaeFormat: 'flux2',
        clipL: '/c',
        t5xxl: '/t',
        llmVision: '/v',
        qwen2vl: '/q',
      },
      defaults: { ...load().defaults, guidance: 3.5, samplingMethod: 'euler', flowShift: 3 },
      engine: 'sd-cpp',
      threads: 6,
      startupTimeoutSecs: 900,
    }
    expect(parseLoadModelRequest(full)).toEqual(full)
  })

  it('treats null like absent and ignores fields it does not know', () => {
    const parsed = parseLoadModelRequest({
      ...load(),
      engine: null,
      threads: null,
      files: { diffusionModel: '/m/z.gguf', vae: null },
      somethingNew: true,
    })
    expect(parsed).not.toHaveProperty('engine')
    expect(parsed).not.toHaveProperty('threads')
    expect(parsed).not.toHaveProperty('somethingNew')
    expect(parsed.files).toEqual({ diffusionModel: '/m/z.gguf' })
  })

  it('refuses what serde refused', () => {
    expect(refusal(() => parseLoadModelRequest(null))).toBe('request: expected an object')
    expect(refusal(() => parseLoadModelRequest([]))).toBe('request: expected an object')
    expect(refusal(() => parseLoadModelRequest({ ...load(), modelId: 7 }))).toBe('modelId: expected a string')
    expect(refusal(() => parseLoadModelRequest({ ...load(), modality: 'audio' }))).toBe(
      'modality: expected one of image, video'
    )
    expect(refusal(() => parseLoadModelRequest({ ...load(), offload: 'all' }))).toBe(
      'offload: expected one of none, group, model'
    )
    expect(refusal(() => parseLoadModelRequest({ ...load(), engine: 'comfy' }))).toBe(
      'engine: expected one of sd-cpp, diffusers'
    )
    expect(refusal(() => parseLoadModelRequest({ ...load(), files: {} }))).toBe(
      'files.diffusionModel: expected a string'
    )
    expect(refusal(() => parseLoadModelRequest({ ...load(), files: 'x' }))).toBe('files: expected an object')
    expect(refusal(() => parseLoadModelRequest({ ...load(), threads: 2.5 }))).toBe(
      'threads: expected a whole number, zero or more'
    )
    expect(refusal(() => parseLoadModelRequest({ ...load(), threads: -1 }))).toBe(
      'threads: expected a whole number, zero or more'
    )
    expect(refusal(() => parseLoadModelRequest({ ...load(), threads: 2 ** 32 }))).toBe(
      'threads: expected a whole number, zero or more'
    )
    expect(
      refusal(() => parseLoadModelRequest({ ...load(), defaults: { ...load().defaults, cfgScale: '1' } }))
    ).toBe('defaults.cfgScale: expected a number')
    expect(
      refusal(() => parseLoadModelRequest({ ...load(), ranges: { ...load().ranges, steps: [1, 2, 3] } }))
    ).toBe('ranges.steps: expected a pair of whole numbers')
    expect(
      refusal(() => parseLoadModelRequest({ ...load(), ranges: { ...load().ranges, dims: [256, 'x'] } }))
    ).toBe('ranges.dims[1]: expected a whole number, zero or more')
  })
})

const generate = () => ({ prompt: 'a cat', width: 512, height: 768, steps: 8, cfgScale: 1, batchSize: 2 })

describe('parseImageGenerateRequest', () => {
  it('reads the required fields and every optional one', () => {
    expect(parseImageGenerateRequest(generate())).toEqual(generate())
    const full = {
      ...generate(),
      negativePrompt: 'blurry',
      guidance: 3.5,
      seed: -1,
      samplingMethod: 'euler',
      flowShift: 1.5,
      workflow: 'reference',
      initImage: { path: '/tmp/source.png' },
      maskImage: { base64: 'data:image/png;base64,QUJD' },
      referenceImages: [{ path: '/tmp/ref.png' }, { base64: 'QUJD' }],
      strength: 0.6,
    }
    expect(parseImageGenerateRequest(full)).toEqual(full)
  })

  it('prefers the path of a source that carries both, as the untagged enum did', () => {
    const parsed = parseImageGenerateRequest({ ...generate(), initImage: { path: '/p', base64: 'QUJD' } })
    expect(parsed.initImage).toEqual({ path: '/p' })
  })

  it('refuses fractions where Rust had integers, unknown workflows and shapeless sources', () => {
    expect(refusal(() => parseImageGenerateRequest({ ...generate(), steps: 8.5 }))).toBe(
      'steps: expected a whole number, zero or more'
    )
    expect(refusal(() => parseImageGenerateRequest({ ...generate(), width: -512 }))).toBe(
      'width: expected a whole number, zero or more'
    )
    expect(refusal(() => parseImageGenerateRequest({ ...generate(), seed: 1.5 }))).toBe(
      'seed: expected a whole number'
    )
    expect(refusal(() => parseImageGenerateRequest({ ...generate(), seed: 2 ** 60 }))).toBe(
      'seed: expected a whole number'
    )
    expect(refusal(() => parseImageGenerateRequest({ ...generate(), prompt: undefined }))).toBe(
      'prompt: expected a string'
    )
    expect(refusal(() => parseImageGenerateRequest({ ...generate(), workflow: 'animate' }))).toBe(
      'workflow: expected one of create, transform, inpaint, extend, upscale, reference, edit'
    )
    expect(refusal(() => parseImageGenerateRequest({ ...generate(), initImage: {} }))).toBe(
      'initImage: expected an image: {path} or {base64}'
    )
    expect(refusal(() => parseImageGenerateRequest({ ...generate(), initImage: 'x.png' }))).toBe(
      'initImage: expected an object'
    )
    expect(refusal(() => parseImageGenerateRequest({ ...generate(), referenceImages: {} }))).toBe(
      'referenceImages: expected a list of images'
    )
    expect(refusal(() => parseImageGenerateRequest({ ...generate(), referenceImages: [{ path: 1 }] }))).toBe(
      'referenceImages[0]: expected an image: {path} or {base64}'
    )
    expect(refusal(() => parseImageGenerateRequest({ ...generate(), cfgScale: Number.NaN }))).toBe(
      'cfgScale: expected a number'
    )
  })
})

describe('the small bodies', () => {
  it('reads the configuration', () => {
    expect(parseDiffusionConfig({ dataFolder: '/data' })).toEqual({ dataFolder: '/data' })
    expect(parseDiffusionConfig({ dataFolder: '/data', outputDir: '/pics', idleUnloadSecs: 0 })).toEqual({
      dataFolder: '/data',
      outputDir: '/pics',
      idleUnloadSecs: 0,
    })
    expect(parseDiffusionConfig({ dataFolder: '/data', outputDir: null, idleUnloadSecs: null })).toEqual({
      dataFolder: '/data',
    })
    expect(parseDiffusionConfig({ dataFolder: '/data', videoOutputDir: '/clips' })).toEqual({
      dataFolder: '/data',
      videoOutputDir: '/clips',
    })
    expect(refusal(() => parseDiffusionConfig({ dataFolder: '/d', videoOutputDir: 7 }))).toBe(
      'videoOutputDir: expected a string'
    )
    expect(refusal(() => parseDiffusionConfig({}))).toBe('dataFolder: expected a string')
    expect(refusal(() => parseDiffusionConfig({ dataFolder: '/d', idleUnloadSecs: -5 }))).toBe(
      'idleUnloadSecs: expected a whole number, zero or more'
    )
  })

  it('reads the arguments of a finished engine install', () => {
    const args = {
      dir: '/d/b',
      tag: 'master-849-d04e895',
      backendId: 'macos-arm64',
      backend: 'metal',
      engine: 'sd-cpp',
    }
    expect(parseFinalizeArgs(args)).toEqual(args)
    expect(parseFinalizeArgs({ ...args, sha256: 'abc' })).toEqual({ ...args, sha256: 'abc' })
    expect(refusal(() => parseFinalizeArgs({ ...args, backend: 'opencl' }))).toBe(
      'backend: expected one of cpu, metal, cuda, vulkan, rocm'
    )
    expect(refusal(() => parseFinalizeArgs({ ...args, engine: undefined }))).toBe(
      'engine: expected one of sd-cpp, diffusers'
    )
  })

  it('reads gallery options and flags', () => {
    expect(parseGalleryListOptions({ offset: 0, limit: 40 })).toEqual({ offset: 0, limit: 40 })
    expect(parseGalleryListOptions({ offset: 40, limit: 40, includeArchived: true })).toEqual({
      offset: 40,
      limit: 40,
      includeArchived: true,
    })
    expect(refusal(() => parseGalleryListOptions({ offset: 0 }))).toBe(
      'limit: expected a whole number, zero or more'
    )
    expect(refusal(() => parseGalleryListOptions({ offset: 0, limit: 1, includeArchived: 'yes' }))).toBe(
      'includeArchived: expected true or false'
    )
    expect(parseGalleryFlags({})).toEqual({})
    expect(parseGalleryFlags({ pinned: true, archived: null })).toEqual({ pinned: true })
    expect(refusal(() => parseGalleryFlags({ archived: 1 }))).toBe('archived: expected true or false')
  })

  it('pulls one string, or a list of them, out of a body', () => {
    expect(requireString({ path: '/x' }, 'path')).toBe('/x')
    expect(refusal(() => requireString({}, 'path'))).toBe('path: expected a string')
    expect(refusal(() => requireString('x', 'path'))).toBe('body: expected an object')
    expect(requireStringList({ ids: ['a', 'b'] }, 'ids')).toEqual(['a', 'b'])
    expect(requireStringList({ ids: [] }, 'ids')).toEqual([])
    expect(refusal(() => requireStringList({ ids: 'a' }, 'ids'))).toBe('ids: expected a list of strings')
    expect(refusal(() => requireStringList({ ids: ['a', 2] }, 'ids'))).toBe('ids[1]: expected a string')
  })
})

const videoLoad = () => ({
  ...load(),
  modelId: 'ltx-2:q4_k_m',
  family: 'ltx-2',
  modality: 'video',
  displayName: 'LTX-2.3 Distilled',
  files: {
    diffusionModel: '/m/ltx.gguf',
    vae: '/m/video_vae.safetensors',
    audioVae: '/m/audio_vae.safetensors',
    llm: '/m/gemma.gguf',
    embeddingsConnectors: '/m/connectors.safetensors',
  },
  defaults: {
    steps: 8,
    cfgScale: 1,
    width: 768,
    height: 512,
    sigmas: [1, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875],
    video: {
      fps: 24,
      frames: 121,
      frameStep: 8,
      frameOffset: 1,
      resolutionPresets: [
        [768, 512],
        [704, 1216],
      ],
    },
  },
  ranges: { steps: [1, 50], dims: [256, 1216], dimMultiple: 32, frames: [9, 257] },
})

describe('parseLoadModelRequest for a video family', () => {
  it('reads the video files, the video defaults, the sigma schedule and the frame range', () => {
    expect(parseLoadModelRequest(videoLoad())).toEqual(videoLoad())
  })

  it('demands the video defaults and the frame range of a video family, and only of one', () => {
    const noVideo = { ...videoLoad(), defaults: { ...videoLoad().defaults, video: undefined } }
    expect(refusal(() => parseLoadModelRequest(noVideo))).toBe(
      'defaults.video: expected the video defaults of a video family'
    )
    const noRange = { ...videoLoad(), ranges: { ...videoLoad().ranges, frames: null } }
    expect(refusal(() => parseLoadModelRequest(noRange))).toBe(
      'ranges.frames: expected the frame range of a video family'
    )
    // An image family may carry a video block; it is read and ignored downstream.
    const image = { ...load(), defaults: { ...load().defaults, video: videoLoad().defaults.video } }
    expect(parseLoadModelRequest(image).defaults.video).toEqual(videoLoad().defaults.video)
  })

  it('refuses a malformed video block', () => {
    const withVideo = (video: unknown) => ({ ...videoLoad(), defaults: { ...videoLoad().defaults, video } })
    const video = videoLoad().defaults.video
    expect(refusal(() => parseLoadModelRequest(withVideo('x')))).toBe('defaults.video: expected an object')
    expect(refusal(() => parseLoadModelRequest(withVideo({ ...video, fps: 0 })))).toBe(
      'defaults.video.fps: expected a whole number, one or more'
    )
    expect(refusal(() => parseLoadModelRequest(withVideo({ ...video, frameStep: 0 })))).toBe(
      'defaults.video.frameStep: expected a whole number, one or more'
    )
    expect(refusal(() => parseLoadModelRequest(withVideo({ ...video, frameOffset: -1 })))).toBe(
      'defaults.video.frameOffset: expected a whole number, zero or more'
    )
    expect(refusal(() => parseLoadModelRequest(withVideo({ ...video, resolutionPresets: [[768]] })))).toBe(
      'defaults.video.resolutionPresets[0]: expected a pair of whole numbers'
    )
    expect(refusal(() => parseLoadModelRequest(withVideo({ ...video, resolutionPresets: 'x' })))).toBe(
      'defaults.video.resolutionPresets: expected a list of [width, height] pairs'
    )
    const withSigmas = (sigmas: unknown) => ({
      ...videoLoad(),
      defaults: { ...videoLoad().defaults, sigmas },
    })
    expect(refusal(() => parseLoadModelRequest(withSigmas([])))).toBe(
      'defaults.sigmas: expected a non-empty list of numbers'
    )
    expect(refusal(() => parseLoadModelRequest(withSigmas([1, 'x'])))).toBe(
      'defaults.sigmas[1]: expected a number'
    )
  })
})

const generateVideo = () => ({ prompt: 'a cat', width: 768, height: 512, steps: 8, cfgScale: 1 })

describe('parseVideoGenerateRequest', () => {
  it('reads the required fields and every optional one', () => {
    expect(parseVideoGenerateRequest(generateVideo())).toEqual(generateVideo())
    const full = {
      ...generateVideo(),
      negativePrompt: 'blurry',
      frames: 49,
      fps: 24,
      guidance: 3.5,
      seed: -1,
      samplingMethod: 'euler',
      flowShift: 3,
      workflow: 'image-to-video',
      initImage: { path: '/tmp/first.png' },
      endImage: { base64: 'QUJD' },
    }
    expect(parseVideoGenerateRequest(full)).toEqual(full)
    expect(parseVideoGenerateRequest({ ...generateVideo(), frames: null, fps: null })).toEqual(
      generateVideo()
    )
  })

  it('refuses what does not fit', () => {
    expect(refusal(() => parseVideoGenerateRequest({ ...generateVideo(), frames: 24.5 }))).toBe(
      'frames: expected a whole number, zero or more'
    )
    expect(refusal(() => parseVideoGenerateRequest({ ...generateVideo(), fps: '24' }))).toBe(
      'fps: expected a whole number, zero or more'
    )
    expect(refusal(() => parseVideoGenerateRequest({ ...generateVideo(), workflow: 'transform' }))).toBe(
      'workflow: expected one of create, image-to-video'
    )
    expect(refusal(() => parseVideoGenerateRequest({ ...generateVideo(), endImage: {} }))).toBe(
      'endImage: expected an image: {path} or {base64}'
    )
    expect(refusal(() => parseVideoGenerateRequest({ ...generateVideo(), prompt: 7 }))).toBe(
      'prompt: expected a string'
    )
  })
})

describe('parseVideoPoster', () => {
  it('takes the base64 PNG, with or without a data-URL prefix, and nothing else', () => {
    expect(parseVideoPoster({ png: 'iVBORw0KGgo=' })).toBe('iVBORw0KGgo=')
    expect(parseVideoPoster({ png: 'data:image/png;base64,iVBORw0KGgo=' })).toBe('iVBORw0KGgo=')
    expect(refusal(() => parseVideoPoster({ png: '' }))).toBe('png: expected a base64 PNG')
    expect(refusal(() => parseVideoPoster({ png: 'not base64!' }))).toBe('png: expected a base64 PNG')
    expect(refusal(() => parseVideoPoster({ png: 7 }))).toBe('png: expected a string')
    expect(refusal(() => parseVideoPoster(null))).toBe('body: expected an object')
  })
})
