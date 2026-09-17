/**
 * OAuth 2.0 + PKCE against `auth.openai.com`, the way the Codex CLI signs in.
 *
 * Ported from: src-tauri/src/core/auth/chatgpt.rs. Contract: test/fixtures/app/chatgpt-auth (PKCE,
 * authorize URL, callback parsing, `state` comparison, JWT claims, token response → session).
 *
 * The issuer is injectable for tests only; production always talks to `ISSUER`. The client id is
 * OpenAI's public Codex one (ADR `2026-08-27-connect-a-chatgpt-subscription-as-a-model-provider`),
 * while `originator` names this client.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { STATUS_CODES, createServer } from 'node:http'
import { AtomicCoreError } from '../contracts/index.js'
import { TOKEN_FILE_VERSION } from './chatgpt-store.js'
import type { StoredTokens } from './chatgpt-store.js'

export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const ISSUER = 'https://auth.openai.com'
export const SCOPES = 'openid profile email offline_access'
/** Matched exactly by the authorization server, so there is no fallback port. */
export const CALLBACK_PORT = 1455
export const CALLBACK_PATH = '/auth/callback'
export const CALLBACK_TIMEOUT_MS = 300_000
export const ORIGINATOR = 'atomic_chat'
const AUTH_CLAIM_NAMESPACE = 'https://api.openai.com/auth'
/** Token-endpoint errors that mean the refresh credential itself is finished. */
export const TERMINAL_TOKEN_ERRORS = ['invalid_grant', 'invalid_refresh_token', 'refresh_token_expired']
export const REAUTHORIZATION_REQUIRED = 'reauthorization required'
const TOKEN_REQUEST_TIMEOUT_MS = 30_000

export function redirectUri(): string {
  return `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`
}

export interface Pkce {
  verifier: string
  challenge: string
}

export function deriveChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url')
}

export function newPkce(): Pkce {
  const verifier = randomBytes(64).toString('base64url')
  return { verifier, challenge: deriveChallenge(verifier) }
}

export function newState(): string {
  return randomBytes(32).toString('base64url')
}

/** Constant-time for equal lengths; the callback is reachable by any local process. */
export function stateMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(received, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export function authorizeUrl(challenge: string, state: string, issuer = ISSUER): string {
  const params = new URLSearchParams([
    ['response_type', 'code'],
    ['client_id', CLIENT_ID],
    ['redirect_uri', redirectUri()],
    ['scope', SCOPES],
    ['code_challenge', challenge],
    ['code_challenge_method', 'S256'],
    ['state', state],
    ['originator', ORIGINATOR],
    ['codex_cli_simplified_flow', 'true'],
    ['id_token_add_organizations', 'true'],
  ])
  return `${issuer}/oauth/authorize?${params.toString()}`
}

export type CallbackParams =
  { kind: 'code'; code: string; state: string } | { kind: 'error'; error: string; description: string | null }

/** `form_urlencoded::parse` into a map: `+` is a space, percent escapes decode, the last repeat wins. */
export function parseCallbackQuery(query: string): CallbackParams {
  const pairs = new Map(new URLSearchParams(query))
  const error = pairs.get('error')
  if (error !== undefined)
    return { kind: 'error', error, description: pairs.get('error_description') ?? null }
  const code = pairs.get('code')
  if (!code) throw new AtomicCoreError('AUTH_FAILED', 'callback carried no authorization code')
  const state = pairs.get('state')
  if (!state) throw new AtomicCoreError('AUTH_FAILED', 'callback carried no state')
  return { kind: 'code', code, state }
}

export interface IdClaims {
  account_id: string | null
  plan_type: string | null
  email: string | null
}

/**
 * The `base64` crate's strict no-padding decoders: only the alphabet, no `=`, and the canonical
 * encoding of the bytes (non-zero trailing bits are rejected). Node's decoder accepts all of those.
 */
function strictBase64(input: string, alphabet: 'base64url' | 'base64'): Buffer | undefined {
  const pattern = alphabet === 'base64url' ? /^[A-Za-z0-9_-]*$/ : /^[A-Za-z0-9+/]*$/
  if (!pattern.test(input) || input.length % 4 === 1) return undefined
  const bytes = Buffer.from(input, alphabet)
  const canonical = bytes.toString(alphabet).replace(/=+$/, '')
  return canonical === input ? bytes : undefined
}

function stringAt(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = (value as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : null
}

/**
 * The account fields out of a JWT payload. The signature is not verified: the token arrived over a
 * TLS connection to a pinned host, and nothing here is a security decision. Anything unparseable
 * yields empty claims.
 */
export function decodeJwtClaims(token: string): IdClaims {
  const empty: IdClaims = { account_id: null, plan_type: null, email: null }
  const parts = token.split('.')
  if (parts.length < 2) return empty
  const payload = parts[1] as string
  const bytes = strictBase64(payload, 'base64url') ?? strictBase64(payload, 'base64')
  if (!bytes) return empty
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    return empty
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return empty
  const auth = (value as Record<string, unknown>)[AUTH_CLAIM_NAMESPACE]
  return {
    account_id: stringAt(auth, 'chatgpt_account_id'),
    plan_type: stringAt(auth, 'chatgpt_plan_type'),
    email: stringAt(value, 'email'),
  }
}

export interface TokenResponse {
  access_token: string
  refresh_token: string | null
  id_token: string | null
  expires_in: number | null
}

/** serde's derive for the token endpoint's body; `undefined` where serde would refuse it. */
export function parseTokenResponse(raw: unknown): TokenResponse | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o['access_token'] !== 'string') return undefined
  const opt = (v: unknown) => (v === undefined || v === null ? null : typeof v === 'string' ? v : false)
  const refresh = opt(o['refresh_token'])
  const id = opt(o['id_token'])
  const lifetime = o['expires_in']
  if (refresh === false || id === false) return undefined
  if (
    lifetime !== undefined &&
    lifetime !== null &&
    (typeof lifetime !== 'number' || !Number.isInteger(lifetime))
  )
    return undefined
  return {
    access_token: o['access_token'],
    refresh_token: refresh,
    id_token: id,
    expires_in: typeof lifetime === 'number' ? lifetime : null,
  }
}

