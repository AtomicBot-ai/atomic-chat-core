/**
 * The host-step file protocol (design D3): an unprivileged client writes
 * `<step_id>.request.json`, the privileged executor reads it and writes `<step_id>.result.json`
 * beside it, and the elevated process never talks to the core.
 *
 * The shapes are the ones `atc host-step exec` already speaks (atomic-chat-cli
 * `src/host/elevator.ts` `HostStepRequestFile`/`HostStepResultFile`), extended additively:
 *
 * - the request carries `parameters`, because `parameters_digest` is only checkable against the
 *   values it hashes, and the recipe cannot run without them;
 * - the result echoes the nonce and both digests, names an `error_code` when the request was
 *   refused before anything ran, and lists each recipe step's outcome.
 *
 * A reader that knows only the CLI's fields still reads `outcome`, `exit_code` and `log_tail`.
 */

import { MANAGED_HOST_ACTIONS } from '../../contracts/index.js'
import type { ManagedHostAction, Sha256Digest } from '../../contracts/index.js'

export interface HostStepRequest {
  schema_version: 1
  step_id: string
  operation_id: string
  action: ManagedHostAction
  recipe_id: string
  recipe_digest: Sha256Digest
  parameters_digest: Sha256Digest
  nonce: string
  expected_operation_revision: number
  data_folder: string
  requested_at?: number
  /** Recipe-specific; validated by the recipe itself before anything uses it. */
  parameters: Record<string, unknown>
}

export type HostStepStepStatus = 'satisfied' | 'applied' | 'failed' | 'not-run'

/** One recipe step as it went. `stderr` is the command's own, trimmed to its last 2000 characters. */
export interface HostStepStepOutcome {
  id: string
  status: HostStepStepStatus
  exit_code: number | null
  stderr: string
  detail: string
}

export interface HostStepResult {
  schema_version: 1
  step_id: string
  outcome: 'completed' | 'failed'
  /** 0 when completed, the failing command's exit code, or null when no command failed. */
  exit_code: number | null
  log_tail: string
  finished_at: number
  nonce: string | null
  recipe_id: string | null
  recipe_digest: string | null
  parameters_digest: string | null
  /** `MANAGED_HOST_STEP_INVALID` when the request was refused before any step ran. */
  error_code: 'MANAGED_HOST_STEP_INVALID' | null
  steps: HostStepStepOutcome[]
}

/** The identifiers of a refused request that were well-formed enough to repeat back. */
export interface HostStepEcho {
  step_id: string | null
  nonce: string | null
  recipe_id: string | null
  recipe_digest: string | null
  parameters_digest: string | null
}

export type HostStepRequestParse =
  { ok: true; request: HostStepRequest } | { ok: false; problems: string[]; echo: HostStepEcho }

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/
const RECIPE_ID = /^[a-z0-9.-]{1,64}$/
const DIGEST = /^sha256:[0-9a-f]{64}$/

const matching = (value: unknown, pattern: RegExp): string | null =>
  typeof value === 'string' && pattern.test(value) ? value : null

/**
 * Parses and checks a request file's text. Never throws, and never quotes the text back: the
 * privileged process may have been pointed at a file that is not a request at all, and the result
 * file it writes is readable by the user who pointed it there.
 */
export function parseHostStepRequest(text: string): HostStepRequestParse {
  const empty: HostStepEcho = {
    step_id: null,
    nonce: null,
    recipe_id: null,
    recipe_digest: null,
    parameters_digest: null,
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    // Deliberately not the parser's message: V8 includes a snippet of the input in it.
    return { ok: false, problems: ['the request is not valid JSON'], echo: empty }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, problems: ['the request must be a JSON object'], echo: empty }
  const r = raw as Record<string, unknown>

  const echo: HostStepEcho = {
    step_id: matching(r['step_id'], IDENTIFIER),
    nonce: matching(r['nonce'], IDENTIFIER),
    recipe_id: matching(r['recipe_id'], RECIPE_ID),
    recipe_digest: matching(r['recipe_digest'], DIGEST),
    parameters_digest: matching(r['parameters_digest'], DIGEST),
  }
  const problems: string[] = []
  if (r['schema_version'] !== 1) problems.push('schema_version must be 1')
  if (echo.step_id === null) problems.push('step_id must be a short identifier')
  if (matching(r['operation_id'], IDENTIFIER) === null)
    problems.push('operation_id must be a short identifier')
  if (echo.nonce === null) problems.push('nonce must be a short identifier')
  if (echo.recipe_id === null) problems.push('recipe_id must be a recipe identifier')
  if (echo.recipe_digest === null) problems.push('recipe_digest must be a sha256 digest')
  if (echo.parameters_digest === null) problems.push('parameters_digest must be a sha256 digest')
  if (!(MANAGED_HOST_ACTIONS as readonly unknown[]).includes(r['action']))
    problems.push(`action must be one of ${MANAGED_HOST_ACTIONS.join(', ')}`)
  const revision = r['expected_operation_revision']
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0)
    problems.push('expected_operation_revision must be a non-negative integer')
  const folder = r['data_folder']
  if (typeof folder !== 'string' || folder === '' || folder.length > 4096)
    problems.push('data_folder must be a path')
  if (r['requested_at'] !== undefined && typeof r['requested_at'] !== 'number')
    problems.push('requested_at must be a number')
  const parameters = r['parameters']
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters))
    problems.push('parameters must be an object')

  if (problems.length > 0) return { ok: false, problems, echo }
  return { ok: true, request: r as unknown as HostStepRequest }
}

/** `<dir>/<step>.request.json` → `<dir>/<step>.result.json`; null for any other name. */
export function resultPathFor(requestPath: string): string | null {
  const match = /^(.*\/)?([^/]+)\.request\.json$/.exec(requestPath)
  if (match === null) return null
  return `${match[1] ?? ''}${match[2]}.result.json`
}
