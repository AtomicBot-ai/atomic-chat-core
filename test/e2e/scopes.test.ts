import { spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APP_BIN,
  BIN,
  control,
  CORE_VERSION,
  reapJournalledChildren,
  startDaemon,
  writeModel,
} from '../helpers/compiled-core.js'

const daemons: ChildProcess[] = []
const folders: string[] = []
async function folder(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'atomic-scopes-'))
  folders.push(path)
  return path
}
afterEach(async () => {
  for (const child of daemons.splice(0)) child.kill('SIGKILL')
  for (const path of folders) reapJournalledChildren(path)
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe.skipIf(!existsSync(APP_BIN) || !existsSync(BIN))('separate app and CLI binaries', () => {
  it('isolates PID, lock, model inventory, key and state, and stops only the selected owner', async () => {
    const appDir = await folder()
    const cliDir = await folder()
    await writeModel(appDir, 'only-in-app')
    const app = await startDaemon(appDir, daemons, [], {}, APP_BIN)
    const cli = await startDaemon(cliDir, daemons)
    expect(app.ready.pid).not.toBe(cli.ready.pid)
    const appLock = JSON.parse(readFileSync(join(appDir, 'atomic-core/instance.lock'), 'utf8')) as {
      owner_scope: string
    }
    const cliLock = JSON.parse(readFileSync(join(cliDir, 'atomic-core/instance.lock'), 'utf8')) as {
      owner_scope: string
    }
    expect([appLock.owner_scope, cliLock.owner_scope]).toEqual(['app', 'cli'])
    expect((await (await control(appDir, app.ready, '/health')).json()) as object).toMatchObject({
      owner_scope: 'app',
    })
    expect((await (await control(cliDir, cli.ready, '/health')).json()) as object).toMatchObject({
      owner_scope: 'cli',
    })
    const cliModels = spawnSync(BIN, ['models', 'list', '--json', '--data-folder', cliDir], {
      encoding: 'utf8',
    })
    expect(cliModels.status, cliModels.stderr).toBe(0)
    expect(JSON.parse(cliModels.stdout)).toEqual([])

    const registered = await control(appDir, app.ready, '/cloud/providers/my-provider', {
      method: 'PUT',
      body: JSON.stringify({ api_key: 'app-only-key', models: ['app-model'] }),
    })
    expect(registered.status).toBe(200)
    expect(readFileSync(join(appDir, 'atomic-core/credentials.json'), 'utf8')).toContain('app-only-key')
    expect(existsSync(join(cliDir, 'atomic-core/credentials.json'))).toBe(false)
    const appServer = await control(appDir, app.ready, '/server/start', {
      method: 'POST',
      body: JSON.stringify({ port: 0, state_file: true }),
    })
    expect(appServer.status).toBe(200)
    expect(existsSync(join(appDir, 'local-api-server.json'))).toBe(true)
    expect(existsSync(join(cliDir, 'local-api-server.json'))).toBe(false)

    expect((await control(appDir, app.ready, '/shutdown', { method: 'POST' })).status).toBe(200)
    await new Promise<void>((resolve) => app.child.once('exit', () => resolve()))
    expect(existsSync(join(appDir, 'atomic-core/instance.lock'))).toBe(false)
    expect((await control(cliDir, cli.ready, '/health')).status).toBe(200)
    expect(existsSync(join(cliDir, 'atomic-core/instance.lock'))).toBe(true)
  })

  it('rejects a CLI data-folder alias of the configured application folder', async () => {
    const appDir = await folder()
    const result = spawnSync(BIN, ['models', 'list', '--data-folder', appDir], {
      encoding: 'utf8',
      env: { ...process.env, ATOMIC_CORE_DATA_FOLDER: appDir },
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('cannot use the Atomic Chat application data folder')
  })

  it('replaces an idle outdated CLI daemon but refuses to interrupt a registered client', async () => {
    const cliDir = await folder()
    const daemon = await startDaemon(cliDir, daemons)
    const lockPath = join(cliDir, 'atomic-core/instance.lock')
    const old = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>
    writeFileSync(lockPath, JSON.stringify({ ...old, version: '0.1.0' }))
    const registered = await control(cliDir, daemon.ready, '/clients', {
      method: 'POST',
      body: JSON.stringify({ name: 'active-agent' }),
    })
    expect(registered.status).toBe(201)
    const client = (await registered.json()) as { client: { id: string } }
    const busy = spawnSync(BIN, ['providers', 'list', '--data-folder', cliDir], { encoding: 'utf8' })
    expect(busy.status).toBe(1)
    expect(busy.stderr).toContain('active clients')
    expect((await control(cliDir, daemon.ready, '/health')).status).toBe(200)
    expect(
      (await control(cliDir, daemon.ready, `/clients/${client.client.id}`, { method: 'DELETE' })).status
    ).toBe(200)
    const upgraded = spawnSync(BIN, ['providers', 'list', '--data-folder', cliDir], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(upgraded.status, upgraded.stderr).toBe(0)
    const next = JSON.parse(readFileSync(lockPath, 'utf8')) as typeof daemon.ready
    expect(next.pid).not.toBe(daemon.ready.pid)
    expect(next.version).toBe(CORE_VERSION)
    expect((await control(cliDir, next, '/health')).status).toBe(200)
    expect((await control(cliDir, next, '/shutdown', { method: 'POST' })).status).toBe(200)
  })
})