/**
 * The session to store from a token response. A refresh may omit `refresh_token` when the provider
 * does not rotate it, so the previous one is kept. The account id is read from the access token
 * first (a refresh may carry no id token), the email from the id token first. The lifetime defaults
 * to an hour and is clamped to [1 minute, 30 days].
 */
export function toStored(
  response: TokenResponse,
  nowUnix: number,
  previousRefresh: string | null
): StoredTokens {
  const refresh = response.refresh_token ?? previousRefresh
  if (refresh === null) throw new AtomicCoreError('AUTH_FAILED', 'sign-in returned no refresh token')
  const access = decodeJwtClaims(response.access_token)
  const id = response.id_token !== null ? decodeJwtClaims(response.id_token) : decodeJwtClaims('')
  const lifetime = Math.min(Math.max(response.expires_in ?? 3600, 60), 30 * 24 * 3600)
  return {
    version: TOKEN_FILE_VERSION,
    access_token: response.access_token,
    refresh_token: refresh,
    id_token: response.id_token,
    account_id: access.account_id ?? id.account_id,
    plan_type: access.plan_type ?? id.plan_type,
    email: id.email ?? access.email,
    expires_at: nowUnix + lifetime,
  }
}

export interface TokenEndpoint {
  issuer?: string
  fetch?: typeof fetch
}

/**
 * POST a form to the token endpoint. A spent or revoked refresh credential is terminal and says so
 * with `REAUTHORIZATION_REQUIRED`; anything else may be transient and carries the provider's words.
 */
