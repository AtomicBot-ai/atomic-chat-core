import { mkdir, mkdtemp, readdir, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dataLayout } from '../config/index.js'
import { createManagedContainersHandle } from '../runtime/container/index.js'
import { realLinuxHost } from '../runtime/environment/index.js'
import { engineModelsDir, linuxProvisionerParts, wireManagedEnvironment } from './managed-environment.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'managed-env-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const options = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform = 'darwin') => ({
  env: { ATOMIC_CORE_MANAGED_ROOT: join(dir, 'shared'), ...env },
  platform,
  layout: dataLayout(join(dir, 'data')),
  instanceId: 'core-1',
  emit: () => undefined,
  newId: () => 'id',
  log: () => undefined,
})

describe('wireManagedEnvironment', () => {
  it('offers no environment off Linux, and wires no Docker executor there', async () => {
    const { managed, containers } = wireManagedEnvironment(options({}))
    expect(managed.environments()).toEqual([])
    expect(await containers.resolve()).toBeNull()
  })

  it('offers a Linux environment with the recipe, ready to be set up', async () => {
    const { managed } = wireManagedEnvironment({ ...options({}, 'linux'), dockerPath: null })
    expect(managed.environments()[0]?.executor).toBe('linux-docker')
    expect(managed.environments()[0]?.availability).toBe('setup-required')
    await managed.shutdown(AbortSignal.timeout(1_000))
  })

  it('drives a test machine folder on any platform, with its docker binary and socket', async () => {
    const host = join(dir, 'host')
    await mkdir(join(host, 'bin'), { recursive: true })
    await writeFile(join(host, 'bin', 'docker'), '#!/bin/sh\nexit 1\n')
    await chmod(join(host, 'bin', 'docker'), 0o755)
    const { managed, containers } = wireManagedEnvironment(options({ ATOMIC_MANAGED_TEST_HOST: host }))
    expect(managed.environments()[0]?.executor).toBe('linux-docker')
    const wired = await containers.resolve()
    expect(wired?.dockerPath).toBe(join(host, 'bin', 'docker'))
    expect(wired?.socketPath).toBe(join(host, 'docker.sock'))
    await managed.shutdown(AbortSignal.timeout(1_000))
  })
})

describe('engineModelsDir', () => {
  it('is the engine’s models folder in this scope, and refuses anything that could climb out', async () => {
    const layout = dataLayout(join(dir, 'data'))
    expect(engineModelsDir(layout, 'tensorrt-llm')).toBe(join(dir, 'data', 'tensorrt-llm', 'models'))
    expect(() => engineModelsDir(layout, '..')).toThrow()
    expect(() => engineModelsDir(layout, 'a/b')).toThrow()
    expect(() => engineModelsDir(layout, 'x..y')).toThrow()
    expect(await readdir(dir)).not.toContain('tensorrt-llm')
  })
})

describe('linuxProvisionerParts', () => {
  it('hands the provisioner this core’s one executor, and removes only this scope’s caches and models', async () => {
    const layout = dataLayout(join(dir, 'data'))
    const docker = join(dir, 'docker')
    await writeFile(docker, '#!/bin/sh\nexit 1\n')
    await chmod(docker, 0o755)
    const containers = createManagedContainersHandle({
      platform: 'linux',
      layout,
      instanceId: 'core-1',
      log: () => undefined,
      dockerPath: docker,
    })
    const parts = linuxProvisionerParts({ layout }, realLinuxHost({}), containers)
    const wired = await parts.docker()
    expect(wired?.socketPath).toBe('/var/run/docker.sock')
    expect(containers.current()?.exec).toBe(wired?.exec)
    expect((await parts.unloadEngineSessions?.('tensorrt-llm'))?.unloaded).toBe(0)

    const cache = join(layout.managed.cachesDir, 'd-1', 'model')
    const other = join(layout.managed.cachesDir, 'd-2', 'model')
    const models = join(layout.root, 'tensorrt-llm', 'models', 'm')
    await Promise.all([
      mkdir(cache, { recursive: true }),
      mkdir(other, { recursive: true }),
      mkdir(models, { recursive: true }),
    ])
    await parts.removeEngineCaches('d-1')
    await parts.removeModels('tensorrt-llm')
    expect(await readdir(layout.managed.cachesDir)).toEqual(['d-2'])
    expect(await readdir(join(layout.root, 'tensorrt-llm'))).toEqual([])

    const none = linuxProvisionerParts(
      { layout },
      realLinuxHost({}),
      createManagedContainersHandle({
        platform: 'darwin',
        layout,
        instanceId: 'core-1',
        log: () => undefined,
      })
    )
    expect(await none.docker()).toBeNull()
  })
})
