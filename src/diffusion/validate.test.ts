/**
 * Hand-ported from `validation_covers_every_range` and
 * `every_workflow_checks_its_inputs_and_the_family` in `jobs.rs` of `tauri-plugin-atomic-diffusion`
 * (app commit `ec1fd3ea7`).
 */
import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import type { ImageGenerateRequest, ImageSource, ImageWorkflowId } from '../contracts/index.js'
import type { ServerSpec } from './types.js'
import { isCanonicalBase64, stripDataUrl, validateRequest } from './validate.js'

const EXISTING = '/tmp/source.png'
const deps = { isFile: async (path: string) => path === EXISTING }

function spec(overrides: Partial<ServerSpec> = {}): ServerSpec {
  return {
    binaryDir: '/nonexistent',
    engine: 'sd-cpp',
    backend: 'cpu',
    backendId: 'test-cpu',
    tag: 'test-tag',
    modelId: 'z-image:q4_k_m',
    family: 'z-image',
    modality: 'image',
    displayName: 'Z-Image Turbo',
    files: { diffusionModel: '/models/z-image/z-image-turbo-Q4_K_M.gguf' },
    defaults: { steps: 4, cfgScale: 1.0, samplingMethod: 'euler', width: 512, height: 512 },
    ranges: { steps: [1, 50], dims: [256, 2048], dimMultiple: 16 },
    offload: 'none',
    extraArgs: [],
    startupTimeoutMs: 5_000,
    cpuFallback: false,
    ...overrides,
  }
}

function request(overrides: Partial<ImageGenerateRequest> = {}): ImageGenerateRequest {
  return {
    prompt: 'a cat',
    width: 512,
    height: 512,
    steps: 4,
    cfgScale: 1.0,
    seed: 1234,
    batchSize: 2,
    ...overrides,
  }
}

