/**
 * The control API's decision bodies, checked just enough to build an engine request. Pure.
 *
 * Only the shape the core itself relies on is checked here (strings, a list, an object). The rules of
 * the engine (card schema, candidate ids, option counts) stay the engine's: it answers them with a
 * precise reason and JSON path, which the caller gets back in the outcome's `error`. Duplicating them
 * would only give two answers that can drift apart.
 */

import { AtomicCoreError } from '../contracts/index.js'
import type {
  DecisionDecideRequest,
  DecisionQuestion,
  DecisionScoreRequest,
  DecisionTruncation,
  RouterCandidate,
} from '../contracts/index.js'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function bad(message: string, details?: string): AtomicCoreError {
  return new AtomicCoreError('INVALID_ARGUMENT', message, details)
}

function common(body: Record<string, unknown>): { truncation?: DecisionTruncation; timeout_ms?: number } {
  const out: { truncation?: DecisionTruncation; timeout_ms?: number } = {}
  const truncation = body['truncation']
  if (truncation !== undefined) {
    if (truncation !== 'allow' && truncation !== 'error')
      throw bad('\'truncation\' must be "allow" or "error".')
    out.truncation = truncation
  }
  const timeout = body['timeout_ms']
  if (timeout !== undefined) {
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 60_000)
      throw bad("'timeout_ms' must be an integer from 1 to 60000.")
    out.timeout_ms = timeout
  }
  return out
}

export function parseScoreRequest(body: unknown): DecisionScoreRequest {
  if (!isRecord(body)) throw bad('The request body must be a JSON object.')
  const { task, criterion, candidates } = body
  if (typeof task !== 'string') throw bad("'task' must be a string.")
  if (typeof criterion !== 'string') throw bad("'criterion' must be a string.")
  if (!Array.isArray(candidates) || !candidates.every(isRecord))
    throw bad("'candidates' must be a list of objects ({id, card}).")
  return { task, criterion, candidates: candidates as RouterCandidate[], ...common(body) }
}

export function parseDecideRequest(body: unknown): DecisionDecideRequest {
  if (!isRecord(body)) throw bad('The request body must be a JSON object.')
  if (!('state' in body) || body['state'] === null) throw bad("'state' is required.")
  const questions = body['questions']
  if (!isRecord(questions) || !Object.values(questions).every(isRecord))
    throw bad("'questions' must be an object of question objects.")
  return {
    state: body['state'],
    questions: questions as Record<string, DecisionQuestion>,
    ...common(body),
  }
}
