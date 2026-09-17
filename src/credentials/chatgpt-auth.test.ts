import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatGptAuth } from './chatgpt-auth.js'
import { loadTokens, saveTokens } from './chatgpt-store.js'
import type { StoredTokens } from './chatgpt-store.js'
import { accessTokenFor, json, jwt, startStub } from '../../test/helpers/chatgpt-stub.js'
import type { Stub } from '../../test/helpers/chatgpt-stub.js'

let dir: string
let path: string
let issuer: Stub
const NOW = 1_750_000_000_000

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-chatgpt-auth-'))
  path = join(dir, 'atomic-chatgpt-auth.json')
  issuer = await startStub((_req, res) => json(res, 500, { error: 'unexpected' }))
})
afterEach(async () => {
  await issuer.close()
  await rm(dir, { recursive: true, force: true })
})

function session(over: Partial<StoredTokens> = {}): StoredTokens {
  return {
    version: 1,
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    id_token: null,
    account_id: 'acct_1',
    plan_type: 'plus',
    email: 'user@example.test',
    expires_at: NOW / 1000 + 3600,
    ...over,
  }
}

function auth(options: { callbackPort?: number } = {}): ChatGptAuth {
  return new ChatGptAuth({ path, endpoint: { issuer: issuer.url }, now: () => NOW, ...options })
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    // A fresh connection each time: a pooled one may still point at a listener from a previous sign-in.
    httpRequest(url, { agent: false }, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => (body += c.toString()))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
      .on('error', reject)
      .end()
  })
}

describe('status and sign-out', () => {
  it('reloads a legacy account switch before serving a cached token', async () => {
    await saveTokens(path, session())
    const a = auth()
    await a.status()
    await saveTokens(
      path,
      session({ access_token: 'other', refresh_token: 'other-refresh', email: 'other@example.test' })
    )
    expect(await a.reload()).toMatchObject({ email: 'other@example.test' })
    expect(await a.accessToken()).toMatchObject({ token: 'other' })
    await rm(path)
    expect(await a.reload()).toMatchObject({ connected: false })
  })
  it('reports what is on disk without ever carrying a token, and forgets it on logout', async () => {
    await saveTokens(path, session())
    const a = auth()

    expect(await a.status()).toEqual({
      connected: true,
      email: 'user@example.test',
      plan_type: 'plus',
      expires_at: NOW / 1000 + 3600,
    })
    expect(await a.logout()).toMatchObject({ connected: false })
    expect(await loadTokens(path)).toBeUndefined()
    expect(await a.status()).toMatchObject({ connected: false })
  })
})

describe('access tokens', () => {
  it('hands out a live token without touching the network', async () => {
    await saveTokens(path, session())
    expect(await auth().accessToken()).toEqual({ token: 'access-1', accountId: 'acct_1' })
    expect(issuer.requests).toHaveLength(0)
  })

  it('says no subscription is connected when there is no session', async () => {
    await expect(auth().accessToken()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
  })

  it('refreshes a token inside the safety margin once, even for concurrent callers, and persists it', async () => {
    await saveTokens(path, session({ expires_at: NOW / 1000 + 60 }))
    issuer.handle((_req, res) =>
      json(res, 200, {
        access_token: accessTokenFor('acct_new', 2),
        refresh_token: 'refresh-2',
        expires_in: 3600,
      })
    )
    const a = auth()

    const [first, second] = await Promise.all([a.accessToken(), a.accessToken()])

    expect(first.accountId).toBe('acct_new')
    expect(second).toEqual(first)
    expect(issuer.requests).toHaveLength(1)
    expect(new URLSearchParams(issuer.requests[0]?.body)).toEqual(
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        refresh_token: 'refresh-1',
        scope: 'openid profile email offline_access',
      })
    )
    expect(await loadTokens(path)).toMatchObject({
      refresh_token: 'refresh-2',
      expires_at: NOW / 1000 + 3600,
    })
  })

  it('uses tokens another process already rotated instead of spending the old refresh token again', async () => {
    await saveTokens(path, session({ expires_at: NOW / 1000 + 60 }))
    const a = auth()
    await a.status()
    // The app refreshed meanwhile and wrote a fresh session.
    await saveTokens(path, session({ access_token: 'access-from-app', refresh_token: 'refresh-app' }))

    expect(await a.accessToken()).toEqual({ token: 'access-from-app', accountId: 'acct_1' })
    expect(issuer.requests).toHaveLength(0)
  })

  it('signs out on a terminal refresh error, but not when someone else rotated the token meanwhile', async () => {
    await saveTokens(path, session({ expires_at: 0 }))
    issuer.handle((_req, res) => json(res, 400, { error: 'invalid_grant' }))
    const a = auth()

    await expect(a.accessToken()).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      message: 'ChatGPT sign-in expired: reauthorization required: invalid_grant',
    })
    expect(await loadTokens(path)).toBeUndefined()

    await saveTokens(path, session({ expires_at: 0 }))
    const b = auth()
    await b.status()
    issuer.handle((_req, res) => {
      // The refusal arrives after the other process already wrote its rotated session.
      void saveTokens(path, session({ access_token: 'rotated', refresh_token: 'refresh-rotated' })).then(() =>
        json(res, 400, { error: { code: 'refresh_token_expired' } })
      )
    })
    expect(await b.accessToken()).toEqual({ token: 'rotated', accountId: 'acct_1' })
    expect(await loadTokens(path)).toMatchObject({ refresh_token: 'refresh-rotated' })
  })

  it('keeps the session when the token endpoint fails for any other reason', async () => {
    await saveTokens(path, session({ expires_at: 0 }))
    issuer.handle((_req, res) => json(res, 503, { error: 'temporarily_unavailable' }))

    await expect(auth().accessToken()).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      message: expect.stringMatching(
        /^Could not refresh the ChatGPT session: token request rejected \(503 Service Unavailable\): /
      ),
    })
    expect(await loadTokens(path)).toMatchObject({ refresh_token: 'refresh-1' })
  })

  it('forces a refresh when asked, whatever the recorded expiry says', async () => {
    await saveTokens(path, session())
    issuer.handle((_req, res) => json(res, 200, { access_token: 'forced', expires_in: 60 }))

    expect(await auth().accessToken(true)).toMatchObject({ token: 'forced' })
    expect(await loadTokens(path)).toMatchObject({ refresh_token: 'refresh-1', access_token: 'forced' })
  })
})

