/**
 * Composition of the managed container environment (task 2.6): the pieces `wireManagedRuntimes`
 * needs from outside its own module — the Linux machine, the privileged recipe from `src/host`,
 * the one Docker executor of this core, this scope's engine caches and models — put together once
 * for `create.ts`.
 *
 * The Docker executor is the startup handle (`createManagedContainersHandle`): core startup resolves
 * it before recovery runs (so a recovered pull has it), the setup uses it, and the managed-text
 * provider (task 2.14) must take the same handle rather than wire a second one.
 *
 * `unloadEngineSessions` is the `tensorrt-llm` provider's (`tensorrtLlmSessionUnloader`, task 2.14):
 * a removal unloads a loaded session of the engine first, with its container's stop confirmed. Left
 * out, the default (`NOTHING_LOADED`) says nothing is loaded.
 *
 * `ATOMIC_MANAGED_TEST_HOST` (see `linux-host.ts`) swaps the whole Linux machine for a folder the
 * e2e suite describes, including on a non-Linux test runner; production never sets it. This is the
 * one place it is read: the returned `platform` and `host` carry it to the `tensorrt-llm` provider.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { managedSharedPaths, managedSharedRoot, nodeDataFolderEnv } from '../config/index.js'
import type { DataLayout } from '../config/index.js'
import type { CoreEvents } from '../contracts/index.js'
import { AtomicCoreError } from '../contracts/index.js'
import {
  createGuestRecipeRunner,
  ENABLE_WSL_BINDING,
  INSTALL_CONTAINER_RUNTIME_BINDING,
} from '../host/recipes/index.js'
import { createManagedContainersHandle } from '../runtime/container/index.js'
import type { ManagedContainersHandle, ReconcileLogger } from '../runtime/container/index.js'
import {
  ATOMIC_CHAT_DISTRIBUTION,
  downloadVerifiedRootfs,
  managedTestHostDir,
  managedTestWindowsDir,
  NOTHING_LOADED,
  realLinuxHost,
  realWindowsHost,
  testLinuxHost,
  testWindowsHost,
  WindowsEnvironmentRecordStore,
  wireManagedRuntimes,
} from '../runtime/environment/index.js'
import type {
  GuestRecipeRunner,
  LinuxHost,
  LinuxProvisionerParts,
  ManagedRuntimes,
  UnloadEngineSessions,
  WindowsHost,
  WindowsProvisionerParts,
} from '../runtime/environment/index.js'
import { removeEngineCaches } from '../runtime/managed-text/index.js'
import { guestModelFiles } from '../runtime/managed-models/index.js'
import {
  createDistributionKeeper,
  directoryGuestMount,
  guestScopePaths,
  guestScopeRoot,
  guestScopeKeyReader,
  WSL_LOCALHOST_MOUNT,
  type DistributionKeeper,
  type GuestMount,
} from '../runtime/wsl/index.js'
import type { DescriptorSource } from '../runtime/environment/index.js'
import type { WindowsManagedContext } from './managed-engines.js'

export interface WireManagedEnvironmentOptions {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  layout: DataLayout
  instanceId: string
  emit: <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) => void
  newId: () => string
  log: ReconcileLogger
  onWarn?: (message: string) => void
  fetch?: typeof fetch
  /** The managed engine registry's descriptor sources (change `add-vllm-runtime`, D2); TensorRT-LLM alone when omitted. */
  engines?: readonly DescriptorSource[]
  /** `AtomicCoreOptions.dockerPath`: the docker CLI, or null for none. Omitted: the system directories. */
  dockerPath?: string | null
  unloadEngineSessions?: UnloadEngineSessions
}

export interface ManagedEnvironment {
  managed: ManagedRuntimes
  /** The one Docker executor of this core; `resolve()` it at startup, before `managed.recover()`. */
  containers: ManagedContainersHandle
  /** The platform the managed runtime runs on: `linux` on the test host, whatever the real one is. */
  platform: NodeJS.Platform
  /** The machine the environment probes; the `tensorrt-llm` provider asks it for its cards too. */
  host: LinuxHost
  /** `process.arch`, or `x64` on the Windows test machine (which stands in for a Windows x64 PC). */
  arch: string
  /** Windows only: what the `tensorrt-llm` provider reaches Atomic Chat's WSL distribution through. */
  windows?: WindowsManagedContext
}

/** An engine id becomes one folder name under the data folder; anything else is refused. */
const ENGINE_FOLDER = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** `<data>/<engine>/models`, this scope's downloaded models of one engine (design, Persistence). */
export function engineModelsDir(layout: DataLayout, engineId: string): string {
  if (!ENGINE_FOLDER.test(engineId) || engineId.includes('..')) {
    throw new AtomicCoreError('INVALID_ARGUMENT', 'Not an engine id.', engineId)
  }
  return join(layout.root, engineId, 'models')
}

