import { mkdir, mkdtemp, readdir, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dataLayout } from '../config/index.js'
import { createManagedContainersHandle } from '../runtime/container/index.js'
import { realLinuxHost } from '../runtime/environment/index.js'
import {
  engineModelsDir,
  linuxProvisionerParts,
  testGuestRecipe,
  windowsProvisionerParts,
  wireManagedEnvironment,
} from './managed-environment.js'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fakeWindows } from '../../test/helpers/fake-windows-host.js'
import { directoryGuestMount } from '../runtime/wsl/index.js'
import { skipTestOnWindows } from '../../test/helpers/platform.js'

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
    const { managed, containers, platform } = wireManagedEnvironment(options({}))
    expect(platform).toBe('darwin')
    expect(managed.environments()).toEqual([])
    expect(await containers.resolve()).toBeNull()
  })

  it('offers a Linux environment with the recipe, ready to be set up', async () => {
    const { managed } = wireManagedEnvironment({ ...options({}, 'linux'), dockerPath: null })
    expect(managed.environments()[0]?.executor).toBe('linux-docker')
    expect(managed.environments()[0]?.availability).toBe('setup-required')
    await managed.shutdown(AbortSignal.timeout(1_000))
  })

  it('drives a test machine folder on any platform, with its docker binary and socket', async (ctx) => {
    skipTestOnWindows(ctx, 'the fake docker is a shebang script, which Windows cannot execute')
    const host = join(dir, 'host')
    await mkdir(join(host, 'bin'), { recursive: true })
    await writeFile(join(host, 'bin', 'docker'), '#!/bin/sh\nexit 1\n')
    await chmod(join(host, 'bin', 'docker'), 0o755)
    const {
      managed,
      containers,
      platform,
      host: machine,
    } = wireManagedEnvironment(options({ ATOMIC_MANAGED_TEST_HOST: host }))
    expect(managed.environments()[0]?.executor).toBe('linux-docker')
    // The one place the hook is read: the tensorrt-llm provider gets Linux and this same machine.
    expect(platform).toBe('linux')
    expect(machine.dockerPath).toBe(join(host, 'bin', 'docker'))
    expect((await machine.probeDeps.exec('docker', ['info'])).code).toBe(1)
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

describe('wireManagedEnvironment on Windows (change add-tensorrt-llm-windows, task 2.10)', () => {
  /** A Windows test machine folder with no WSL yet (`ATOMIC_MANAGED_TEST_WINDOWS`). */
  const testWindows = async (): Promise<string> => {
    const machine = join(dir, 'windows')
    await mkdir(join(machine, 'wsl'), { recursive: true })
    await writeFile(
      join(machine, 'windows.json'),
      JSON.stringify({
        machine: 'x86_64',
        release: '10.0.22631',
        elevated: false,
        virtualization: { firmware: true, hypervisor: false },
        nvidia: {
          driver: '591.44',
          gpus: [{ uuid: 'GPU-1', name: 'NVIDIA RTX 4070', cc: '8.9', total_mib: 12282, free_mib: 11000 }],
        },
        wslconfig: null,
        volume_free_bytes: 500_000_000_000,
        vhdx_bytes: null,
      })
    )
    await writeFile(
      join(machine, 'wsl', 'state.json'),
      JSON.stringify({ installed: false, distributions: [], guests: {} })
    )
    await writeFile(
      join(machine, 'wsl-command.json'),
      JSON.stringify([
        process.execPath,
        join(process.cwd(), 'test/helpers/fake-wsl.mjs'),
        join(machine, 'wsl'),
      ])
    )
    return machine
  }

  it('offers the WSL environment with its recipe, no executor before the distribution, and the provider’s WSL context', async () => {
    const machine = await testWindows()
    const wired = wireManagedEnvironment(
      options({
        ATOMIC_MANAGED_TEST_WINDOWS: machine,
        // Nothing reaches the network: neither conf document is there.
        ATOMIC_ENVIRONMENT_MANIFEST_URL: `file://${join(dir, 'none.json')}`,
        ATOMIC_RUNTIME_DESCRIPTOR_URL: `file://${join(dir, 'none.json')}`,
      })
    )
    expect(wired.platform).toBe('win32')
    expect(wired.arch).toBe('x64')
    expect(wired.managed.environments()[0]?.executor).toBe('wsl-docker')
    // Nothing is offered on Windows before a probe has seen the machine (D14).
    expect(wired.managed.environments()[0]?.availability).toBe('unsupported')
    expect(await wired.containers.resolve()).toBeNull()
    expect(wired.windows).toBeDefined()
    expect(await wired.windows?.records.read()).toBeNull()
    const plan = await wired.managed.service.probe({
      descriptor_id: 'none',
      target: { kind: 'environment' },
    })
    // No manifest is served in this test: Windows without one and without a distribution is unsupported.
    expect(plan.availability).toBe('unsupported')
    await wired.managed.shutdown(AbortSignal.timeout(1_000))
  })
})

describe('windowsProvisionerParts', () => {
  const RECORD = {
    schema_version: 1 as const,
    executor: 'wsl-docker' as const,
    distribution: { name: 'AtomicChat', path: 'C:\\AtomicChat' },
    manifest_id: 'windows-r1',
    imported_at: '2026-10-01T00:00:00.000Z',
    marker: 'marker-0001',
  }
  const machine = () =>
    fakeWindows({
      wsl: {
        installed: true,
        ready: true,
        distributions: [{ name: 'AtomicChat', state: 'Running', version: 2, is_default: false }],
        guests: { AtomicChat: { files: {}, host: {} } },
      },
      machine: 'x86_64',
      release: '10.0.22631',
      elevated: false,
      virtualization: { firmware: true, hypervisor: true },
      nvidia: null,
      wslconfig: null,
      volume_free_bytes: null,
      vhdx_bytes: null,
    })
  const journal = { list: () => [{ container_id: 'c1' }], remove: async (id: string) => removed.push(id) }
  let removed: string[] = []
  const parts = (record: typeof RECORD | null, test = false) => {
    removed = []
    const windows = machine()
    return {
      windows,
      parts: windowsProvisionerParts({
        layout: dataLayout(join(dir, 'data')),
        fetch: (async () => new Response('rootfs bytes')) as typeof fetch,
        unloadEngineSessions: async () => ({ unloaded: 0 }),
        host: windows.host,
        records: { read: async () => record, write: async () => undefined, remove: async () => undefined },
        containers: { current: () => ({ journal }) as never },
        mount: directoryGuestMount(join(dir, 'guest-fs')),
        keeper: {
          acquire: () => ({ release: () => undefined }),
          held: () => false,
          onStopped: () => () => undefined,
        },
        scopeKey: async () => 'k1',
        test,
      }),
    }
  }

  it('removes this scope’s caches of a descriptor and its models of an engine with the guest’s rm, and nothing before the import', async () => {
    const { windows, parts: imported } = parts(RECORD)
    await imported.removeEngineCaches('trt-r1')
    await imported.removeModels('tensorrt-llm')
    const rms = windows.wslCalls.filter((argv) => argv.includes('rm'))
    expect(rms.map((argv) => argv[argv.length - 1])).toEqual([
      '/var/lib/atomic-chat/scopes/k1/caches/trt-r1',
      '/var/lib/atomic-chat/scopes/k1/models/tensorrt-llm',
    ])
    await expect(imported.removeModels('../etc')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    const { windows: none, parts: before } = parts(null)
    await before.removeEngineCaches('trt-r1')
    await before.removeModels('tensorrt-llm')
    expect(none.wslCalls).toEqual([])
  })

  it('reads and trims the journal of the one executor, downloads and deletes the rootfs file', async () => {
    const { parts: p } = parts(RECORD)
    expect(p.journal.list()).toEqual([{ container_id: 'c1' }])
    await p.journal.remove('c1')
    expect(removed).toEqual(['c1'])
    const destination = join(dir, 'rootfs.wsl')
    const sha = createHash('sha256').update('rootfs bytes').digest('hex')
    await p.downloadRootfs(
      {
        url: 'https://example.test/r.wsl',
        sha256: sha,
        distribution: { id: 'ubuntu', version_id: '24.04', arch: 'x86_64' },
      },
      destination,
      new AbortController().signal
    )
    expect(existsSync(destination)).toBe(true)
    await p.removeFile(destination)
    expect(existsSync(destination)).toBe(false)
  })

  it('the test machine’s guest recipe is applied by the fake in one command', async () => {
    const { windows, parts: p } = parts(RECORD, true)
    const answer = await p.runGuestRecipe(
      windows.wsl.distribution('AtomicChat'),
      {
        recipe_id: 'linux.install-container-runtime',
        recipe_digest: `sha256:${'a'.repeat(64)}`,
        parameters: {
          user: 'root',
          arch: 'x86_64',
          family: 'apt',
          distro_id: 'ubuntu',
          version_id: '24.04',
          components: ['docker-engine'],
        },
        parameters_digest: `sha256:${'b'.repeat(64)}`,
      },
      new AbortController().signal
    )
    expect(answer.outcome).toBe('completed')
    expect(windows.wslCalls.at(-1)).toContain('atomic-test-recipe')
  })
})

describe('wireManagedEnvironment on a real Windows (no test hook)', () => {
  it('reaches the system WSL through %SystemRoot%, and keeps this scope’s key with its data', async () => {
    const wired = wireManagedEnvironment({
      ...options({ SystemRoot: 'C:\\Windows', LOCALAPPDATA: join(dir, 'local') }, 'win32'),
    })
    expect(wired.platform).toBe('win32')
    expect(wired.arch).toBe(process.arch)
    expect(wired.windows?.mount).toBeUndefined()
    expect(wired.windows?.host.localAppData).toBe(join(dir, 'local'))
    const key = await wired.windows?.scopeKey()
    expect(await wired.windows?.scopeKey()).toBe(key)
    expect(await wired.containers.resolve()).toBeNull()
    await wired.managed.shutdown(AbortSignal.timeout(1_000))
  })

  it('a guest recipe the test machine could not apply is a failed one', async () => {
    const transport = {
      name: 'AtomicChat',
      exec: async () => ({ code: 1, stdout: '', stderr: 'no' }),
      hold: () => {
        throw new Error('no hold')
      },
    }
    const answer = await testGuestRecipe(
      transport,
      {
        recipe_id: 'linux.install-container-runtime',
        recipe_digest: `sha256:${'a'.repeat(64)}`,
        parameters: {
          user: 'root',
          arch: 'x86_64',
          family: 'apt',
          distro_id: 'ubuntu',
          version_id: '24.04',
          components: [],
        },
        parameters_digest: `sha256:${'b'.repeat(64)}`,
      },
      new AbortController().signal
    )
    expect(answer).toEqual({ outcome: 'failed', log_tail: 'no' })
  })
})

describe('wireManagedEnvironment on Windows: once Atomic Chat’s distribution is recorded', () => {
  it('wires the one executor through its guest, with the owner’s fetch and warnings', async () => {
    const machine = join(dir, 'windows-imported')
    await mkdir(join(machine, 'wsl'), { recursive: true })
    await writeFile(
      join(machine, 'windows.json'),
      JSON.stringify({
        machine: 'x86_64',
        release: '10.0.22631',
        elevated: false,
        virtualization: { firmware: true, hypervisor: true },
        nvidia: null,
        wslconfig: null,
        volume_free_bytes: 1,
        vhdx_bytes: 1,
      })
    )
    await writeFile(
      join(machine, 'wsl', 'state.json'),
      JSON.stringify({
        installed: true,
        ready: true,
        distributions: [{ name: 'AtomicChat', state: 'Running', version: 2, is_default: false }],
        guests: { AtomicChat: { files: {}, host: {} } },
      })
    )
    await writeFile(
      join(machine, 'wsl-command.json'),
      JSON.stringify([
        process.execPath,
        join(process.cwd(), 'test/helpers/fake-wsl.mjs'),
        join(machine, 'wsl'),
      ])
    )
    await mkdir(join(dir, 'shared'), { recursive: true })
    await writeFile(
      join(dir, 'shared', 'environment.json'),
      JSON.stringify({
        schema_version: 1,
        executor: 'wsl-docker',
        distribution: { name: 'AtomicChat', path: 'C:\\AtomicChat' },
        manifest_id: 'windows-r1',
        imported_at: '2026-10-01T00:00:00.000Z',
        marker: 'marker-0001',
      })
    )
    const warnings: string[] = []
    const wired = wireManagedEnvironment({
      ...options({ ATOMIC_MANAGED_TEST_WINDOWS: machine }),
      fetch: (async () => new Response('', { status: 404 })) as typeof fetch,
      onWarn: (message) => warnings.push(message),
    })
    const containers = await wired.containers.resolve()
    expect(containers?.dockerPath).toBe('/usr/bin/docker')
    await wired.managed.shutdown(AbortSignal.timeout(1_000))
  })

  it('reads an empty journal while the executor is not wired yet', () => {
    const parts = windowsProvisionerParts({
      layout: dataLayout(join(dir, 'data')),
      fetch,
      unloadEngineSessions: async () => ({ unloaded: 0 }),
      host: fakeWindows({
        wsl: { installed: true, ready: true, distributions: [], guests: {} },
        machine: 'x86_64',
        release: '10.0.22631',
        elevated: false,
        virtualization: { firmware: true, hypervisor: true },
        nvidia: null,
        wslconfig: null,
        volume_free_bytes: null,
        vhdx_bytes: null,
      }).host,
      records: { read: async () => null, write: async () => undefined, remove: async () => undefined },
      containers: { current: () => null },
      mount: directoryGuestMount(join(dir, 'guest-fs')),
      keeper: {
        acquire: () => ({ release: () => undefined }),
        held: () => false,
        onStopped: () => () => undefined,
      },
      scopeKey: async () => 'k1',
      test: false,
    })
    expect(parts.journal.list()).toEqual([])
  })
})
