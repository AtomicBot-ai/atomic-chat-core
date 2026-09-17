import { describe, expect, it } from 'vitest'
import { exchangeCode, newPkce, newState, postTokenForm, tokenErrorCode } from './chatgpt-oauth.js'

const endpoint = (fetchImpl: typeof fetch) => ({ issuer: 'https://issuer.test', fetch: fetchImpl })

describe('token endpoint', () => {
  it('reads the OAuth error code from a string, an object with a code, or nothing', () => {
    expect(tokenErrorCode('{"error":"invalid_grant"}')).toBe('invalid_grant')
    expect(tokenErrorCode('{"error":{"code":"refresh_token_expired"}}')).toBe('refresh_token_expired')
    expect(tokenErrorCode('{"error":{"code":5}}')).toBe('')
    expect(tokenErrorCode('{"message":"nope"}')).toBe('')
    expect(tokenErrorCode('<html>')).toBe('')
  })

  it('reports a failed connection, an unparsable success body and one of the wrong shape as upstream errors', async () => {
    await expect(
      postTokenForm(
        [],
        endpoint(async () => Promise.reject(new Error('ECONNREFUSED')))
      )
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', message: 'token request failed: ECONNREFUSED' })
    await expect(
      postTokenForm(
        [],
        endpoint(async () => new Response('not json'))
      )
    ).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      message: expect.stringMatching(/^cannot parse token response/),
    })
    await expect(
      postTokenForm(
        [],
        endpoint(async () => Response.json({ token: 'x' }))
      )
    ).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    })
    await expect(
      postTokenForm(
        [],
        endpoint(async () => new Response('teapot', { status: 418 }))
      )
    ).rejects.toMatchObject({ message: "token request rejected (418 I'm a Teapot): teapot" })
  })

  it('posts the authorization-code form with the verifier and the fixed redirect URI', async () => {
    let sent: { url: string; body: string } | undefined
    const pkce = newPkce()
    const stored = await exchangeCode(
      'the-code',
      pkce,
      100,
      endpoint(async (url, init) => {
        sent = { url: String(url), body: String(init?.body) }
        return Response.json({ access_token: 'a', refresh_token: 'r' })
      })
    )

    expect(sent?.url).toBe('https://issuer.test/oauth/token')
    expect(Object.fromEntries(new URLSearchParams(sent?.body))).toEqual({
      grant_type: 'authorization_code',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      code: 'the-code',
      redirect_uri: 'http://localhost:1455/auth/callback',
      code_verifier: pkce.verifier,
    })
    expect(stored).toMatchObject({ refresh_token: 'r', expires_at: 3700 })
    expect(newState()).not.toBe(newState())
  })
})