describe('sign-in', () => {
  it('binds the callback first, then exchanges the code the browser brings back', async () => {
    const port = await freePort()
    issuer.handle((_req, res) =>
      json(res, 200, {
        access_token: accessTokenFor('acct_login'),
        refresh_token: 'r',
        id_token: jwt({ email: 'login@example.test' }),
      })
    )
    const a = auth({ callbackPort: port })

    const { authorize_url } = await a.startLogin()
    const url = new URL(authorize_url)
    expect(url.origin + url.pathname).toBe(`${issuer.url}/oauth/authorize`)
    const waiting = a.waitLogin()
    const page = await get(
      `http://127.0.0.1:${port}/auth/callback?code=the-code&state=${url.searchParams.get('state')}`
    )

    expect(page.status).toBe(200)
    expect(await waiting).toMatchObject({ connected: true, email: 'login@example.test', plan_type: 'plus' })
    const form = new URLSearchParams(issuer.requests[0]?.body)
    expect(form.get('code')).toBe('the-code')
    expect(form.get('grant_type')).toBe('authorization_code')
    // The verifier travels only to the token endpoint, and matches the challenge the browser saw.
    const { createHash } = await import('node:crypto')
    expect(
      createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest('base64url')
    ).toBe(url.searchParams.get('code_challenge'))
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ account_id: 'acct_login' })
  })

  it('refuses a callback whose state does not match, and reports a browser-side error', async () => {
    const port = await freePort()
    const a = auth({ callbackPort: port })

    await a.startLogin()
    const mismatch = expect(a.waitLogin()).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      message: 'callback state did not match this sign-in',
    })
    await get(`http://127.0.0.1:${port}/auth/callback?code=c&state=forged`)
    await mismatch

    await a.startLogin()
    const declined = expect(a.waitLogin()).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      message: 'access_denied: User declined',
    })
    expect((await get(`http://127.0.0.1:${port}/elsewhere`)).status).toBe(404)
    await get(`http://127.0.0.1:${port}/auth/callback?error=access_denied&error_description=User+declined`)
    await declined
    expect(issuer.requests).toHaveLength(0)
  })

  it('cancels a sign-in still waiting on the browser, including by starting another', async () => {
    const port = await freePort()
    const a = auth({ callbackPort: port })

    await a.startLogin()
    const first = expect(a.waitLogin()).rejects.toMatchObject({ code: 'AUTH_CANCELLED' })
    await a.startLogin()
    await first

    const second = expect(a.waitLogin()).rejects.toMatchObject({ code: 'AUTH_CANCELLED' })
    a.cancelLogin()
    await second
    await expect(a.waitLogin()).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('reports a busy callback port before any browser is opened', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const port = (blocker.address() as AddressInfo).port
    try {
      await expect(auth({ callbackPort: port }).startLogin()).rejects.toMatchObject({
        code: 'IO_ERROR',
        message: expect.stringContaining(`cannot listen on 127.0.0.1:${port} for the sign-in callback`),
      })
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('times out a sign-in the browser never completes', async () => {
    const a = new ChatGptAuth({
      path,
      endpoint: { issuer: issuer.url },
      callbackPort: await freePort(),
      callbackTimeoutMs: 20,
    })
    await a.startLogin()
    await expect(a.waitLogin()).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      message: 'timed out waiting for the browser sign-in',
    })
  })

  it('turns a refused code exchange into a failed sign-in', async () => {
    const port = await freePort()
    issuer.handle((_req, res) => json(res, 400, { error: 'invalid_grant' }))
    const a = auth({ callbackPort: port })

    const url = new URL((await a.startLogin()).authorize_url)
    const waiting = expect(a.waitLogin()).rejects.toMatchObject({ code: 'AUTH_FAILED' })
    await get(`http://127.0.0.1:${port}/auth/callback?code=c&state=${url.searchParams.get('state')}`)

    await waiting
    expect(await loadTokens(path)).toBeUndefined()
  })
})
