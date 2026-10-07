import { describe, expect, it } from 'vitest'
import { checkEmbeddingRequest, isMediaReference } from './request.js'

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const image = (url: string) => ({ content: [{ type: 'image_url', image_url: { url } }] })
const audio = (holder: Record<string, unknown>) => ({
  content: [{ type: 'input_audio', input_audio: holder }],
})

describe('isMediaReference', () => {
  it.each([
    ['http://10.0.0.5/cat.png', true],
    ['HTTPS://example.com/a.wav', true],
    ['file:///etc/passwd', true],
    ['C:\\Users\\me\\a.png', true],
    [PNG, false],
    [' DATA:audio/wav;base64,UklGRg==', false],
    ['UklGRiQAAABXQVZFZm10IBAAAAABAAEA', false],
    ['iVBORw0KGgo+/=', false],
  ])('%s → %s', (value, reference) => expect(isMediaReference(value)).toBe(reference))
})

describe('checkEmbeddingRequest', () => {
  const textOnly = ['text'] as const
  const multimodal = ['text', 'image', 'audio'] as const

  it('passes text, inline media the model reads, and mixed items', () => {
    expect(checkEmbeddingRequest({ model: 'm', input: 'hello' }, textOnly, 768)).toEqual({ ok: true })
    expect(checkEmbeddingRequest({ input: ['a', [1, 2, 3]] }, textOnly, 768)).toEqual({ ok: true })
    expect(
      checkEmbeddingRequest(
        {
          input: [
            'task: search result | query: cats',
            image(PNG),
            audio({ data: 'UklGRg==' }),
            {
              content: [
                { type: 'text', text: 'shoes ' },
                { type: 'image_url', image_url: { url: PNG } },
              ],
            },
          ],
          dimensions: 768,
        },
        multimodal,
        768
      )
    ).toEqual({ ok: true })
  })

  it.each([
    [{ input: [image('http://192.168.1.10/cat.png')] }, 'inline', 'input[0].content[0]'],
    [{ input: image('file:///tmp/a.png') }, 'inline', 'input.content[0]'],
    [{ input: [audio({ url: 'https://x/a.wav' })] }, 'inline', 'input[0].content[0]'],
    [{ input: [audio({ data: 'http://x/a.wav' })] }, 'inline', 'input[0].content[0]'],
    [
      { input: [{ prompt_string: 'x', multimodal_data: ['https://x/a.png'] }] },
      'inline',
      'input[0].multimodal_data',
    ],
    [
      { input: [{ content: [{ type: 'input_video', input_video: { data: 'AAAA' } }] }] },
      'video',
      'input[0].content[0]',
    ],
  ])('refuses %j', (body, says, param) => {
    const verdict = checkEmbeddingRequest(body, multimodal, 768)
    expect(verdict).toMatchObject({ ok: false, param })
    expect(!verdict.ok && verdict.message).toContain(says)
  })

  it('refuses media a text model cannot read', () => {
    expect(checkEmbeddingRequest({ input: [image(PNG)] }, textOnly, 1024)).toMatchObject({
      ok: false,
      message: expect.stringContaining('does not read images'),
    })
    expect(checkEmbeddingRequest({ input: [audio({ data: 'AA' })] }, ['text', 'image'], 2048)).toMatchObject({
      ok: false,
      message: expect.stringContaining('does not read audio'),
    })
  })

  it('refuses a dimensions the model does not produce, and a body without input', () => {
    expect(checkEmbeddingRequest({ input: 'x', dimensions: 256 }, textOnly, 768)).toMatchObject({
      ok: false,
      param: 'dimensions',
      message: expect.stringContaining('768-dimension'),
    })
    expect(checkEmbeddingRequest({ input: 'x', dimensions: null }, textOnly, 768)).toEqual({ ok: true })
    // Before the model has answered once, its length is unknown: nothing to compare against.
    expect(checkEmbeddingRequest({ input: 'x', dimensions: 256 }, textOnly, null)).toEqual({ ok: true })
    expect(checkEmbeddingRequest({ model: 'm' }, textOnly, 768)).toMatchObject({ ok: false, param: 'input' })
    expect(checkEmbeddingRequest([1], textOnly, 768)).toMatchObject({ ok: false })
  })

  it('names the fix for a part sent outside content, and ffmpeg for video', () => {
    const bare = checkEmbeddingRequest(
      { input: [{ type: 'image_url', image_url: { url: PNG } }] },
      multimodal,
      768
    )
    expect(bare).toMatchObject({ ok: false, param: 'input[0]' })
    expect(!bare.ok && bare.message).toContain(
      'wrap it in an input item: {"content": [{"type":"image_url"}]}'
    )
    expect(checkEmbeddingRequest({ input: { type: 'text', text: 'x' } }, textOnly, 768)).toMatchObject({
      ok: false,
      param: 'input',
    })
    // An object input that is not a part (the legacy prompt shape) is the engine's to judge.
    expect(checkEmbeddingRequest({ input: [{ type: 'mystery' }] }, textOnly, 768)).toEqual({ ok: true })
    const video = checkEmbeddingRequest(
      { input: [{ content: [{ type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } }] }] },
      multimodal,
      768
    )
    expect(!video.ok && video.message).toContain('needs ffmpeg installed on this computer')
    expect(
      checkEmbeddingRequest(
        { input: [{ content: [{ type: 'input_video', input_video: { data: 'AAAA' } }] }] },
        ['text', 'image', 'video'],
        768
      )
    ).toEqual({ ok: true })
  })

  it('leaves part types it does not know to the engine', () => {
    expect(
      checkEmbeddingRequest(
        { input: [{ content: [{ type: 'mystery', mystery: 'http://x' }, 'stray'] }] },
        textOnly,
        3
      )
    ).toEqual({ ok: true })
  })
})
