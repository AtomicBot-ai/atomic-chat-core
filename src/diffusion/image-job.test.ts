/**
 * The image side of the runner: the input and result helpers as `jobs.rs` had them (app commit
 * `ec1fd3ea7`), and the `JobKind` the shared runner drives them through.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvents, ImageGenerateRequest } from '../contracts/index.js'
import { paintedPng, sampleRequest, sampleSpec } from '../../test/helpers/diffusion-fixtures.js'
import { decodeImages, IMAGE_JOB_KIND, resolveInputs, withoutSources } from './image-job.js'

let dataFolder: string
let pngB64 = ''
beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-image-job-'))
  pngB64 = (await paintedPng(16, 16)).toString('base64')
})
afterEach(async () => {
  await rm(dataFolder, { recursive: true, force: true })
})

describe('inputs', () => {
  it('resolve per workflow, and a snapshot drops inline bytes', async () => {
    const source = join(dataFolder, 'source.png')
    await writeFile(source, 'PNG?')
    const deps = { readSource: (path: string) => readFile(path) }
    const path = { path: source }
    const mask = { base64: 'data:image/png;base64,QUJD' }
    let request: ImageGenerateRequest = sampleRequest({
      workflow: 'inpaint',
      initImage: path,
      maskImage: mask,
    })
    expect(await resolveInputs(request, deps)).toEqual({ init: 'UE5HPw==', mask: 'QUJD', refs: [] })

    request = { ...request, workflow: 'reference', referenceImages: [mask] }
    expect(await resolveInputs(request, deps)).toEqual({ refs: ['UE5HPw==', 'QUJD'] })

    // Create reads nothing, whatever the request carries; nor does a request without a source.
    expect(await resolveInputs({ ...request, workflow: 'create' }, deps)).toEqual({ refs: [] })
    delete request.initImage
    expect(await resolveInputs(request, deps)).toEqual({ refs: [] })

    const snapshot = withoutSources(
      sampleRequest({ workflow: 'inpaint', initImage: path, maskImage: mask, referenceImages: [mask, path] })
    )
    expect(snapshot.initImage).toEqual(path)
    expect(snapshot.maskImage).toEqual({ base64: '' })
    expect(snapshot.referenceImages).toEqual([{ base64: '' }, path])
    expect(snapshot.prompt).toBe('a cat')
  })
})

describe('decodeImages', () => {
  it('orders by index and refuses empty results', () => {
    const images = decodeImages({
      result: {
        images: [
          { index: 1, b64_json: 'AQ==' },
          { index: 0, b64_json: pngB64 },
        ],
      },
    })
    expect(images).toHaveLength(2)
    expect(images[0]?.subarray(0, 2).equals(Buffer.from([0x89, 0x50]))).toBe(true)
    expect([...(images[1] as Buffer)]).toEqual([1])
    expect(() => decodeImages({ result: { images: [] } })).toThrow('returned no images')
    expect(() => decodeImages({})).toThrow('returned no images')
    expect(() => decodeImages({ result: { images: [{ b64_json: '!!!!' }] } })).toThrow('undecodable image')
    expect(decodeImages({ result: { images: [{ b64_json: ' AQ== ' }, 7, { index: 'x' }] } })).toHaveLength(1)
  })
})

describe('IMAGE_JOB_KIND', () => {
  it('names the image route, the image events and the image messages', () => {
    expect(IMAGE_JOB_KIND.id).toBe('image')
    expect(IMAGE_JOB_KIND.modality).toBe('image')
    expect(IMAGE_JOB_KIND.submitPath).toBe('/sdcpp/v1/img_gen')
    expect(IMAGE_JOB_KIND.messages).toEqual({
      busy: 'An image is already being generated.',
      wrongModel: 'The loaded model generates video, not images. Load an image model first.',
    })
    const emitted: Array<{ name: string; payload: unknown }> = []
    const emit = (name: string, payload: unknown) => emitted.push({ name, payload })
    const job = IMAGE_JOB_KIND.newJob('j', sampleSpec(), sampleRequest({ initImage: { base64: 'QUJD' } }), 5)
    expect(job).toEqual({
      id: 'j',
      state: 'queued',
      modelId: 'z-image:q4_k_m',
      request: sampleRequest({ initImage: { base64: '' } }),
      createdAtMs: 5,
      progress: null,
      outputs: [],
    })
    IMAGE_JOB_KIND.emitJob(emit as never, job)
    const progress: CoreEvents['diffusion:progress']['progress'] = {
      phase: 'sampling',
      step: 1,
      totalSteps: 4,
      fraction: 0.2,
      etaSeconds: null,
      batchIndex: 0,
      batchSize: 2,
      elapsedMs: 10,
    }
    IMAGE_JOB_KIND.emitProgress(emit as never, 'j', progress)
    expect(emitted).toEqual([
      { name: 'diffusion:job', payload: { job } },
      { name: 'diffusion:progress', payload: { jobId: 'j', progress } },
    ])
    // The tracker counts the sampled steps times the batch; the snapshot is the wire progress as is.
    expect(IMAGE_JOB_KIND.trackerShape(sampleRequest({ steps: 20, batchSize: 3 }))).toEqual({
      steps: 20,
      batch: 3,
    })
    expect(
      IMAGE_JOB_KIND.trackerShape(
        sampleRequest({ steps: 20, workflow: 'transform', initImage: { base64: 'QUJD' }, strength: 0.35 })
      )
    ).toEqual({ steps: 8, batch: 2 })
    expect(IMAGE_JOB_KIND.progress(progress)).toBe(progress)
    expect(IMAGE_JOB_KIND.cancelGenerating({ cancelGenerating: true })).toBe(true)
    expect(
      IMAGE_JOB_KIND.cancelGenerating({ cancelGenerating: false, vidGen: { cancelGenerating: true } })
    ).toBe(false)
    expect(IMAGE_JOB_KIND.preflight).toBeUndefined()
    const spec = sampleSpec({ defaults: { steps: 4, cfgScale: 1, width: 512, height: 512, guidance: 2.5 } })
    expect(IMAGE_JOB_KIND.buildBody(sampleRequest(), spec, 9, { refs: [] })).toMatchObject({
      seed: 9,
      batch_count: 2,
      sample_params: { guidance: { txt_cfg: 1, distilled_guidance: 2.5 } },
    })
  })
})
