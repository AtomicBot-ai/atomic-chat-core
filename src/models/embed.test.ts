import { describe, expect, it, vi } from 'vitest'
import type { SessionInfo } from '../contracts/index.js'
import { buildEmbedBatches, EmbedService } from './embed.js'

const session = { model_id: 'sentence-transformer-mini', port: 34123, api_key: 'secret' } as SessionInfo
const answer = (data: number[][], status = 200) =>
  new Response(
    JSON.stringify({
      data: data.map((embedding, index) => ({ embedding, index })),
      usage: { prompt_tokens: data.length, total_tokens: data.length },
    }),
    { status }
  )

describe('buildEmbedBatches', () => {
  it('keeps the legacy safety margin, offsets and oversized-single-input rule', () => {
    expect(buildEmbedBatches(['aaa', 'bbbbbb', 'x'.repeat(30)], 4)).toEqual([
      { batch: ['aaa'], offset: 0 },
      { batch: ['bbbbbb'], offset: 1 },
      { batch: ['x'.repeat(30)], offset: 2 },
    ])
    expect(buildEmbedBatches([], 4)).toEqual([])
  })
})

describe('EmbedService', () => {
  it('uses an existing core session and merges batches with global indices', async () => {
    const fetchImpl = vi.fn(async (_url, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] }
      return answer(body.input.map((text) => [text.length]))
    })
    const load = vi.fn(async () => session)
    const service = new EmbedService({
      findSession: () => session,
      load,
      unload: vi.fn(),
      fetch: fetchImpl as never,
    })
    const result = await service.embed('llamacpp-upstream', session.model_id, ['a', 'b'.repeat(10)], 4)
    expect(load).not.toHaveBeenCalled()
    expect(result).toEqual({
      model: session.model_id,
      object: 'list',
      usage: { prompt_tokens: 2, total_tokens: 2 },
      data: [
        { embedding: [1], index: 0 },
        { embedding: [10], index: 1 },
      ],
    })
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer secret' })
  })

  it('loads an absent session in embedding mode', async () => {
    const load = vi.fn(async () => session)
    const service = new EmbedService({
      findSession: () => undefined,
      load,
      unload: vi.fn(),
      fetch: vi.fn(async () => answer([[1]])) as never,
    })
    await service.embed('llamacpp-upstream', session.model_id, ['a'], 512)
    expect(load).toHaveBeenCalledWith('llamacpp-upstream', session.model_id)
  })

  it('reloads once after 501 and propagates a second failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 501 }))
      .mockResolvedValueOnce(new Response('still unavailable', { status: 501 }))
    const unload = vi.fn(async () => ({}))
    const load = vi.fn(async () => session)
    const service = new EmbedService({ findSession: () => session, load, unload, fetch: fetchImpl as never })
    await expect(service.embed('llamacpp-upstream', session.model_id, ['a'], 512)).rejects.toThrow('501')
    expect(unload).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not reload a second time when a later batch also answers 501', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(answer([[1]]))
      .mockResolvedValueOnce(new Response('', { status: 501 }))
      .mockResolvedValueOnce(answer([[2]]))
      .mockResolvedValueOnce(new Response('', { status: 501 }))
    const unload = vi.fn(async () => ({}))
    const load = vi.fn(async () => session)
    const service = new EmbedService({ findSession: () => session, load, unload, fetch: fetchImpl as never })
    await expect(service.embed('llamacpp-upstream', session.model_id, ['a', 'b', 'c'], 2)).rejects.toThrow(
      '501'
    )
    expect(unload).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('rejects invalid input before touching a session', async () => {
    const findSession = vi.fn(() => session)
    const service = new EmbedService({ findSession, load: vi.fn(), unload: vi.fn() })
    await expect(service.embed('llamacpp-upstream', session.model_id, ['a'], 1)).rejects.toThrow(
      'ubatch_size'
    )
    expect(findSession).not.toHaveBeenCalled()
  })
})
