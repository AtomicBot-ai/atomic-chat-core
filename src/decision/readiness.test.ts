import { describe, expect, it } from 'vitest'
import {
  capabilitiesOf,
  checkReadiness,
  decisionPropsOf,
  judgeDecisionEndpoint,
  judgeUpstreamDecisionEndpoint,
  modalitiesOf,
} from './readiness.js'
import { DecisionTimeoutError } from './http.js'
import type { DecisionHttp, DecisionRequest } from './http.js'

const models = (caps: unknown) => ({
  status: 200,
  text: JSON.stringify({ object: 'list', data: [{ id: 'laya', capabilities: caps }] }),
})
const props = (decision: unknown) => ({
  status: 200,
  text: JSON.stringify({ model_alias: 'laya', decision }),
})

describe('capabilitiesOf', () => {
  it('reads data[] and models[] and keeps the union', () => {
    expect(capabilitiesOf({ data: [{ capabilities: ['decision', 'systemone'] }] })).toEqual([
      'decision',
      'systemone',
    ])
    expect(
      capabilitiesOf({
        data: [{ capabilities: ['decision'] }],
        models: [{ capabilities: ['router_score', 7] }],
      })
    ).toEqual(['decision', 'router_score'])
    expect(capabilitiesOf({ data: [{ id: 'x' }] })).toEqual([])
    expect(capabilitiesOf('nope')).toEqual([])
  })
})

describe('decisionPropsOf', () => {
  it('needs a numeric api_version and keeps unknown fields', () => {
    expect(decisionPropsOf({ decision: { api_version: 1, layout: 'laya', later: true } })).toEqual({
      api_version: 1,
      layout: 'laya',
      later: true,
    })
    expect(decisionPropsOf({ decision: { api_version: '1' } })).toBeUndefined()
    expect(decisionPropsOf({ chat_template: 'x' })).toBeUndefined()
  })
})

describe('judgeDecisionEndpoint', () => {
  it('accepts capability decision plus api_version 1', () => {
    expect(judgeDecisionEndpoint(models(['decision', 'systemone']), props({ api_version: 1 }))).toEqual({
      kind: 'ready',
      props: { api_version: 1 },
      capabilities: ['decision', 'systemone'],
    })
  })

  it.each([
    [
      'no decision capability (a chat server)',
      models(['completion']),
      props({ api_version: 1 }),
      'does not list',
    ],
    ['no decision block', models(['decision']), props(undefined), 'no decision block'],
    ['another API version', models(['decision']), props({ api_version: 2 }), 'api_version 2'],
  ])('refuses %s', (_label, m, p, detail) => {
    const verdict = judgeDecisionEndpoint(m, p)
    expect(verdict.kind).toBe('unsupported')
    expect(verdict.kind === 'unsupported' && verdict.detail).toContain(detail)
  })

  // A refusal is remembered for the build, so only a 200 answer that says so may refuse it.
  it.each([
    ['models 500', { status: 500, text: 'busy' }, props({ api_version: 1 }), '/v1/models answered 500'],
    ['models 401', { status: 401, text: '' }, props({ api_version: 1 }), '/v1/models answered 401'],
    [
      'models timed out',
      { status: 0, text: 'no answer within 2000 ms' },
      props({ api_version: 1 }),
      'within 2000 ms',
    ],
    ['models 200 but not JSON', { status: 200, text: '<html>' }, props({ api_version: 1 }), 'not JSON'],
    ['props 503', models(['decision']), { status: 503, text: 'Loading model' }, '/props answered 503'],
    [
      'props refused',
      models(['decision']),
      { status: 0, text: 'connect ECONNRESET' },
      '/props: connect ECONNRESET',
    ],
    ['props 200 but truncated', models(['decision']), { status: 200, text: '{"decision":' }, 'not JSON'],
  ])('is still loading on %s', (_label, m, p, detail) => {
    const verdict = judgeDecisionEndpoint(m, p)
    expect(verdict.kind).toBe('loading')
    expect(verdict.kind === 'loading' && verdict.detail).toContain(detail)
  })
})

function scriptedHttp(answers: Record<string, { status: number; text: string } | Error>) {
  const seen: Array<{ url: string; init: DecisionRequest }> = []
  const http: DecisionHttp = {
    request: async (url, init) => {
      seen.push({ url, init })
      const path = new URL(url).pathname
      const answer = answers[path]
      if (answer instanceof Error) throw answer
      return answer ?? { status: 404, text: '' }
    },
  }
  return { http, seen }
}

