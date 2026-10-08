import { describe, expect, it } from 'vitest'
import { checkEmbeddingRequest, isMediaReference, undecodableMediaVerdict } from './request.js'

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

  it.each([
    // The Local API page's own example, pasted as it was: the engine answered a 500.
    [image('data:image/png;base64,...'), 'input[0].content[0].image_url.url', 'placeholder'],
    [image('data:image/png;base64,<base64>'), 'input[0].content[0].image_url.url', 'placeholder'],
    [image('data:image/png;base64,'), 'input[0].content[0].image_url.url', 'has no data'],
    [image(''), 'input[0].content[0].image_url.url', 'is missing'],
    [{ content: [{ type: 'image_url', image_url: PNG }] }, 'input[0].content[0].image_url.url', 'is missing'],
    [
      image('data:image/png;base64,iVBO\nRw0K'),
      'input[0].content[0].image_url.url',
      'line break or space at character 5',
    ],
    [image('data:image/png;base64,iVBO-Rw0K'), 'input[0].content[0].image_url.url', 'URL-safe'],
    [image('data:image/png;base64,iVBO*Rw0K'), 'input[0].content[0].image_url.url', "'*' at character 5"],
    [image('data:image/png;base64,iVB=ORw0K'), 'input[0].content[0].image_url.url', "'=' at character 4"],
    [image('data:image/png;base64,iVBORw0Kg'), 'input[0].content[0].image_url.url', 'cut short'],
    [image('data:image/png,iVBORw0K'), 'input[0].content[0].image_url.url', 'must be base64-encoded'],
    [image('data:text/plain;base64,aGk='), 'input[0].content[0].image_url.url', 'image/, audio/ and video/'],
    [image('data:image/png;base64,iVBO,Rw0K'), 'input[0].content[0].image_url.url', 'one comma'],
    [image('DATA:image/png;base64,iVBORw0K'), 'input[0].content[0].image_url.url', 'lower case'],
    [image('notbase64!'), 'input[0].content[0].image_url.url', "'!' at character 10"],
    [audio({ data: 'UklG Rg==' }), 'input[0].content[0].input_audio.data', 'line break or space'],
    [audio({ url: 'data:audio/wav;base64,...' }), 'input[0].content[0].input_audio.url', 'placeholder'],
    [audio({}), 'input[0].content[0].input_audio.data', 'data:audio/wav;base64,<base64>'],
    [{ content: [{ type: 'image_url' }] }, 'input[0].content[0].image_url.url', 'is missing'],
    [
      image(`data:image/png;base64,${'A'.repeat(30)}...`),
      'input[0].content[0].image_url.url',
      `placeholder ("${'A'.repeat(24)}…")`,
    ],
    [
      { prompt_string: '<__media__>', multimodal_data: ['iVBORw0K', PNG] },
      'input[0].multimodal_data[1]',
      'bare base64',
    ],
  ])('refuses inline media the engine would not read whole: %j', (item, param, says) => {
    const verdict = checkEmbeddingRequest({ input: [item] }, multimodal, 768)
    expect(verdict).toMatchObject({ ok: false, param })
    expect(!verdict.ok && verdict.message).toContain(says)
    expect(!verdict.ok && verdict.message.startsWith(param)).toBe(true)
  })

  it('passes the media forms the engine reads: data: URLs of each kind, bare and padded base64', () => {
    for (const item of [
      image('data:image/jpeg;base64,/9j/4AAQSkZJRg=='),
      image('iVBORw0KGgo'),
      audio({ data: 'UklGRg==', format: 'wav' }),
      audio({ data: 'UklGRg==', url: 'data:audio/wav;base64,...' }),
      audio({ url: 'data:audio/mpeg;base64,SUQz' }),
      { prompt_string: '<__media__>', multimodal_data: ['iVBORw0K'] },
      // Not a string: the engine's to judge.
      { prompt_string: '<__media__>', multimodal_data: [42] },
    ])
      expect(checkEmbeddingRequest({ input: [item] }, multimodal, 768)).toEqual({ ok: true })
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

describe('undecodableMediaVerdict', () => {
  const engine500 = (message: string) =>
    JSON.stringify({ error: { code: 500, message, type: 'server_error' } })
  const oneImage = { input: [image('data:image/png;base64,AAAAAAAA')] }
  const modalities = ['text', 'image', 'audio'] as const

  it('turns the engine 500 for media it could not decode into a client error naming the field', () => {
    expect(
      undecodableMediaVerdict(500, engine500('Failed to load image or audio file'), oneImage, modalities)
    ).toEqual({
      message: expect.stringMatching(
        /^input\[0\]\.content\[0\]\.image_url\.url could not be decoded as an image, audio or video file .*PNG, JPEG, GIF or BMP images .*WAV, MP3 or FLAC audio\.$/
      ),
      param: 'input[0].content[0].image_url.url',
    })
    const two = {
      input: [
        { content: [{ type: 'text', text: 'shoes ' }, image(PNG).content[0]] },
        audio({ data: 'AAAAAAAA' }),
      ],
    }
    const verdict = undecodableMediaVerdict(500, engine500('Invalid base64 value'), two, ['text', 'image'])
    expect(verdict?.message).toContain(
      'One of input[0].content[1].image_url.url, input[1].content[0].input_audio.data could not be decoded'
    )
    expect(verdict?.message).not.toContain('audio:')
    expect(verdict).not.toHaveProperty('param')
  })

  it('lists the formats of the modalities the model reads, or none', () => {
    const failed = engine500('Failed to load image or audio file')
    const video = {
      input: [{ content: [{ type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } }] }],
    }
    expect(undecodableMediaVerdict(500, failed, video, ['text', 'video'])?.message).toMatch(
      /base64-encoded: video ffmpeg reads\.$/
    )
    expect(undecodableMediaVerdict(500, failed, oneImage, ['text'])?.message).toMatch(/base64-encoded\.$/)
    // Strays among the parts are skipped, as the engine's to judge.
    const strays = { input: [{ content: ['stray', { type: 1 }, image(PNG).content[0]] }] }
    expect(undecodableMediaVerdict(500, failed, strays, modalities)).toMatchObject({
      param: 'input[0].content[2].image_url.url',
    })
  })

  it('leaves every other answer to the engine', () => {
    for (const engineBody of ['[]', '{"error":"x"}', '{"error":{"message":5}}'])
      expect(undecodableMediaVerdict(500, engineBody, oneImage, modalities)).toBeUndefined()
    expect(undecodableMediaVerdict(500, engine500('Invalid base64 value'), null, modalities)).toBeUndefined()
    expect(undecodableMediaVerdict(500, engine500('Compute error'), oneImage, modalities)).toBeUndefined()
    expect(
      undecodableMediaVerdict(400, engine500('Failed to load image or audio file'), oneImage, modalities)
    ).toBeUndefined()
    expect(undecodableMediaVerdict(500, 'not json', oneImage, modalities)).toBeUndefined()
    // No media in the request: the engine's 500 is the engine's.
    expect(
      undecodableMediaVerdict(
        500,
        engine500('Failed to load image or audio file'),
        { input: 'x' },
        modalities
      )
    ).toBeUndefined()
  })
})
