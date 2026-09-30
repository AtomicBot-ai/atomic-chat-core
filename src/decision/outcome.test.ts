import { describe, expect, it } from 'vitest'
import type { DecisionState } from '../contracts/index.js'
import {
  engineErrorOf,
  isRouterScoreBody,
  isSystemoneBody,
  NOT_CALIBRATED_MESSAGE,
  outcomeFromAnswer,
  refusalForState,
  scoresMatchCandidates,
  unavailable,
} from './outcome.js'

const scores = JSON.stringify({ object: 'router.scores', scores: [{ id: 'a', p_success: 0.9, logit: 2.2 }] })

describe('refusalForState', () => {
  it.each<[DecisionState, boolean, string | undefined]>([
    ['ready', true, undefined],
    ['disabled', true, 'disabled'],
    ['unsupported', true, 'unsupported'],
    ['failed', true, 'failed'],
    ['starting', true, 'starting'],
    ['restarting', true, 'starting'],
    ['idle', true, 'starting'],
    ['idle', false, 'not_configured'],
  ])('%s (configured %s) → %s', (state, configured, reason) => {
    expect(refusalForState(state, configured)?.reason).toBe(reason)
  })
})

describe('outcomeFromAnswer', () => {
  it('passes a well-formed 200 through as the result', () => {
    const outcome = outcomeFromAnswer(200, scores, 12, isRouterScoreBody)
    expect(outcome).toEqual({ unavailable: false, result: JSON.parse(scores), elapsed_ms: 12 })
  })

  it('never trusts a 200 that is not JSON or not the shape', () => {
    expect(outcomeFromAnswer(200, 'nope', 1, isRouterScoreBody)).toMatchObject({
      unavailable: true,
      reason: 'invalid_response',
      status: 200,
    })
    expect(outcomeFromAnswer(200, '{"scores":[{"id":1}]}', 1, isRouterScoreBody)).toMatchObject({
      reason: 'invalid_response',
    })
  })

  it('reads the engine envelope: 429 overloaded, 503 not running, 501 not calibrated, anything else rejected', () => {
    const envelope = (code: number, reason: string) =>
      JSON.stringify({
        error: { code, type: 'x', reason, message: `${reason} happened`, param: 'candidates[0].id' },
      })
    expect(outcomeFromAnswer(429, envelope(429, 'OVERLOADED'), 3, isRouterScoreBody)).toMatchObject({
      reason: 'overloaded',
      status: 429,
      error: { reason: 'OVERLOADED' },
    })
    expect(outcomeFromAnswer(503, envelope(503, 'UNAVAILABLE'), 3, isRouterScoreBody)).toMatchObject({
      reason: 'not_running',
    })
    const rejected = outcomeFromAnswer(400, envelope(400, 'INVALID_CANDIDATE_ID'), 3, isRouterScoreBody)
    expect(rejected).toMatchObject({
      unavailable: true,
      reason: 'rejected',
      status: 400,
      error: { reason: 'INVALID_CANDIDATE_ID', param: 'candidates[0].id' },
    })
    expect(
      outcomeFromAnswer(501, envelope(501, 'ROUTER_NOT_CALIBRATED'), 3, isRouterScoreBody)
    ).toMatchObject({
      reason: 'not_calibrated',
      message: NOT_CALIBRATED_MESSAGE,
      status: 501,
      error: { reason: 'ROUTER_NOT_CALIBRATED' },
    })
    // The reason alone is enough (a proxy that rewrote the status), and a bare 501 too.
    expect(
      outcomeFromAnswer(400, envelope(400, 'ROUTER_NOT_CALIBRATED'), 3, isRouterScoreBody)
    ).toMatchObject({
      reason: 'not_calibrated',
    })
    expect(outcomeFromAnswer(501, 'Not Implemented', 3, isRouterScoreBody)).toMatchObject({
      reason: 'not_calibrated',
    })
  })
})

describe('engineErrorOf', () => {
  it('keeps a real envelope, fields a newer engine added included', () => {
    const body = { error: { code: 400, reason: 'INVALID_CARD', message: 'bad', hint: 'new' } }
    expect(engineErrorOf(400, JSON.stringify(body))).toEqual(body.error)
  })

  it('wraps a middleware answer without an envelope', () => {
    expect(engineErrorOf(401, 'Unauthorized')).toEqual({ code: 401, message: 'Unauthorized' })
    expect(engineErrorOf(404, '')).toEqual({ code: 404, message: 'HTTP 404' })
    expect(engineErrorOf(500, '{"error":"flat"}')).toEqual({ code: 500, message: '{"error":"flat"}' })
  })
})

describe('shape checks', () => {
  it('accepts router and systemone answers and nothing else', () => {
    expect(isRouterScoreBody(JSON.parse(scores))).toBe(true)
    expect(isRouterScoreBody({ scores: {} })).toBe(false)
    expect(isSystemoneBody({ answers: { q: { type: 'noul', noul: 0.5 } } })).toBe(true)
    expect(isSystemoneBody({ answers: { q: 1 } })).toBe(false)
    expect(isSystemoneBody([])).toBe(false)
  })
})

describe('scoresMatchCandidates', () => {
  const body = (...ids: string[]) => ({
    object: 'router.scores' as const,
    scores: ids.map((id) => ({ id, p_success: 0.5 })),
  })
  it.each<[string[], string[], boolean]>([
    [['a', 'b'], ['a', 'b'], true],
    [['b', 'a'], ['a', 'b'], false],
    [['a'], ['a', 'b'], false],
    [['a', 'b', 'c'], ['a', 'b'], false],
    [['a', 'x'], ['a', 'b'], false],
    [[], [], true],
  ])('scores %j for candidates %j → %s', (scored, asked, expected) => {
    expect(scoresMatchCandidates(body(...scored) as never, asked)).toBe(expected)
  })
})

describe('unavailable', () => {
  it('builds the fail-open outcome with optional engine details', () => {
    expect(unavailable('timeout', 'slow', 500)).toEqual({
      unavailable: true,
      reason: 'timeout',
      message: 'slow',
      elapsed_ms: 500,
    })
    expect(unavailable('rejected', 'no', 1, { status: 400 })).toMatchObject({ status: 400 })
  })
})
