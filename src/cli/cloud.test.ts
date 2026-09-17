import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { accessTokenFor, json, startStub } from '../../test/helpers/chatgpt-stub.js'
import type { Stub } from '../../test/helpers/chatgpt-stub.js'
import { AtomicCore } from '../core/index.js'
import { authCommand, providersCommand } from './cloud.js'
import { recordingIo } from './io.js'

let data: TmpDataFolder
let issuer: Stub
const cores: AtomicCore[] = []

beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-cli-cloud-')
  issuer = await startStub((_req, res) =>
    json(res, 200, {
      access_token: accessTokenFor('acct_cli'),
      refresh_token: 'r',
      id_token: accessTokenFor('x'),
    })
  )
})
afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.shutdown()))
  await issuer.close()
  await data.cleanup()
})

const folder = () => ['--data-folder', data.root]

async function core(env: NodeJS.ProcessEnv = {}): Promise<AtomicCore> {
  const created = await AtomicCore.create({
    dataFolder: data.root,
    controlPort: 0,
    env: { ...process.env, ...env },
  })
  cores.push(created)
  return created
}

describe('providers', () => {
  it('registers a provider with a key from the environment, lists it without the key, and removes it', async () => {
    const running = await core()
    const set = recordingIo({ env: { OPENAI_KEY: 'sk-env' } })
    expect(
      await providersCommand(
        [
          'set',
          'openai',
          '--base-url',
          'https://api.openai.com/v1',
          '--api-key-env',
          'OPENAI_KEY',
          '--model',
          'gpt-4o',
          '--model',
          'o3',
          '--header',
          'X-Org: acme',
          ...folder(),
        ],
        set
      )
    ).toBe(0)
    expect(set.out.join('')).toContain('Registered openai.')
    expect(running.apiKeys.get('openai')).toBe('sk-env')

    const listed = recordingIo()
    expect(await providersCommand(['list', '--json', ...folder()], listed)).toBe(0)
    expect(JSON.parse(listed.out.join(''))).toEqual([
      {
        provider: 'openai',
        base_url: 'https://api.openai.com/v1',
        custom_headers: [{ header: 'X-Org', value: 'acme' }],
        models: ['gpt-4o', 'o3'],
        has_api_key: true,
      },
    ])
    const table = recordingIo()
    await providersCommand(['list', ...folder()], table)
    expect(table.out.join('')).toContain('openai  https://api.openai.com/v1  key set  2 model(s)')

    await providersCommand(['set', 'openai', '--clear-api-key', '--json', ...folder()], recordingIo())
    expect(running.apiKeys.has('openai')).toBe(false)

    const removed = recordingIo()
    expect(await providersCommand(['remove', 'openai', ...folder()], removed)).toBe(0)
    const empty = recordingIo()
    await providersCommand(['list', ...folder()], empty)
    expect(empty.out.join('')).toBe('No cloud providers are registered.\n')
  })

  it('explains a bad invocation', async () => {
    await core()
    const usage = recordingIo()
    expect(await providersCommand([], usage)).toBe(2)
    await expect(providersCommand(['set', ...folder()], recordingIo())).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    await expect(providersCommand(['remove', ...folder()], recordingIo())).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    await expect(
      providersCommand(['set', 'p', '--header', 'no colon', ...folder()], recordingIo())
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    await expect(
      providersCommand(['set', 'p', '--api-key-env', 'MISSING_VAR', ...folder()], recordingIo())
    ).rejects.toMatchObject({ message: 'environment variable MISSING_VAR is empty' })
  })
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe('auth chatgpt', () => {
  it('signs in through the browser URL it prints, then reports the account and signs out', async () => {
    const port = await freePort()
    await core({ ATOMIC_CHATGPT_ISSUER: issuer.url, ATOMIC_CHATGPT_CALLBACK_PORT: String(port) })
    let opened = ''
    const login = recordingIo({
      openUrl: async (url) => {
        opened = url
        // The "browser": come straight back to the callback with the state from the URL.
        const state = new URL(url).searchParams.get('state')
        httpRequest(
          { host: '127.0.0.1', port, path: `/auth/callback?code=c&state=${state}`, agent: false },
          (res) => res.resume()
        ).end()
      },
    })

    expect(await authCommand(['chatgpt', 'login', ...folder()], login)).toBe(0)
    expect(login.err.join('')).toContain(opened)
    expect(login.out.join('')).toBe('Connected as unknown (plus).\n')

    const status = recordingIo()
    expect(await authCommand(['chatgpt', 'status', '--json', ...folder()], status)).toBe(0)
    expect(JSON.parse(status.out.join(''))).toMatchObject({ connected: true, plan_type: 'plus' })

    expect(await authCommand(['chatgpt', 'logout', ...folder()], recordingIo())).toBe(0)
    const after = recordingIo()
    expect(await authCommand(['chatgpt', 'status', ...folder()], after)).toBe(1)
    expect(after.out.join('')).toBe('Not connected.\n')
  })

  it('does not open a browser when asked not to, and lists subscription models', async () => {
    await core({
      ATOMIC_CHATGPT_ISSUER: issuer.url,
      ATOMIC_CHATGPT_BASE_URL: issuer.url,
      ATOMIC_CHATGPT_CALLBACK_PORT: String(await freePort()),
    })
    const usage = recordingIo()
    expect(await authCommand(['github', 'login', ...folder()], usage)).toBe(2)

    const models = recordingIo()
    await expect(authCommand(['chatgpt', 'models', ...folder()], models)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    })
    let opened = false
    const running = cores[0] as AtomicCore
    const login = authCommand(
      ['chatgpt', 'login', '--no-browser', ...folder()],
      recordingIo({ openUrl: async () => void (opened = true) })
    )
    await new Promise((r) => setTimeout(r, 100))
    running.chatgpt.cancelLogin()
    await expect(login).rejects.toMatchObject({ code: 'AUTH_CANCELLED' })
    expect(opened).toBe(false)
  })
})