async function refusal(r: ImageGenerateRequest, s: ServerSpec = spec()): Promise<AtomicCoreError> {
  const error = await validateRequest(r, s, deps).then(
    () => undefined,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(AtomicCoreError)
  return error as AtomicCoreError
}

describe('validateRequest', () => {
  it('covers every range', async () => {
    await expect(validateRequest(request(), spec(), deps)).resolves.toBeUndefined()

    expect((await refusal(request({ prompt: '   ' }))).toJSON()).toEqual({
      code: 'INVALID_REQUEST',
      message: 'Enter a prompt.',
    })
    expect((await refusal(request({ width: 520 }))).toJSON()).toEqual({
      code: 'INVALID_DIMENSIONS',
      message: 'width must be a multiple of 16.',
      details: 'width=520',
    })
    expect((await refusal(request({ height: 4096 }))).toJSON()).toEqual({
      code: 'INVALID_DIMENSIONS',
      message: 'height must be between 256 and 2048.',
      details: 'height=4096',
    })
    expect((await refusal(request({ width: 128 }))).code).toBe('INVALID_DIMENSIONS')
    expect((await refusal(request({ steps: 51 }))).toJSON()).toEqual({
      code: 'INVALID_REQUEST',
      message: 'Steps must be between 1 and 50.',
      details: 'steps=51',
    })
    expect((await refusal(request({ batchSize: 5 }))).toJSON()).toEqual({
      code: 'INVALID_REQUEST',
      message: 'Batch size must be between 1 and 4.',
      details: 'batchSize=5',
    })
    expect((await refusal(request({ batchSize: 0 }))).code).toBe('INVALID_REQUEST')
    // The last image of the batch records seed + 3: it must still be exact as a double.
    await expect(
      validateRequest(request({ batchSize: 4, seed: Number.MAX_SAFE_INTEGER - 3 }), spec(), deps)
    ).resolves.toBeUndefined()
    expect((await refusal(request({ batchSize: 4, seed: Number.MAX_SAFE_INTEGER - 2 }))).toJSON()).toEqual({
      code: 'INVALID_REQUEST',
      message: `The seed must be at most ${Number.MAX_SAFE_INTEGER - 3} for a batch of 4.`,
      details: `seed=${Number.MAX_SAFE_INTEGER - 2}`,
    })
    await expect(validateRequest(request({ batchSize: 4, seed: -1 }), spec(), deps)).resolves.toBeUndefined()
    expect((await refusal(request({ cfgScale: -1 }))).message).toBe(
      'CFG scale must be a non-negative number.'
    )
    expect((await refusal(request({ cfgScale: Number.POSITIVE_INFINITY }))).code).toBe('INVALID_REQUEST')

    const transform = request({ workflow: 'transform' })
    const video = await refusal(transform, spec({ family: 'wan2.2-ti2v-5b' }))
    expect(video.toJSON()).toEqual({
      code: 'UNSUPPORTED_WORKFLOW',
      message: 'This model cannot run the transform workflow.',
      details: 'wan2.2-ti2v-5b',
    })
    // A transform without a source image.
    expect((await refusal(transform)).toJSON()).toEqual({
      code: 'INVALID_REQUEST',
      message: 'This workflow needs a source image.',
    })
    const withSource = { ...transform, initImage: { path: EXISTING } }
    expect((await refusal({ ...withSource, strength: 1.5 })).message).toBe(
      'Strength must be between 0 and 1.'
    )
    expect((await refusal({ ...withSource, strength: Number.NaN })).code).toBe('INVALID_REQUEST')
    await expect(validateRequest({ ...withSource, strength: 0.6 }, spec(), deps)).resolves.toBeUndefined()
  })

  it('treats a dimension multiple of zero as one', async () => {
    const loose = spec({ ranges: { steps: [1, 50], dims: [256, 2048], dimMultiple: 0 } })
    await expect(validateRequest(request({ width: 517 }), loose, deps)).resolves.toBeUndefined()
  })

  it('checks the strength even for a workflow that ignores it, and before the family', async () => {
    expect((await refusal(request({ strength: 2 }))).message).toBe('Strength must be between 0 and 1.')
    expect((await refusal(request({ workflow: 'edit', strength: 2 }))).message).toBe(
      'Strength must be between 0 and 1.'
    )
  })

  it('checks every workflow for its inputs and its family', async () => {
    const path: ImageSource = { path: EXISTING }
    const png: ImageSource = { base64: 'data:image/png;base64,iVBORw0KGgo=' }
    const withWorkflow = (workflow: ImageWorkflowId, more: Partial<ImageGenerateRequest> = {}) =>
      request({ workflow, ...more })

    // Inpaint / extend need the source and a mask; base64 masks are fine.
    for (const workflow of ['inpaint', 'extend'] as const) {
      const noMask = await refusal(withWorkflow(workflow, { initImage: path }))
      expect(noMask.toJSON(), workflow).toEqual({
        code: 'INVALID_REQUEST',
        message: 'This workflow needs a mask.',
      })
      await expect(
        validateRequest(withWorkflow(workflow, { initImage: path, maskImage: png }), spec(), deps)
      ).resolves.toBeUndefined()
      const badMask = await refusal(
        withWorkflow(workflow, { initImage: path, maskImage: { base64: 'not base64!' } })
      )
      expect(badMask.toJSON()).toEqual({
        code: 'INVALID_REQUEST',
        message: 'The inline image is not valid base64.',
      })
    }

    // Upscale is img2img: a source is enough.
    await expect(
      validateRequest(withWorkflow('upscale', { initImage: png }), spec(), deps)
    ).resolves.toBeUndefined()

    // A missing file is refused up front, not after the server spawned.
    const missing = await refusal(
      withWorkflow('transform', { initImage: { path: '/nonexistent/source.png' } })
    )
    expect(missing.toJSON()).toEqual({
      code: 'INVALID_REQUEST',
      message: 'The source image could not be found.',
      details: '/nonexistent/source.png',
    })

    // Reference / edit only on a family trained for it.
    const klein = spec({ family: 'flux.2-klein' })
    for (const workflow of ['reference', 'edit'] as const) {
      const r = withWorkflow(workflow, { initImage: path })
      expect((await refusal(r)).code, `${workflow} on z-image`).toBe('UNSUPPORTED_WORKFLOW')
      await expect(validateRequest(r, klein, deps), `${workflow} on klein`).resolves.toBeUndefined()
      const qwen21 = spec({ family: 'qwen-image-2.1' })
      expect(
        (await refusal(r, qwen21)).toJSON(),
        `${workflow} on Qwen Image 2.1 without --llm_vision`
      ).toEqual({
        code: 'SIDE_FILE_MISSING',
        message: 'Qwen Image 2.1 editing needs its Qwen3-VL vision projector.',
        details: 'Load the model with llmVision so sd.cpp receives --llm_vision.',
      })
      const withVision = spec({
        family: 'qwen-image-2.1',
        files: { ...qwen21.files, llmVision: '/models/mmproj.gguf' },
      })
      await expect(
        validateRequest(r, withVision, deps),
        `${workflow} on Qwen Image 2.1 with --llm_vision`
      ).resolves.toBeUndefined()
      const badRef = await refusal({ ...r, referenceImages: [{ path: '/nonexistent/ref.png' }] }, klein)
      expect(badRef.code).toBe('INVALID_REQUEST')
      await expect(
        validateRequest({ ...r, referenceImages: [png, path] }, klein, deps)
      ).resolves.toBeUndefined()
    }
  })

  it('holds Qwen-Image on Metal to one megapixel, after the ranges and before the steps', async () => {
    const qwen = spec({
      family: 'qwen-image',
      backend: 'metal',
      ranges: { steps: [1, 50], dims: [256, 2048], dimMultiple: 16 },
    })
    await expect(validateRequest(request({ width: 1024, height: 1024 }), qwen, deps)).resolves.toBeUndefined()
    expect((await refusal(request({ width: 1024, height: 1040, steps: 999 }), qwen)).toJSON()).toEqual({
      code: 'INVALID_DIMENSIONS',
      message: 'Qwen-Image is limited to about one megapixel on Apple GPUs. Choose a smaller resolution.',
      details: '1024x1040 exceeds the Metal-safe pixel budget',
    })
    // Another backend, or Qwen Image 2.1, is not held to it.
    for (const other of [
      spec({ family: 'qwen-image', backend: 'cuda' }),
      spec({ family: 'qwen-image-2.1', backend: 'metal' }),
    ])
      await expect(
        validateRequest(request({ width: 2048, height: 2048 }), other, deps)
      ).resolves.toBeUndefined()
  })

  it('refuses an inline image that is empty once its data-URL prefix is gone', async () => {
    const empty = await refusal(
      request({ workflow: 'transform', initImage: { base64: 'data:image/png;base64,' } })
    )
    expect(empty.message).toBe('The inline image is not valid base64.')
  })
})

describe('stripDataUrl', () => {
  it('keeps only the payload of a data URL and leaves a plain payload alone', () => {
    expect(stripDataUrl('data:image/png;base64,QUJD')).toBe('QUJD')
    expect(stripDataUrl('QUJD')).toBe('QUJD')
    // No comma: everything after `data:` is the payload, as in Rust.
    expect(stripDataUrl('data:QUJD')).toBe('QUJD')
    expect(stripDataUrl('data:a,b,c')).toBe('b,c')
  })
})

describe('isCanonicalBase64', () => {
  it('accepts what a strict standard decoder accepts', () => {
    for (const ok of ['', 'QUJD', 'QUI=', 'QQ==', 'iVBORw0KGgo=', '+/+/'])
      expect(isCanonicalBase64(ok), ok).toBe(true)
  })

  it('refuses everything else', () => {
    for (const bad of [
      'not base64!',
      'QUJ', // padding missing
      'QQ=', // wrong padding length
      'Q===',
      'QUJD\n',
      'QU JD',
      'QUJ-', // URL-safe alphabet
      'QR==', // non-zero trailing bits
      'QUJ=', // non-zero trailing bits
      '=QUJ',
      'QQ==QQ==',
    ])
      expect(isCanonicalBase64(bad), JSON.stringify(bad)).toBe(false)
  })

  it('agrees with a decode and re-encode round trip', () => {
    for (let length = 0; length < 24; length++) {
      const encoded = Buffer.from(Array.from({ length }, (_, i) => (i * 37 + 11) % 256)).toString('base64')
      expect(isCanonicalBase64(encoded), encoded).toBe(true)
    }
  })
})
