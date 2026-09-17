/**
 * Replay of the ChatGPT subscription fixtures dumped from the app's Rust (PLAN.md §4, stage 4c):
 * `chatgpt-auth` (PKCE, authorize URL, callback parsing, JWT claims, token response → session, the
 * token file) and `chatgpt-route` (the upstream request, model normalisation).
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadFixtureSet } from './fixtures.js'
import {
  CLIENT_ID,
  ISSUER,
  SCOPES,
  CALLBACK_PORT,
  CALLBACK_PATH,
  ORIGINATOR,
  REAUTHORIZATION_REQUIRED,
  TERMINAL_TOKEN_ERRORS,
  REFRESH_SAFETY_MARGIN_SECS,
  TOKEN_FILE_VERSION,
  authorizeUrl,
  clearTokens,
  decodeJwtClaims,
  deriveChallenge,
  isExpiredAt,
  loadTokens,
  parseCallbackQuery,
  parseTokenResponse,
  redirectUri,
  saveTokens,
  stateMatches,
  toStored,
} from '../../src/credentials/index.js'
import type { StoredTokens } from '../../src/credentials/index.js'
import {
  CHATGPT_BASE_URL,
  CHATGPT_CLIENT_VERSION,
  CHATGPT_ORIGINATOR,
  CHATGPT_PROVIDER,
  CHATGPT_USER_AGENT,
  buildUpstreamRequest,
  normalizeModel,
} from '../../src/cloud/index.js'
import type { AtomicCoreError } from '../../src/contracts/index.js'
import { chatRequestToResponses } from '../../src/server/shims/index.js'
import type { JsonValue } from '../../src/server/shims/index.js'

type Input = Record<string, JsonValue>

function errMessage(fn: () => unknown): JsonValue {
  try {
    return { ok: fn() as JsonValue }
  } catch (e) {
    return { err: (e as AtomicCoreError).message }
  }
}

describe('chatgpt-auth', () => {
  const { index, cases } = loadFixtureSet<Input, JsonValue>('chatgpt-auth')
  const notes = (index as unknown as { comparator_notes: { constants: Record<string, JsonValue> } })
    .comparator_notes

  it('pins the same constants', () => {
    expect({
      client_id: CLIENT_ID,
      issuer: ISSUER,
      scopes: SCOPES,
      callback_port: CALLBACK_PORT,
      callback_path: CALLBACK_PATH,
      callback_timeout_secs: 300,
      originator: ORIGINATOR,
      token_file_name: 'atomic-chatgpt-auth.json',
      token_file_version: TOKEN_FILE_VERSION,
      refresh_safety_margin_secs: REFRESH_SAFETY_MARGIN_SECS,
      terminal_token_errors: TERMINAL_TOKEN_ERRORS,
      reauthorization_marker: REAUTHORIZATION_REQUIRED,
    }).toEqual(notes.constants)
  })

  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const input = c.input
    let actual: JsonValue
    switch (input['kind']) {
      case 'derive_challenge':
        actual = { challenge: deriveChallenge(input['verifier'] as string) }
        break
      case 'authorize_url':
        actual = { url: authorizeUrl(input['challenge'] as string, input['state'] as string) }
        break
      case 'redirect_uri':
        actual = { redirect_uri: redirectUri() }
        break
      case 'parse_callback_query':
        actual = errMessage(() => {
          const parsed = parseCallbackQuery(input['query'] as string)
          return parsed.kind === 'code'
            ? { kind: 'code', code: parsed.code, state: parsed.state }
            : { kind: 'error', error: parsed.error, description: parsed.description }
        })
        break
      case 'state_matches':
        actual = { matches: stateMatches(input['expected'] as string, input['received'] as string) }
        break
      case 'decode_jwt_claims':
        actual = { claims: decodeJwtClaims(input['token'] as string) as unknown as JsonValue }
        break
      case 'to_stored': {
        const response = parseTokenResponse(input['response'])
        if (!response) throw new Error('fixture token response must parse')
        actual = errMessage(
          () =>
            toStored(
              response,
              input['now_unix'] as number,
              (input['previous_refresh'] as string | null) ?? null
            ) as unknown as JsonValue
        )
        break
      }
      case 'parse_token_response':
        actual = { parses: parseTokenResponse(input['response']) !== undefined }
        break
      case 'save': {
        const dir = await mkdtemp(join(tmpdir(), 'atomic-chatgpt-contract-'))
        try {
          const path = join(dir, 'atomic-chatgpt-auth.json')
          await saveTokens(path, input['tokens'] as unknown as StoredTokens)
          const mode = process.platform === 'win32' ? null : (await stat(path)).mode & 0o777
          actual = { text: await readFile(path, 'utf8'), mode }
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
        if (process.platform === 'win32') (c.expected as { mode: JsonValue }).mode = null
        break
      }
      case 'load': {
        const dir = await mkdtemp(join(tmpdir(), 'atomic-chatgpt-contract-'))
        try {
          const path = join(dir, 'atomic-chatgpt-auth.json')
          if (input['file'] !== null) await writeFile(path, input['file'] as string)
          actual = { tokens: ((await loadTokens(path)) ?? null) as unknown as JsonValue }
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
        break
      }
      case 'clear': {
        const dir = await mkdtemp(join(tmpdir(), 'atomic-chatgpt-contract-'))
        try {
          const path = join(dir, 'atomic-chatgpt-auth.json')
          await writeFile(path, '{}')
          await clearTokens(path)
          const exists = await stat(path).then(
            () => true,
            () => false
          )
          const second = await clearTokens(path).then(
            () => true,
            () => false
          )
          actual = { exists_after_clear: exists, second_clear_ok: second }
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
        break
      }
      case 'is_expired_at':
        actual = {
          expired: isExpiredAt(
            { expires_at: input['expires_at'] as number },
            input['now_unix'] as number,
            input['margin_secs'] as number
          ),
        }
        break
      default:
        throw new Error(`unknown case kind ${String(input['kind'])}`)
    }
    expect(actual).toEqual(c.expected)
  })
})

describe('chatgpt-route', () => {
  const { index, cases } = loadFixtureSet<Input, JsonValue>('chatgpt-route')
  const notes = (index as unknown as { comparator_notes: { constants: Record<string, JsonValue> } })
    .comparator_notes

  it('pins the same constants', () => {
    expect({
      provider: CHATGPT_PROVIDER,
      base_url: CHATGPT_BASE_URL,
      originator: CHATGPT_ORIGINATOR,
      user_agent: CHATGPT_USER_AGENT,
      client_version: CHATGPT_CLIENT_VERSION,
      request_timeout_secs: 600,
    }).toEqual(notes.constants)
  })

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const input = c.input
    let actual: JsonValue
    switch (input['kind']) {
      case 'upstream_request': {
        const request = buildUpstreamRequest({
          accessToken: input['access_token'] as string,
          accountId: (input['account_id'] as string | null) ?? null,
          sessionId: input['session_id'] as string,
          requestId: input['request_id'] as string,
          payload: chatRequestToResponses(input['chat_body'] as JsonValue, input['session_id'] as string),
        })
        actual = {
          method: request.method,
          url: request.url,
          headers: [...request.headers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          body: JSON.parse(request.body) as JsonValue,
        }
        break
      }
      case 'normalize_model':
        actual = { model: normalizeModel(input['item'] as JsonValue) as unknown as JsonValue }
        break
      case 'is_subscription_model':
        actual = { subscription: input['provider'] === CHATGPT_PROVIDER }
        break
      default:
        throw new Error(`unknown case kind ${String(input['kind'])}`)
    }
    expect(actual).toEqual(c.expected)
  })
})
