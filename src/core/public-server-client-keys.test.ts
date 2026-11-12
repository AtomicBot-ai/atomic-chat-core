import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createCore, data, useCoreHarness } from '../../test/helpers/core-harness.js'
import { CoreClient } from '../client/index.js'
import type { AtomicCore } from './index.js'

useCoreHarness()

const DEVICE_A = 'device-a-0123456789abcdef'
const DEVICE_B = 'device-b-0123456789abcdef'

const clientOf = (core: AtomicCore) => new CoreClient({ baseUrl: core.control.url, token: core.controlToken })

async function status(port: number, key?: string): Promise<number> {
  const response = await fetch(
    `http://127.0.0.1:${port}/v1/models`,
    key === undefined ? {} : { headers: { authorization: `Bearer ${key}` } }
  )
  await response.text()
  return response.status
}

/** Every file the core wrote under its data folder, as text. */
async function everythingWritten(root: string): Promise<string> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
  return (await Promise.all(files.map((file) => readFile(file, 'utf8').catch(() => '')))).join('\n')
}

it('accepts the extra keys next to the server key, refuses a removed one, and keeps them across a restart', async () => {
  const core = await createCore()
  const client = clientOf(core)
  const started = await client.startServer({ port: 0, api_key: 'server-key', state_file: true })
  expect(await client.setServerClientKeys([DEVICE_A, DEVICE_B])).toEqual({ count: 2 })

  expect(await status(started.port, 'server-key')).toBe(200)
  expect(await status(started.port, DEVICE_A)).toBe(200)
  expect(await status(started.port, DEVICE_B)).toBe(200)
  expect(await status(started.port, 'device-c-0123456789abcdef')).toBe(401)
  expect(await status(started.port)).toBe(401)

  expect(await client.setServerClientKeys([DEVICE_B])).toEqual({ count: 1 })
  expect(await status(started.port, DEVICE_A)).toBe(401)
  expect(await status(started.port, DEVICE_B)).toBe(200)

  await client.stopServer()
  const restarted = await client.startServer({ port: 0, api_key: 'server-key' })
  expect(await status(restarted.port, DEVICE_B), 'kept across a listener restart').toBe(200)
  expect(await status(restarted.port, DEVICE_A)).toBe(401)
})

it('never closes an open server, and leaves what the state and remote access report unchanged', async () => {
  const core = await createCore()
  const client = clientOf(core)
  const started = await client.startServer({ port: 0 })
  await client.setServerClientKeys([DEVICE_A])
  expect(await status(started.port)).toBe(200)
  expect(await status(started.port, 'anything')).toBe(200)
  expect((await client.serverStatus()).requires_api_key).toBe(false)
  expect(core.remoteAccessStatus().serverHasApiKey).toBe(false)
})

it('is ignored while the host keeps its own keyring (AtomicCoreOptions.publicApiKeys)', async () => {
  const core = await createCore({ publicApiKeys: () => ['host-key'] })
  const client = clientOf(core)
  const started = await client.startServer({ port: 0, api_key: 'server-key' })
  await client.setServerClientKeys([DEVICE_A])
  expect(await status(started.port, 'host-key')).toBe(200)
  expect(await status(started.port, DEVICE_A)).toBe(401)
})

it('never shows a key in the snapshot, the server state, remote access or anything written to disk', async () => {
  const core = await createCore()
  const client = clientOf(core)
  await client.startServer({ port: 0, api_key: 'server-key', state_file: true })
  await client.setServerClientKeys([DEVICE_A, DEVICE_B])

  const surfaces = JSON.stringify([
    await client.snapshot(),
    await client.serverStatus(),
    core.publicState(),
    core.remoteAccessStatus(),
    await everythingWritten(data.root),
  ])
  expect(surfaces).not.toContain(DEVICE_A)
  expect(surfaces).not.toContain(DEVICE_B)
  expect(core.remoteAccessStatus().serverHasApiKey).toBe(true)
})
