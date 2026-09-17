import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { AtomicCore } from '../core.js'
import { attachToOwner, selfCommand, withAttachedOwner } from './owner.js'

let data: TmpDataFolder
const cores: AtomicCore[] = []

beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-attach-')
})
afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.shutdown()))
  await data.cleanup()
})

async function runningCore(): Promise<AtomicCore> {
  const core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0 })
  cores.push(core)
  return core
}

describe('attachToOwner', () => {
  it('refuses an app-scoped owner even when an explicit CLI path points at its folder', async () => {
    const core = await AtomicCore.create({ dataFolder: data.root, ownerScope: 'app' })
    cores.push(core)
    await expect(
      attachToOwner({ layout: data.layout, clientName: 'cli', launch: true })
    ).rejects.toMatchObject({ code: 'CORE_PROTOCOL_MISMATCH' })
    expect(core.instanceId).toBeTruthy()
  })

  it('does not interrupt active clients of an older daemon', async () => {
    const core = await runningCore()
    const client = await attachToOwner({ layout: data.layout, clientName: 'active-cli' })
    const registration = await client.client.register()
    const old = JSON.parse(await readFile(data.layout.core.instanceLock, 'utf8')) as Record<string, unknown>
    await writeFile(data.layout.core.instanceLock, JSON.stringify({ ...old, version: '0.1.0' }))
    await expect(
      attachToOwner({ layout: data.layout, clientName: 'upgrading-cli', launch: true })
    ).rejects.toMatchObject({ code: 'CORE_ALREADY_RUNNING' })
    expect(await client.client.health()).toMatchObject({ instance_id: core.instanceId })
    await client.client.unregister(registration.client.id)
  })

  it('holds a registration throughout a real CLI operation and releases it afterward', async () => {
    const core = await runningCore()
    let release!: () => void
    let entered!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const command = withAttachedOwner(
      { layout: data.layout, clientName: 'long serve' },
      async (_owner, id) => {
        entered()
        await pending
        return id
      }
    )
    await started
    expect(core.clients.list().map((client) => client.name)).toContain('long serve')
    const old = JSON.parse(await readFile(data.layout.core.instanceLock, 'utf8')) as Record<string, unknown>
    await writeFile(data.layout.core.instanceLock, JSON.stringify({ ...old, version: '0.1.0' }))
    await expect(
      attachToOwner({ layout: data.layout, clientName: 'upgrade', launch: true })
    ).rejects.toMatchObject({ code: 'CORE_ALREADY_RUNNING' })
    release()
    await command
    expect(core.clients.list()).toEqual([])
  })

  it('heartbeats during a long command and tolerates a daemon that dies before unregister', async () => {
    const core = await runningCore()
    const messages: string[] = []
    await withAttachedOwner(
      {
        layout: data.layout,
        clientName: 'long-running-cli',
        heartbeatIntervalMs: 5,
        log: (message) => messages.push(message),
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 25))
        expect(core.clients.list()[0]?.last_seen).toBeGreaterThan(core.clients.list()[0]?.registered_at ?? 0)
        await core.shutdown()
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    )
    expect(messages.some((message) => message.includes('heartbeat failed'))).toBe(true)
  })

  it('times out when an old daemon acknowledges shutdown but never releases its lock', async () => {
    const core = await runningCore()
    const old = JSON.parse(await readFile(data.layout.core.instanceLock, 'utf8')) as Record<string, unknown>
    await writeFile(data.layout.core.instanceLock, JSON.stringify({ ...old, version: '0.1.0' }))
    const { CoreClient } = await import('../client/index.js')
    const shutdown = vi.spyOn(CoreClient.prototype, 'shutdown').mockResolvedValue({ ok: true })
    try {
      await expect(
        attachToOwner({ layout: data.layout, clientName: 'upgrade', launch: true, timeoutMs: 150 })
      ).rejects.toMatchObject({ code: 'CORE_ALREADY_RUNNING' })
      expect(core.instanceId).toBe(old.instance_id)
    } finally {
      shutdown.mockRestore()
    }
  })

  it('requires an explicit upgrade command and refuses an old lock that names another instance', async () => {
    const core = await runningCore()
    const old = JSON.parse(await readFile(data.layout.core.instanceLock, 'utf8')) as Record<string, unknown>
    await writeFile(data.layout.core.instanceLock, JSON.stringify({ ...old, version: '0.1.0' }))
    await expect(attachToOwner({ layout: data.layout, clientName: 'read-only' })).rejects.toMatchObject({
      code: 'CORE_PROTOCOL_MISMATCH',
    })
    await writeFile(
      data.layout.core.instanceLock,
      JSON.stringify({ ...old, version: '0.1.0', instance_id: 'other' })
    )
    await expect(
      attachToOwner({ layout: data.layout, clientName: 'upgrade', launch: true })
    ).rejects.toMatchObject({ code: 'CORE_PROTOCOL_MISMATCH' })
    expect(core.instanceId).toBe(old.instance_id)
  })

  it('shuts down an idle old daemon before attempting to launch the pinned binary', async () => {
    const core = await runningCore()
    const old = JSON.parse(await readFile(data.layout.core.instanceLock, 'utf8')) as Record<string, unknown>
    await writeFile(data.layout.core.instanceLock, JSON.stringify({ ...old, version: '0.1.0' }))
    await expect(
      attachToOwner({
        layout: data.layout,
        clientName: 'upgrade',
        launch: true,
        selfCommand: ['/definitely/missing/atomic-chat-core'],
        timeoutMs: 2000,
      })
    ).rejects.toMatchObject({ code: 'CORE_START_FAILED' })
    await core.stopped
    expect(await readFile(data.layout.core.instanceLock, 'utf8').catch(() => undefined)).toBeUndefined()
  })

  it('attaches to a core that already owns the folder', async () => {
    const core = await runningCore()
    const owner = await attachToOwner({ layout: data.layout, clientName: 'test' })
    expect(owner.launched).toBe(false)
    expect(owner.record.control_port).toBe(core.control.port)
    expect(await owner.client.health()).toMatchObject({ ok: true, instance_id: core.instanceId })
  })

  it('refuses to guess when no core is running and launching was not asked for', async () => {
    await expect(attachToOwner({ layout: data.layout, clientName: 'test' })).rejects.toMatchObject({
      code: 'CORE_NOT_RUNNING',
      details: data.root,
    })
  })

  it('does not attach to a lock whose owner never published a port', async () => {
    await writeFile(
      data.layout.core.instanceLock,
      JSON.stringify({
        instance_id: 'starting-owner',
        pid: process.pid,
        process_start_id: null,
        protocol: 1,
        version: '0.1.0',
        data_folder: data.root,
        control_host: '',
        control_port: 0,
        state: 'starting',
        acquired_at: new Date().toISOString(),
      })
    )
    await expect(attachToOwner({ layout: data.layout, clientName: 'test' })).rejects.toMatchObject({
      code: 'CORE_NOT_RUNNING',
    })
  })

  it('waits for an owner that holds the lock but is still publishing control', async () => {
    const core = await runningCore()
    const ready = JSON.parse(await readFile(data.layout.core.instanceLock, 'utf8')) as Record<string, unknown>
    await writeFile(
      data.layout.core.instanceLock,
      JSON.stringify({ ...ready, state: 'starting', control_host: '', control_port: 0 })
    )
    const attached = attachToOwner({
      layout: data.layout,
      clientName: 'waiting-client',
      launch: true,
      timeoutMs: 2000,
    })
    setTimeout(() => void writeFile(data.layout.core.instanceLock, JSON.stringify(ready)), 30)
    const owner = await attached
    expect(owner.launched).toBe(false)
    expect(owner.record.instance_id).toBe(core.instanceId)
  })

  it('reports a launcher that dies instead of waiting for a core that will never come', async () => {
    await expect(
      attachToOwner({
        layout: data.layout,
        clientName: 'test',
        launch: true,
        selfCommand: [process.execPath, '-e', 'process.stderr.write("boom\\n"); process.exit(3)'],
        timeoutMs: 5000,
      })
    ).rejects.toMatchObject({
      code: 'CORE_START_FAILED',
      details: expect.stringContaining('boom') as unknown as string,
    })
  })

  it('reports an executable that cannot be spawned', async () => {
    await expect(
      attachToOwner({
        layout: data.layout,
        clientName: 'test',
        launch: true,
        selfCommand: ['/definitely/missing/atomic-chat-core'],
        timeoutMs: 1000,
      })
    ).rejects.toMatchObject({ code: 'CORE_START_FAILED' })
  })

  it('attaches to the winning owner when its own launcher exits after losing the race', async () => {
    const core = await runningCore()
    const ready = await readFile(data.layout.core.instanceLock, 'utf8')
    await rm(data.layout.core.instanceLock)
    const script = `require('node:fs').writeFileSync(${JSON.stringify(
      data.layout.core.instanceLock
    )}, ${JSON.stringify(ready)}); process.exit(3)`
    const owner = await attachToOwner({
      layout: data.layout,
      clientName: 'race-loser',
      launch: true,
      selfCommand: [process.execPath, '-e', script],
      timeoutMs: 2000,
    })
    expect(owner.record.instance_id).toBe(core.instanceId)
    expect(owner.launched).toBe(false)
  })

  it('finishes a successful launcher handshake and detaches its output streams', async () => {
    const core = await runningCore()
    const ready = await readFile(data.layout.core.instanceLock, 'utf8')
    await rm(data.layout.core.instanceLock)
    const script = `require('node:fs').writeFileSync(${JSON.stringify(
      data.layout.core.instanceLock
    )}, ${JSON.stringify(ready)}); setTimeout(() => {}, 3000)`
    const owner = await attachToOwner({
      layout: data.layout,
      clientName: 'launched-client',
      launch: true,
      selfCommand: [process.execPath, '-e', script],
      timeoutMs: 2000,
    })
    expect(owner.launched).toBe(false)
    expect(owner.record.instance_id).toBe(core.instanceId)
  })

  it('gives up when the launched process never publishes anything', async () => {
    await expect(
      attachToOwner({
        layout: data.layout,
        clientName: 'test',
        launch: true,
        selfCommand: [process.execPath, '-e', 'setTimeout(() => {}, 10_000)'],
        timeoutMs: 300,
      })
    ).rejects.toMatchObject({ code: 'CORE_START_FAILED' })
  })
})

describe('selfCommand', () => {
  it('re-runs a script through its interpreter', () => {
    expect(selfCommand(['/usr/bin/node', '/app/dist/cli/bin.js', 'serve'], '/usr/bin/node')).toEqual([
      '/usr/bin/node',
      '/app/dist/cli/bin.js',
    ])
    expect(selfCommand(['/usr/bin/node', '/app/src/cli/bin.ts'], '/usr/bin/node')).toEqual([
      '/usr/bin/node',
      '/app/src/cli/bin.ts',
    ])
  })

  it('uses the executable itself for a compiled binary, never argv[0]', () => {
    // A Bun single-file executable reports argv[0] as the bare string "bun"; spawning that looks for
    // a `bun` on PATH and fails with `Script not found "daemon"`.
    expect(selfCommand(['bun', 'serve', 'demo'], '/usr/local/bin/atomic-chat-core')).toEqual([
      '/usr/local/bin/atomic-chat-core',
    ])
    expect(selfCommand(['/usr/local/bin/atomic-chat-core'], '/usr/local/bin/atomic-chat-core')).toEqual([
      '/usr/local/bin/atomic-chat-core',
    ])
  })
})
