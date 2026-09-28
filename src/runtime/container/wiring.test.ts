import { existsSync } from 'node:fs'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { ExecutionJournal } from './execution-journal.js'
import { wireManagedContainers } from './wiring.js'

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

  it("reconciles a previous instance's journalled container through the absolute binary and the core-owned DOCKER_CONFIG", async () => {
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
})
