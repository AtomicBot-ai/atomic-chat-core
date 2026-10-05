import { existsSync } from 'node:fs'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { ExecutionJournal } from './execution-journal.js'
import { createManagedContainersHandle, wireManagedContainers } from './wiring.js'
import { skipTestOnWindows } from '../../../test/helpers/platform.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('container-wiring-')
})
afterEach(async () => {
  await data.cleanup()
})

/**
 * A fake `docker` executable: records every argv line, and knows no container at all — so reconcile
 * reads each journalled orphan as already gone.
 */
async function fakeDocker(): Promise<{ path: string; calls: () => Promise<string[]> }> {
  const path = join(data.root, 'fake-docker')
  const log = join(data.root, 'fake-docker.log')
  await writeFile(
    path,
    [
      '#!/bin/sh',
      `echo "DOCKER_CONFIG=$DOCKER_CONFIG $*" >> '${log}'`,
      'echo "Error response from daemon: No such container: $5" >&2',
      'exit 1',
      '',
    ].join('\n')
  )
  await chmod(path, 0o755)
  return {
    path,
    calls: async () => (existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n') : []),
  }
}

const orphan = {
  container_id: 'orphan0123',
  engine_id: 'tensorrt-llm',
  image_digest: `sha256:${'c'.repeat(64)}`,
  scope: 'app',
  instance_id: 'previous-core',
  created_at: '2026-09-28T00:00:00.000Z',
}

describe('wireManagedContainers', () => {
  it('constructs nothing off Linux', async () => {
    const docker = await fakeDocker()
    expect(
      await wireManagedContainers({
        platform: 'darwin',
        layout: data.layout,
        instanceId: 'core-1',
        log: () => {},
        dockerPath: docker.path,
      })
    ).toBeNull()
    expect(await docker.calls()).toEqual([])
  })

  it('constructs nothing on Linux without a docker binary', async () => {
    expect(
      await wireManagedContainers({
        platform: 'linux',
        layout: data.layout,
        instanceId: 'core-1',
        log: () => {},
        dockerPath: null,
      })
    ).toBeNull()
  })

  it("reconciles a previous instance's journalled container through the absolute binary and the core-owned DOCKER_CONFIG", async (ctx) => {
    skipTestOnWindows(ctx, 'the fake docker is a shebang script, which Windows cannot execute')
    const seeded = await ExecutionJournal.open(data.layout)
    await seeded.add(orphan)
    const docker = await fakeDocker()

    const wired = await wireManagedContainers({
      platform: 'linux',
      layout: data.layout,
      instanceId: 'core-1',
      log: () => {},
      dockerPath: docker.path,
    })

    expect(wired?.dockerPath).toBe(docker.path)
    expect(wired?.reconciled.absent.map((r) => r.container_id)).toEqual(['orphan0123'])
    expect(wired?.journal.list()).toEqual([])
    const calls = await docker.calls()
    expect(calls).toEqual([
      `DOCKER_CONFIG=${data.layout.managed.dockerConfigDir} --host unix:///var/run/docker.sock container inspect orphan0123`,
    ])
    expect(await readFile(join(data.layout.managed.dockerConfigDir, 'config.json'), 'utf8')).toBe('{}\n')
  })

  it('bounds each startup reconcile call and the whole pass, so a hung daemon cannot hold startup (review 2.12 round 1)', async (ctx) => {
    skipTestOnWindows(ctx, 'the fake docker is a shebang script, which Windows cannot execute')
    const seeded = await ExecutionJournal.open(data.layout)
    await seeded.add(orphan)
    await seeded.add({ ...orphan, container_id: 'orphan0456' })
    const hung = join(data.root, 'hung-docker')
    await writeFile(hung, '#!/bin/sh\nsleep 5\n')
    await chmod(hung, 0o755)

    const started = Date.now()
    const wired = await wireManagedContainers({
      platform: 'linux',
      layout: data.layout,
      instanceId: 'core-1',
      log: () => {},
      dockerPath: hung,
      reconcileCallTimeoutMs: 200,
      reconcileBudgetMs: 100,
    })
    expect(Date.now() - started).toBeLessThan(2_000)
    // The first record's inspect timed out (unanswered → left alone); the budget then skipped the second.
    expect(wired?.reconciled.failed.map((r) => r.container_id)).toEqual(['orphan0123'])
    expect(wired?.reconciled.skipped.map((r) => r.container_id)).toEqual(['orphan0456'])
    expect(wired?.journal.list()).toHaveLength(2)
  })
})

describe('createManagedContainersHandle (task 2.6)', () => {
  const options = () => ({
    platform: 'linux' as const,
    layout: data.layout,
    instanceId: 'core-1',
    log: () => {},
  })

  it('wires once, and hands every later caller the same executor', async () => {
    const docker = await fakeDocker()
    const handle = createManagedContainersHandle({ ...options(), dockerPath: docker.path })
    expect(handle.current()).toBeNull()
    const [one, two] = await Promise.all([handle.resolve(), handle.resolve()])
    expect(one).not.toBeNull()
    expect(two).toBe(one)
    expect(await handle.resolve()).toBe(one)
    expect(handle.current()).toBe(one)
    expect(one?.socketPath).toBe('/var/run/docker.sock')
  })

  it('tries again after a start with no docker CLI, since the setup may have installed one', async () => {
    let calls = 0
    const docker = await fakeDocker()
    const handle = createManagedContainersHandle({ ...options(), dockerPath: docker.path }, async (wired) => {
      calls += 1
      return calls === 1 ? null : wireManagedContainers(wired)
    })
    expect(await handle.resolve()).toBeNull()
    const later = await handle.resolve()
    expect(later).not.toBeNull()
    expect(calls).toBe(2)
    expect(await handle.resolve()).toBe(later)
  })

  it('carries a test socket through to the executor it wires', async () => {
    const docker = await fakeDocker()
    const handle = createManagedContainersHandle({
      ...options(),
      dockerPath: docker.path,
      dockerSocketPath: '/tmp/fake-engine.sock',
    })
    expect((await handle.resolve())?.socketPath).toBe('/tmp/fake-engine.sock')
  })
})

describe('wireManagedContainers on Windows (change add-tensorrt-llm-windows, task 2.10)', () => {
  const transport = (calls: string[][]) => ({
    name: 'AtomicChat',
    exec: async (argv: string[]) => {
      calls.push(argv)
      // `docker inspect` of an orphan: gone already.
      return { code: 1, stdout: '[]', stderr: 'Error: No such container: orphan0123' }
    },
    hold: () => {
      throw new Error('no hold')
    },
  })

  it('nothing before Atomic Chat’s distribution exists', async () => {
    expect(
      await wireManagedContainers({
        platform: 'win32',
        layout: data.layout,
        instanceId: 'core-1',
        log: () => {},
        guest: async () => null,
      })
    ).toBeNull()
  })

  it('the guest’s docker as root through WSL, the journal on Windows, reconciled through the guest', async () => {
    const journal = await ExecutionJournal.open(data.layout)
    await journal.add(orphan)
    const calls: string[][] = []
    const wired = await wireManagedContainers({
      platform: 'win32',
      layout: data.layout,
      instanceId: 'core-1',
      log: () => {},
      guest: async () => transport(calls),
    })
    expect(wired?.dockerPath).toBe('/usr/bin/docker')
    expect(calls[0]?.[0]).toBe('/usr/bin/docker')
    expect(calls.some((argv) => argv.includes('orphan0123'))).toBe(true)
    expect(wired?.journal.list()).toEqual([])
  })
})

describe('wireManagedContainers on Windows: a running orphan', () => {
  it('stops and removes it through the guest, with the stop’s own deadline', async () => {
    const journal = await ExecutionJournal.open(data.layout)
    await journal.add(orphan)
    const calls: { argv: string[]; timeoutMs: number | undefined }[] = []
    const wired = await wireManagedContainers({
      platform: 'win32',
      layout: data.layout,
      instanceId: 'core-1',
      log: () => {},
      guest: async () => ({
        name: 'AtomicChat',
        exec: async (argv: string[], options?: { timeoutMs?: number }) => {
          calls.push({ argv, timeoutMs: options?.timeoutMs })
          if (argv.includes('inspect')) {
            return {
              code: 0,
              stdout: JSON.stringify([{ Id: 'orphan0123', State: { Running: true, Status: 'running' } }]),
              stderr: '',
            }
          }
          return { code: 0, stdout: 'orphan0123\n', stderr: '' }
        },
        hold: () => {
          throw new Error('no hold')
        },
      }),
    })
    expect(calls.some((call) => call.argv.includes('stop'))).toBe(true)
    expect(calls.every((call) => call.timeoutMs !== undefined)).toBe(true)
    expect(wired?.journal.list()).toEqual([])
  })
})