/**
 * The Linux recipe's host-side parts: the machine, the privileged recipe, the one Docker executor,
 * and this scope's engine caches and models.
 */
export function linuxProvisionerParts(
  options: Pick<WireManagedEnvironmentOptions, 'layout' | 'unloadEngineSessions'>,
  host: LinuxHost,
  containers: ManagedContainersHandle
): LinuxProvisionerParts {
  return {
    host,
    recipe: INSTALL_CONTAINER_RUNTIME_BINDING,
    docker: async () => {
      const wired = await containers.resolve()
      return wired === null
        ? null
        : { exec: wired.exec, socketPath: wired.socketPath, journal: wired.journal }
    },
    removeEngineCaches: async (descriptorId) => {
      await removeEngineCaches(options.layout.managed, { descriptorId })
    },
    removeModels: (engineId) =>
      rm(engineModelsDir(options.layout, engineId), { recursive: true, force: true }),
    unloadEngineSessions: options.unloadEngineSessions ?? NOTHING_LOADED,
  }
}

/**
 * Tests only: the guest recipe as the Windows test machine applies it (`atomic-test-recipe` in
 * `fake-wsl.mjs`), the way the Linux e2e's fake privileged executor stands in for the real recipe —
 * the recipe itself is the Linux one, covered where it runs.
 */
export const testGuestRecipe: GuestRecipeRunner = async (transport, request) => {
  const applied = await transport.exec(['atomic-test-recipe', ...request.parameters.components], {
    user: 'root',
  })
  return {
    outcome: applied.code === 0 ? 'completed' : 'failed',
    log_tail: `${applied.stdout}${applied.stderr}`.trim(),
  }
}

export interface WindowsPartsInput {
  layout: DataLayout
  fetch: typeof fetch
  unloadEngineSessions: UnloadEngineSessions
  host: WindowsHost
  records: Pick<WindowsEnvironmentRecordStore, 'read' | 'write' | 'remove'>
  containers: Pick<ManagedContainersHandle, 'current'>
  mount: GuestMount
  keeper: DistributionKeeper
  scopeKey: () => Promise<string>
  /** The `ATOMIC_MANAGED_TEST_WINDOWS` machine: its guest recipe is `testGuestRecipe`. */
  test: boolean
}

/**
 * The Windows provisioner's parts over this core's objects (change `add-tensorrt-llm-windows`, task
 * 2.10): the rootfs download, the guest recipe, the journal of the one executor (wired or not yet),
 * and this scope's caches and models removed by the guest's own `rm` — only ever this scope's folder,
 * through the same mount the provider uses.
 */
export function windowsProvisionerParts(input: WindowsPartsInput): WindowsProvisionerParts {
  const wsl = input.host.probeDeps.wsl
  /** This scope's guest folder, through the mount, for the guest's own `rm`; null before the import. */
  const guestFiles = async () => {
    const record = await input.records.read()
    if (record === null) return null
    const name = record.distribution.name
    const key = await input.scopeKey()
    return {
      paths: guestScopePaths(input.layout.managed, name, key, input.mount),
      models: (engineId: string) => input.mount.hostPath(name, `${guestScopeRoot(key)}/models/${engineId}`),
      files: guestModelFiles(wsl.distribution(name), input.mount),
    }
  }
  return {
    host: input.host,
    records: input.records,
    guestRecipe: INSTALL_CONTAINER_RUNTIME_BINDING,
    enableWsl: ENABLE_WSL_BINDING,
    downloadRootfs: (rootfs, destination, signal) =>
      downloadVerifiedRootfs(input.fetch, rootfs, destination, signal),
    removeFile: (path) => rm(path, { force: true }),
    runGuestRecipe: input.test ? testGuestRecipe : createGuestRecipeRunner({ fetch: input.fetch }),
    journal: {
      list: () => input.containers.current()?.journal.list() ?? [],
      remove: async (id) => {
        await input.containers.current()?.journal.remove(id)
      },
    },
    removeEngineCaches: async (descriptorId) => {
      const files = await guestFiles()
      if (files !== null) await files.files.remove([files.paths.descriptorCachesDir(descriptorId)])
    },
    removeModels: async (engineId) => {
      if (!ENGINE_FOLDER.test(engineId) || engineId.includes('..')) {
        throw new AtomicCoreError('INVALID_ARGUMENT', 'Not an engine id.', engineId)
      }
      const files = await guestFiles()
      if (files !== null) await files.files.remove([files.models(engineId)])
    },
    unloadEngineSessions: input.unloadEngineSessions,
    fetch: input.fetch,
    keeper: input.keeper,
  }
}

