import { describe, expect, it } from 'vitest'
import type { DecisionHttp, DecisionRequest } from '../decision/index.js'
import { checkEmbeddingReadiness, dimsOf, judgeEmbeddingProbe, modalitiesOf } from './readiness.js'

const vectors = (n: number) =>
  JSON.stringify({ data: [{ embedding: Array.from({ length: n }, () => 0.1), index: 0 }] })
const props = (modalities: unknown) => ({ status: 200, text: JSON.stringify({ modalities }) })

describe('dimsOf / modalitiesOf', () => {
  it('reads the first vector and the projector modalities', () => {
    expect(dimsOf(JSON.parse(vectors(768)))).toBe(768)
    expect(dimsOf({ data: [] })).toBeUndefined()
    expect(dimsOf({ data: [{ embedding: [] }] })).toBeUndefined()
    expect(dimsOf('nope')).toBeUndefined()
    expect(modalitiesOf({ modalities: { vision: true, audio: true, video: true } })).toEqual([
      'text',
      'image',
      'audio',
      'video',
    ])
    expect(modalitiesOf({ modalities: { vision: false, audio: false } })).toEqual(['text'])
    expect(modalitiesOf({})).toEqual(['text'])
  })
})

describe('judgeEmbeddingProbe', () => {
  it('is ready with a vector and props', () => {
    expect(
      judgeEmbeddingProbe({ status: 200, text: vectors(768) }, props({ vision: true, audio: true }))
    ).toEqual({
      kind: 'ready',
      dims: 768,
      modalities: ['text', 'image', 'audio'],
    })
  })

  it.each([
    [
      { status: 501, text: '{"error":{"message":"embeddings disabled"}}' },
      'unsupported',
      'embeddings disabled',
    ],
    [
      { status: 400, text: '{"error":{"message":"Pooling type \'none\' is not OAI compatible"}}' },
      'refused',
      'Pooling',
    ],
    [{ status: 200, text: '{"data":[]}' }, 'refused', 'without a vector'],
    [{ status: 503, text: 'loading' }, 'loading', 'answered 503'],
    [{ status: 0, text: 'ECONNREFUSED' }, 'loading', 'ECONNREFUSED'],
    [{ status: 422, text: 'plain words' }, 'refused', 'plain words'],
  ])('probe %j → %s', (probe, kind, detail) => {
    const result = judgeEmbeddingProbe(probe, props({}))
    expect(result.kind).toBe(kind)
    expect('detail' in result && result.detail).toContain(detail)
  })

  it('keeps loading until /props answers JSON', () => {
    const probe = { status: 200, text: vectors(3) }
    expect(judgeEmbeddingProbe(probe, { status: 500, text: '' })).toMatchObject({ kind: 'loading' })
    expect(judgeEmbeddingProbe(probe, { status: 200, text: '<html>' })).toMatchObject({
      kind: 'loading',
      detail: expect.stringContaining('not JSON'),
    })
  })
})

describe('checkEmbeddingReadiness', () => {
  function http(answers: Record<string, { status: number; text: string } | Error>): {
    http: DecisionHttp
    sent: Array<{ url: string; init: DecisionRequest }>
  } {
    const sent: Array<{ url: string; init: DecisionRequest }> = []
    return {
      sent,
      http: {
        request: async (url, init) => {
          sent.push({ url, init })
          const answer = answers[new URL(url).pathname]
          if (answer instanceof Error) throw answer
          return answer ?? { status: 404, text: '' }
        },
      },
    }
  }

  it('probes with one word under the model name, with the key', async () => {
    const h = http({
      '/health': { status: 200, text: '{}' },
      '/v1/embeddings': { status: 200, text: vectors(4) },
      '/props': props({ vision: true }),
    })
    expect(await checkEmbeddingReadiness(h.http, 'http://127.0.0.1:9', 'k', 'bge-m3')).toEqual({
      kind: 'ready',
      dims: 4,
      modalities: ['text', 'image'],
    })
    const probe = h.sent.find((s) => s.url.endsWith('/v1/embeddings'))
    expect(JSON.parse(String(probe?.init.body))).toEqual({
      input: ['ping'],
      model: 'bge-m3',
      encoding_format: 'float',
    })
    expect(h.sent.every((s) => s.init.apiKey === 'k')).toBe(true)
  })

  it('stops at a health that is not 200 and at a transport error', async () => {
    const loading = http({ '/health': { status: 503, text: '' } })
    expect(await checkEmbeddingReadiness(loading.http, 'http://h', 'k', 'm')).toEqual({
      kind: 'loading',
      detail: '/health answered 503',
    })
    expect(loading.sent).toHaveLength(1)
    const down = http({ '/health': new Error('ECONNREFUSED') })
    expect(await checkEmbeddingReadiness(down.http, 'http://h', 'k', 'm')).toEqual({
      kind: 'loading',
      detail: 'ECONNREFUSED',
    })
  })

  it('does not ask /props after a refused probe', async () => {
    const h = http({ '/health': { status: 200, text: '{}' }, '/v1/embeddings': { status: 501, text: '{}' } })
    expect(await checkEmbeddingReadiness(h.http, 'http://h', 'k', 'm')).toMatchObject({ kind: 'unsupported' })
    expect(h.sent.map((s) => new URL(s.url).pathname)).toEqual(['/health', '/v1/embeddings'])
  })
})