export async function postTokenForm(
  form: Array<[string, string]>,
  endpoint: TokenEndpoint = {}
): Promise<TokenResponse> {
  const fetchImpl = endpoint.fetch ?? fetch
  let response: Response
  try {
    response = await fetchImpl(`${endpoint.issuer ?? ISSUER}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    })
  } catch (e) {
    throw new AtomicCoreError('UPSTREAM_ERROR', `token request failed: ${(e as Error).message}`)
  }
  let body: string
  try {
    body = await response.text()
  } catch (e) {
    throw new AtomicCoreError('UPSTREAM_ERROR', `cannot read token response: ${(e as Error).message}`)
  }
  if (!response.ok) {
    const code = tokenErrorCode(body)
    if (TERMINAL_TOKEN_ERRORS.includes(code))
      throw new AtomicCoreError('AUTH_REQUIRED', `${REAUTHORIZATION_REQUIRED}: ${code}`)
    throw new AtomicCoreError(
      'UPSTREAM_ERROR',
      `token request rejected (${response.status}${statusText(response)}): ${body}`
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch (e) {
    throw new AtomicCoreError('UPSTREAM_ERROR', `cannot parse token response: ${(e as Error).message}`)
  }
  const parsed = parseTokenResponse(raw)
  if (!parsed) throw new AtomicCoreError('UPSTREAM_ERROR', 'cannot parse token response: unexpected shape')
  return parsed
}

/** `reqwest::StatusCode`'s Display: the canonical reason, `401 Unauthorized`, not the server's phrase. */
function statusText(response: Response): string {
  const reason = STATUS_CODES[response.status]
  return reason ? ` ${reason}` : ''
}

/** The OAuth error code: `error` as a string, or `error.code` when `error` is an object. */
export function tokenErrorCode(body: string): string {
  try {
    const error = (JSON.parse(body) as { error?: unknown } | null)?.error
    if (typeof error === 'string') return error
    if (typeof error === 'object' && error !== null) {
      const code = (error as { code?: unknown }).code
      return typeof code === 'string' ? code : ''
    }
  } catch {
    // not JSON
  }
  return ''
}

export async function exchangeCode(
  code: string,
  pkce: Pkce,
  nowUnix: number,
  endpoint: TokenEndpoint = {}
): Promise<StoredTokens> {
  const response = await postTokenForm(
    [
      ['grant_type', 'authorization_code'],
      ['client_id', CLIENT_ID],
      ['code', code],
      ['redirect_uri', redirectUri()],
      ['code_verifier', pkce.verifier],
    ],
    endpoint
  )
  return toStored(response, nowUnix, null)
}

export async function refreshTokens(
  refreshToken: string,
  nowUnix: number,
  endpoint: TokenEndpoint = {}
): Promise<StoredTokens> {
  const response = await postTokenForm(
    [
      ['grant_type', 'refresh_token'],
      ['client_id', CLIENT_ID],
      ['refresh_token', refreshToken],
      ['scope', SCOPES],
    ],
    endpoint
  )
  return toStored(response, nowUnix, refreshToken)
}

/** The page the browser is left on. Static: nothing from the request is reflected into it. */
const CALLBACK_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><title>Atomic Chat</title></head>' +
  '<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
  '<p>You can close this tab and return to Atomic Chat.</p></body></html>'

export interface CallbackListener {
  /** Resolves with the authorization code, or rejects with why the sign-in did not complete. */
  code: Promise<string>
  cancel(): void
}

/**
 * Bind the loopback listener before the browser opens, so a busy port fails before the user has
 * signed in. Only the first callback counts; the listener closes as soon as it arrives, on cancel,
 * or on timeout.
 */
export async function listenForCallback(
  expectedState: string,
  options: { port?: number; timeoutMs?: number } = {}
): Promise<CallbackListener> {
  const port = options.port ?? CALLBACK_PORT
  let settle: (outcome: { code: string } | { error: AtomicCoreError }) => void = () => {}
  const outcome = new Promise<{ code: string } | { error: AtomicCoreError }>((resolve) => (settle = resolve))
  let settled = false
  const finish = (value: { code: string } | { error: AtomicCoreError }) => {
    if (settled) return
    settled = true
    settle(value)
  }

  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    const q = url.indexOf('?')
    const path = q >= 0 ? url.slice(0, q) : url
    if (path !== CALLBACK_PATH) {
      res.writeHead(404, { 'content-length': '0' })
      res.end()
      return
    }
    let result: { code: string } | { error: AtomicCoreError }
    try {
      const params = parseCallbackQuery(q >= 0 ? url.slice(q + 1) : '')
      if (params.kind === 'error') {
        const message = params.description === null ? params.error : `${params.error}: ${params.description}`
        result = { error: new AtomicCoreError('AUTH_FAILED', message) }
      } else if (stateMatches(expectedState, params.state)) {
        result = { code: params.code }
      } else {
        result = { error: new AtomicCoreError('AUTH_FAILED', 'callback state did not match this sign-in') }
      }
    } catch (e) {
      result = { error: e as AtomicCoreError }
    }
    // Settle only once the page has gone out: settling closes the listener, and closing first would
    // leave the browser with a reset connection instead of the "you can close this tab" page.
    res.once('finish', () => finish(result))
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(CALLBACK_PAGE)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: Error) =>
      reject(
        new AtomicCoreError(
          'IO_ERROR',
          `cannot listen on 127.0.0.1:${port} for the sign-in callback (${e.message}). This port is fixed by OpenAI's redirect URI — close whatever is using it (often the Codex CLI mid-login) and try again.`
        )
      )
    )
    server.listen(port, '127.0.0.1', () => resolve())
  })

  const timer = setTimeout(
    () => finish({ error: new AtomicCoreError('AUTH_FAILED', 'timed out waiting for the browser sign-in') }),
    options.timeoutMs ?? CALLBACK_TIMEOUT_MS
  )
  timer.unref?.()

  const code = outcome.then((result) => {
    clearTimeout(timer)
    // Idle connections only: the one that brought the callback may still be delivering its page.
    server.close()
    server.closeIdleConnections()
    if ('error' in result) throw result.error
    return result.code
  })
  // Nobody may be awaiting yet; an unobserved rejection must not crash the process.
  code.catch(() => {})
  return {
    code,
    cancel: () => finish({ error: new AtomicCoreError('AUTH_CANCELLED', 'sign-in cancelled') }),
  }
}