/**
 * The Windows half (change `add-tensorrt-llm-windows`, task 2.10): the machine and WSL (the real ones,
 * or the `ATOMIC_MANAGED_TEST_WINDOWS` stand-in), the environment record under the shared root, this
 * scope's `scope_key`, one keeper per distribution, the one Docker executor through the guest, and the
 * provisioner's parts — all over the same objects the `tensorrt-llm` provider gets in its context.
 */
function wireWindowsEnvironment(
  options: WireManagedEnvironmentOptions,
  testDir: string | null
): ManagedEnvironment {
  const host: WindowsHost = testDir === null ? realWindowsHost(options.env) : testWindowsHost(testDir)
  const wsl = host.probeDeps.wsl
  const mount: GuestMount =
    testDir === null ? WSL_LOCALHOST_MOUNT : directoryGuestMount(join(testDir, 'guest-fs'))
  const shared = managedSharedPaths(managedSharedRoot(nodeDataFolderEnv(options.env)))
  const records = new WindowsEnvironmentRecordStore(shared.environmentFile)
  const keepers = new Map<string, DistributionKeeper>()
  const keeper = (name: string): DistributionKeeper => {
    let existing = keepers.get(name)
    if (existing === undefined) {
      existing = createDistributionKeeper(wsl.distribution(name))
      keepers.set(name, existing)
    }
    return existing
  }
  const scopeKey = guestScopeKeyReader(options.layout.managed.guestScopeFile)
  const guest = async () => {
    const record = await records.read().catch(() => null)
    return record === null ? null : wsl.distribution(record.distribution.name)
  }
  const containers = createManagedContainersHandle({
    platform: 'win32',
    layout: options.layout,
    instanceId: options.instanceId,
    log: options.log,
    guest,
  })
  const parts = windowsProvisionerParts({
    layout: options.layout,
    fetch: options.fetch ?? fetch,
    unloadEngineSessions: options.unloadEngineSessions ?? NOTHING_LOADED,
    host,
    records,
    containers,
    mount,
    keeper: keeper(ATOMIC_CHAT_DISTRIBUTION),
    scopeKey,
    test: testDir !== null,
  })
  const managed = wireManagedRuntimes({
    env: nodeDataFolderEnv(options.env),
    instanceId: options.instanceId,
    platform: 'win32',
    emit: options.emit,
    newId: options.newId,
    ...(options.onWarn === undefined ? {} : { onWarn: options.onWarn }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.engines === undefined ? {} : { engines: options.engines }),
    windows: parts,
  })
  return {
    managed,
    containers,
    platform: 'win32',
    // Never asked on Windows (the provider reads the guest); built so the type stays one.
    host: realLinuxHost(options.env),
    arch: testDir === null ? process.arch : 'x64',
    windows: { records, wsl, keeper, scopeKey, host, ...(testDir === null ? {} : { mount }) },
  }
}

export function wireManagedEnvironment(options: WireManagedEnvironmentOptions): ManagedEnvironment {
  // The test hooks first, whatever the real platform: each stands in for a whole machine of its own.
  const testWindows = managedTestWindowsDir(options.env)
  if (testWindows !== null) return wireWindowsEnvironment(options, testWindows)
  const testHost = managedTestHostDir(options.env)
  if (testHost === null && options.platform === 'win32') return wireWindowsEnvironment(options, null)
  const platform: NodeJS.Platform = testHost === null ? options.platform : 'linux'
  const pinnedDocker = options.dockerPath
  const host =
    testHost !== null
      ? testLinuxHost(testHost, options.env)
      : realLinuxHost(
          options.env,
          undefined,
          pinnedDocker === undefined ? undefined : async () => pinnedDocker
        )
  const dockerPath = pinnedDocker !== undefined ? pinnedDocker : host.dockerPath
  const containers = createManagedContainersHandle({
    platform,
    layout: options.layout,
    instanceId: options.instanceId,
    log: options.log,
    ...(dockerPath === undefined ? {} : { dockerPath }),
    ...(host.dockerSocketPath === undefined ? {} : { dockerSocketPath: host.dockerSocketPath }),
  })

  const managed = wireManagedRuntimes({
    env: nodeDataFolderEnv(options.env),
    instanceId: options.instanceId,
    platform,
    emit: options.emit,
    newId: options.newId,
    ...(options.onWarn === undefined ? {} : { onWarn: options.onWarn }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.engines === undefined ? {} : { engines: options.engines }),
    linux: linuxProvisionerParts(options, host, containers),
  })
  return { managed, containers, platform, host, arch: process.arch }
}