describe('checkReadiness', () => {
  it('runs health → models → props with the key and answers ready', async () => {
    const { http, seen } = scriptedHttp({
      '/health': { status: 200, text: '{"status":"ok"}' },
      '/v1/models': models(['decision']),
      '/props': props({ api_version: 1, layout: 'laya' }),
    })
    const result = await checkReadiness(http, 'http://127.0.0.1:9', 'key')
    expect(result).toMatchObject({ kind: 'ready', props: { layout: 'laya' } })
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual(['/health', '/v1/models', '/props'])
    expect(seen.every((s) => s.init.apiKey === 'key' && s.init.method === 'GET')).toBe(true)
  })

  it('is still loading while health answers 503 or the port refuses, and asks nothing else', async () => {
    const loading = scriptedHttp({ '/health': { status: 503, text: 'Loading model' } })
    expect(await checkReadiness(loading.http, 'http://x', 'k')).toEqual({
      kind: 'loading',
      detail: '/health answered 503',
    })
    expect(loading.seen).toHaveLength(1)
    const refused = scriptedHttp({ '/health': new Error('connect ECONNREFUSED') })
    expect(await checkReadiness(refused.http, 'http://x', 'k')).toEqual({
      kind: 'loading',
      detail: 'connect ECONNREFUSED',
    })
  })

  it('is still loading when /props times out or fails after a healthy /health', async () => {
    const slow = scriptedHttp({
      '/health': { status: 200, text: '{}' },
      '/v1/models': models(['decision']),
      '/props': new DecisionTimeoutError(2_000),
    })
    expect(await checkReadiness(slow.http, 'http://x', 'k')).toEqual({
      kind: 'loading',
      detail: '/props: the decision model did not answer within 2000 ms',
    })
    const broken = scriptedHttp({
      '/health': { status: 200, text: '{}' },
      '/v1/models': { status: 502, text: '' },
      '/props': props({ api_version: 1 }),
    })
    expect(await checkReadiness(broken.http, 'http://x', 'k')).toMatchObject({ kind: 'loading' })
  })

  it('refuses a server that is healthy but not a decision server', async () => {
    const { http } = scriptedHttp({
      '/health': { status: 200, text: '{}' },
      '/v1/models': models(['completion']),
      '/props': { status: 200, text: '{}' },
    })
    expect((await checkReadiness(http, 'http://x', 'k')).kind).toBe('unsupported')
  })
})

/** An upstream `/v1/models` answer (b11370 on): the decision model shows in `output_modalities`. */
const upstreamModels = (outputs: string[], inputs: string[] = ['text']) => ({
  status: 200,
  text: JSON.stringify({
    object: 'list',
    data: [{ id: 'julia-1', architecture: { input_modalities: inputs, output_modalities: outputs } }],
    models: [{ name: 'julia-1', capabilities: ['completion'] }],
  }),
})

describe('judgeUpstreamDecisionEndpoint', () => {
  it('is ready when /v1/models lists decisions, with the props the core stands in', () => {
    expect(judgeUpstreamDecisionEndpoint(upstreamModels(['decisions'], ['text', 'image']))).toEqual({
      kind: 'ready',
      capabilities: ['decision', 'systemone'],
      props: {
        api_version: 1,
        endpoints: ['/v1/systemone'],
        source: 'gguf',
        model_id: 'julia-1',
        input_modalities: ['text', 'image'],
      },
    })
  })

  it('refuses a server whose model is not a decision model', () => {
    expect(judgeUpstreamDecisionEndpoint(upstreamModels(['text']))).toEqual({
      kind: 'unsupported',
      detail: '/v1/models does not list the "decisions" output modality (got ["text"])',
    })
  })

  it('reads anything but a JSON 200 as still loading', () => {
    expect(judgeUpstreamDecisionEndpoint({ status: 503, text: '' }).kind).toBe('loading')
    expect(judgeUpstreamDecisionEndpoint({ status: 200, text: 'nope' }).kind).toBe('loading')
  })

  it('leaves the model id out when the entry has none', () => {
    const verdict = judgeUpstreamDecisionEndpoint({
      status: 200,
      text: JSON.stringify({ data: [{ architecture: { output_modalities: ['decisions'] } }] }),
    })
    expect(verdict).toMatchObject({ kind: 'ready' })
    expect(verdict.kind === 'ready' && 'model_id' in verdict.props).toBe(false)
    expect(judgeUpstreamDecisionEndpoint({ status: 200, text: '[]' })).toMatchObject({ kind: 'unsupported' })
  })

  it('reads the modalities of the first entry that has them', () => {
    expect(
      modalitiesOf(
        { data: [{}, { architecture: { output_modalities: ['decisions', 3] } }] },
        'output_modalities'
      )
    ).toEqual(['decisions'])
    expect(modalitiesOf({ models: [] }, 'input_modalities')).toEqual([])
    expect(modalitiesOf({ data: ['x', { architecture: 'y' }] }, 'input_modalities')).toEqual([])
    expect(modalitiesOf(null, 'output_modalities')).toEqual([])
  })
})

describe('checkReadiness for upstream', () => {
  it('asks health and models only: upstream has no /props.decision', async () => {
    const { http, seen } = scriptedHttp({
      '/health': { status: 200, text: '{"status":"ok"}' },
      '/v1/models': upstreamModels(['decisions']),
    })
    const result = await checkReadiness(http, 'http://127.0.0.1:9', 'key', 2_000, 'upstream')
    expect(result).toMatchObject({ kind: 'ready', props: { endpoints: ['/v1/systemone'] } })
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual(['/health', '/v1/models'])
  })
})
