import { describe, expect, it } from 'vitest'
import { parseDecideRequest, parseScoreRequest } from './request.js'

const candidate = { id: 'local/qwen', card: { name: 'Qwen', kind: 'local' } }

describe('parseScoreRequest', () => {
  it('takes task, criterion, candidates and the optional knobs', () => {
    expect(
      parseScoreRequest({
        task: 't',
        criterion: 'c',
        candidates: [candidate],
        truncation: 'error',
        timeout_ms: 250,
      })
    ).toEqual({ task: 't', criterion: 'c', candidates: [candidate], truncation: 'error', timeout_ms: 250 })
  })

  it.each([
    [null, 'JSON object'],
    [{ criterion: 'c', candidates: [] }, "'task'"],
    [{ task: 't', candidates: [] }, "'criterion'"],
    [{ task: 't', criterion: 'c', candidates: {} }, "'candidates'"],
    [{ task: 't', criterion: 'c', candidates: ['x'] }, "'candidates'"],
    [{ task: 't', criterion: 'c', candidates: [], truncation: 'cut' }, "'truncation'"],
    [{ task: 't', criterion: 'c', candidates: [], timeout_ms: 0 }, "'timeout_ms'"],
    [{ task: 't', criterion: 'c', candidates: [], timeout_ms: 1.5 }, "'timeout_ms'"],
  ])('refuses %j', (body, text) => {
    expect(() => parseScoreRequest(body)).toThrow(text)
    try {
      parseScoreRequest(body)
    } catch (e) {
      expect((e as { code: string }).code).toBe('INVALID_ARGUMENT')
    }
  })

  it('leaves the card rules to the engine', () => {
    expect(parseScoreRequest({ task: 't', criterion: 'c', candidates: [{ id: '!!' }] }).candidates).toEqual([
      { id: '!!' },
    ])
  })
})

describe('parseDecideRequest', () => {
  it('takes any non-null state and an object of questions', () => {
    const questions = { refund: { type: 'noul', instructions: 'Money back?' } }
    expect(parseDecideRequest({ state: ['a', 'b'], questions })).toEqual({ state: ['a', 'b'], questions })
    expect(parseDecideRequest({ state: 0, questions: {} })).toEqual({ state: 0, questions: {} })
  })

  it.each([
    [{ questions: {} }, "'state'"],
    [{ state: null, questions: {} }, "'state'"],
    [{ state: 's', questions: [] }, "'questions'"],
    [{ state: 's', questions: { q: 'noul' } }, "'questions'"],
    ['text', 'JSON object'],
  ])('refuses %j', (body, text) => {
    expect(() => parseDecideRequest(body)).toThrow(text)
  })
})
