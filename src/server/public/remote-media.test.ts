import { describe, expect, it } from 'vitest'
import { decodePng, encodePng } from '../../diffusion/index.js'
import {
  buildRemoteImageRequest,
  buildRemoteVideoRequest,
  inlineImage,
  parseRemoteImageParams,
  parseRemoteVideoParams,
} from './remote-media.js'

const target = { provider: 'openai', model: 'gpt-image-2' }
const B64 = Buffer.from('png-bytes').toString('base64')

describe('inlineImage', () => {
  it('takes a data URL, {image_url} or bare base64, and refuses links', () => {
    expect(inlineImage(`data:image/png;base64,${B64}`, 'image')).toBe(B64)
    expect(inlineImage({ image_url: `data:image/jpeg;base64,${B64}` }, 'image')).toBe(B64)
    expect(inlineImage(B64, 'image')).toBe(B64)
    expect(() => inlineImage('https://x.example/a.png', 'image')).toThrow('inline')
    expect(() => inlineImage('data:text/plain;base64,eA==', 'image')).toThrow('data URL')
    expect(() => inlineImage(7, 'image')).toThrow()
  })
})

describe('image params', () => {
  it('read a generation body and refuse a URL answer', () => {
    expect(
      parseRemoteImageParams(
        { prompt: ' a cat ', n: 2, size: '1024x1024', quality: 'high', seed: 3 },
        'generations'
      )
    ).toEqual({
      prompt: 'a cat',
      n: 2,
      size: '1024x1024',
      quality: 'high',
      seed: 3,
      images: [],
    })
    expect(() => parseRemoteImageParams({ prompt: 'x', response_format: 'url' }, 'generations')).toThrow(
      'b64_json'
    )
    expect(() => parseRemoteImageParams({ prompt: 'x', n: 11 }, 'generations')).toThrow('n must')
    expect(() => parseRemoteImageParams({}, 'generations')).toThrow('prompt')
  })

  it('need an image to edit', () => {
    expect(() => parseRemoteImageParams({ prompt: 'x' }, 'edits')).toThrow('images')
    expect(
      parseRemoteImageParams({ prompt: 'x', image: `data:image/png;base64,${B64}` }, 'edits').images
    ).toEqual([B64])
  })

  it('build the runner request, a tier size becoming a resolution', async () => {
    expect(
      await buildRemoteImageRequest(
        parseRemoteImageParams({ prompt: 'x', size: '2K' }, 'generations'),
        target
      )
    ).toMatchObject({
      batchSize: 1,
      width: 0,
      target,
      remote: { resolution: '2K' },
    })
    expect(
      await buildRemoteImageRequest(
        parseRemoteImageParams({ prompt: 'x', size: '768x512' }, 'generations'),
        target
      )
    ).toMatchObject({
      width: 768,
      height: 512,
      remote: { size: '768x512' },
    })
  })

  it('pick the workflow from the inputs, the mask turned to white-repaints', async () => {
    const one = await buildRemoteImageRequest(
      parseRemoteImageParams({ prompt: 'x', images: [B64] }, 'edits'),
      target
    )
    expect(one.workflow).toBe('edit')
    const two = await buildRemoteImageRequest(
      parseRemoteImageParams({ prompt: 'x', images: [B64, B64] }, 'edits'),
      target
    )
    expect(two).toMatchObject({ workflow: 'reference', referenceImages: [{ base64: B64 }] })
    // OpenAI mask: transparent where the model repaints.
    const mask = await encodePng({ width: 1, height: 1, channels: 4, data: Buffer.from([0, 0, 0, 0]) })
    const masked = await buildRemoteImageRequest(
      parseRemoteImageParams(
        {
          prompt: 'x',
          images: [B64],
          mask: { image_url: `data:image/png;base64,${mask.toString('base64')}` },
        },
        'edits'
      ),
      target
    )
    expect(masked.workflow).toBe('inpaint')
    const white = await decodePng(Buffer.from((masked.maskImage as { base64: string }).base64, 'base64'))
    expect([...white.data]).toEqual([255, 255, 255])
  })
})

describe('video params', () => {
  it('read a clip body and build the runner request', () => {
    const params = parseRemoteVideoParams({
      prompt: 'waves',
      seconds: '8',
      resolution: '720p',
      aspect_ratio: '16:9',
      generate_audio: true,
      input_reference: `data:image/png;base64,${B64}`,
    })
    expect(
      buildRemoteVideoRequest(params, { provider: 'openrouter', model: 'google/veo-3.1-fast' })
    ).toMatchObject({
      workflow: 'image-to-video',
      initImage: { base64: B64 },
      remote: { durationSecs: 8, resolution: '720p', aspectRatio: '16:9', generateAudio: true },
    })
  })

  it('refuse a clip without a prompt or a frame, and a length out of range', () => {
    expect(() => parseRemoteVideoParams({})).toThrow('prompt')
    expect(() => parseRemoteVideoParams({ prompt: 'x', seconds: 0 })).toThrow('seconds')
    expect(() => parseRemoteVideoParams({ prompt: 'x', generate_audio: 'yes' })).toThrow('generate_audio')
  })
})
