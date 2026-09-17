/**
 * Stage 4c through the compiled binary: cloud providers registered with the CLI and routed by the
 * daemon's public server, and a ChatGPT subscription signed in through control and served.
 *
 * `auth.openai.com` and `chatgpt.com` are replaced by local stubs through the daemon's
 * `ATOMIC_CHATGPT_*` test hooks; nothing here touches the network.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'
import { accessTokenFor, json, jwt, responsesStream, startStub } from '../helpers/chatgpt-stub.js'
import type { Stub } from '../helpers/chatgpt-stub.js'

let dataFolder: string
const daemons: ChildProcess[] = []
const stubs: Stub[] = []

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-cloud-e2e-'))
})
afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  core.reapJournalledChildren(dataFolder)
  await Promise.all(stubs.splice(0).map((s) => s.close()))
  await rm(dataFolder, { recursive: true, force: true })
})

async function stub(handler: Parameters<typeof startStub>[0]): Promise<Stub> {
  const s = await startStub(handler)
  stubs.push(s)
  return s
}

const control = (ready: ReadyLine, path: string, init: RequestInit = {}) =>
  core.control(dataFolder, ready, path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })

async function publicPort(ready: ReadyLine): Promise<number> {
  const res = await control(ready, '/server/start', { method: 'POST', body: JSON.stringify({ port: 0 }) })
  return ((await res.json()) as { port: number }).port
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe.skipIf(!existsSync(core.BIN))('the compiled core serves cloud providers', () => {
  it('routes a provider registered with the CLI, with its key and headers, and keeps the key out of settings', async () => {
    const upstream = await stub((_req, res) => json(res, 200, { id: 'chatcmpl-cloud', choices: [] }))
    const { ready } = await core.startDaemon(dataFolder, daemons)

    const set = core.runCli(dataFolder, [
      'providers',
      'set',
      'cloudprov',
      '--base-url',
      `${upstream.url}/v1`,
      '--api-key',
      'sk-cli',
      '--model',
      'cloud-model',
      '--header',
      'X-Org: acme',
    ])
    expect(set.status, set.stderr).toBe(0)
    const port = await publicPort(ready)

    const answer = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cloud-model', messages: [] }),
    })

    expect(await answer.json()).toEqual({ id: 'chatcmpl-cloud', choices: [] })
    expect(upstream.requests[0]?.headers).toMatchObject({ 'authorization': 'Bearer sk-cli', 'x-org': 'acme' })
    expect(readFileSync(join(dataFolder, 'atomic-core', 'settings.json'), 'utf8')).not.toContain('sk-cli')
    const credentials = join(dataFolder, 'atomic-core', 'credentials.json')
    expect(readFileSync(credentials, 'utf8')).toContain('sk-cli')
    if (process.platform !== 'win32') expect(statSync(credentials).mode & 0o777).toBe(0o600)

    const listed = core.runCli(dataFolder, ['providers', 'list', '--json'])
    expect(JSON.parse(listed.stdout)).toEqual([
      expect.objectContaining({ provider: 'cloudprov', has_api_key: true, models: ['cloud-model'] }),
    ])
    expect(listed.stdout).not.toContain('sk-cli')
  })

  it('signs in to ChatGPT through control, serves the subscription, and refreshes once on a 401', async () => {
    let tokenCalls = 0
    const issuer = await stub((req, res) => {
      tokenCalls++
      const form = new URLSearchParams(req.body)
      json(res, 200, {
        access_token: accessTokenFor('acct_e2e', tokenCalls),
        refresh_token: `refresh-${tokenCalls}`,
        id_token: jwt({ email: 'e2e@example.test' }),
        expires_in: 3600,
        grant: form.get('grant_type'),
      })
    })
    let subscriptionCalls = 0
    const subscription = await stub((req, res) => {
      subscriptionCalls++
      if (subscriptionCalls === 1) return json(res, 401, { detail: 'token expired' })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        responsesStream(
          `answered with ${req.headers.authorization === 'Bearer ' + accessTokenFor('acct_e2e', 2) ? 'refreshed' : 'stale'} token`
        )
      )
    })
    const callbackPort = await freePort()
    const { ready } = await core.startDaemon(dataFolder, daemons, [], {
      ATOMIC_CHATGPT_ISSUER: issuer.url,
      ATOMIC_CHATGPT_BASE_URL: subscription.url,
      ATOMIC_CHATGPT_CALLBACK_PORT: String(callbackPort),
    })

    const started = (await (await control(ready, '/auth/chatgpt/login', { method: 'POST' })).json()) as {
      authorize_url: string
    }
    const state = new URL(started.authorize_url).searchParams.get('state')
    const waiting = control(ready, '/auth/chatgpt/login/wait', { method: 'POST' })
    await new Promise<void>((resolve, reject) =>
      httpRequest(
        {
          host: '127.0.0.1',
          port: callbackPort,
          path: `/auth/callback?code=browser-code&state=${state}`,
          agent: false,
        },
        (res) => {
          res.resume()
          res.on('end', resolve)
        }
      )
        .on('error', reject)
        .end()
    )
    const connected = await waiting
    expect(await connected.json()).toMatchObject({
      connected: true,
      email: 'e2e@example.test',
      plan_type: 'plus',
    })
    const tokenFile = join(dataFolder, 'atomic-chatgpt-auth.json')
    expect(JSON.parse(readFileSync(tokenFile, 'utf8'))).toMatchObject({
      version: 1,
      account_id: 'acct_e2e',
      refresh_token: 'refresh-1',
    })
    if (process.platform !== 'win32') expect(statSync(tokenFile).mode & 0o777).toBe(0o600)

    await control(ready, '/cloud/providers/chatgpt', {
      method: 'PUT',
      body: JSON.stringify({ models: ['gpt-5'] }),
    })
    const port = await publicPort(ready)
    const answer = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    const body = await answer.text()

    expect(answer.headers.get('content-type')).toBe('text/event-stream')
    expect(body).toContain('answered with refreshed token')
    expect(body.endsWith('data: [DONE]\n\n')).toBe(true)
    expect(subscriptionCalls).toBe(2)
    expect(JSON.parse(readFileSync(tokenFile, 'utf8'))).toMatchObject({ refresh_token: 'refresh-2' })

    const status = core.runCli(dataFolder, ['auth', 'chatgpt', 'status'])
    expect(status.stdout).toBe('Connected as e2e@example.test (plus).\n')
    const logout = core.runCli(dataFolder, ['auth', 'chatgpt', 'logout'])
    expect(logout.status).toBe(0)
    expect(existsSync(tokenFile)).toBe(false)
    const signedOut = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5', messages: [] }),
    })
    expect([signedOut.status, await signedOut.text()]).toEqual([401, 'no ChatGPT subscription is connected'])
  })
})
