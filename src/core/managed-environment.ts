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
import { nodeDataFolderEnv } from '../config/index.js'
import type { DataLayout } from '../config/index.js'
import type { CoreEvents } from '../contracts/index.js'
import { AtomicCoreError } from '../contracts/index.js'
import { INSTALL_CONTAINER_RUNTIME_BINDING } from '../host/recipes/index.js'
import { createManagedContainersHandle } from '../runtime/container/index.js'
import type { ManagedContainersHandle, ReconcileLogger } from '../runtime/container/index.js'
import {
  managedTestHostDir,
  NOTHING_LOADED,
  realLinuxHost,
  testLinuxHost,
  wireManagedRuntimes,
} from '../runtime/environment/index.js'
import type {
  LinuxHost,
  LinuxProvisionerParts,
  ManagedRuntimes,
  UnloadEngineSessions,
} from '../runtime/environment/index.js'
import { removeEngineCaches } from '../runtime/managed-text/index.js'

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

export function wireManagedEnvironment(options: WireManagedEnvironmentOptions): ManagedEnvironment {
  const testHost = managedTestHostDir(options.env)
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
    linux: linuxProvisionerParts(options, host, containers),
  })
  return { managed, containers, platform, host }
}
