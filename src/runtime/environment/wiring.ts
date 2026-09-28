/**
 * How the owner builds the managed-runtime service, and what the control API sees of it.
 *
 * Two things live here that the service itself deliberately does not know about. Which host recipe
 * applies, because that is a fact about the machine the core is running on rather than about an
 * operation; and the in-memory view the snapshot answers from, because a snapshot is synchronous
 * and the record it describes is on a disk shared with another core. The view is refreshed on
 * startup and on every change this core makes, which is exactly what a client needs to rebuild from
 * a snapshot and then follow events.
 *
 * No platform has a qualified recipe yet, so `provisionerFor` answers null everywhere and every
 * environment reports itself unsupported. That is the honest state of the feature: the contract,
 * the operation and the routes are here, and nothing can install anything.
 *
 * The descriptor provider (task 2.3) is built here too, over this same `env` and `fetch`, and
 * exposed on `ManagedRuntimes` for whatever probes a host next — its own resolution (fetch, cache,
 * version gate, per-installation pin) is fully wired and tested in `descriptor-provider.ts`.
 * `recover()` fills `EnvironmentSnapshot.minimum_app_version` from it on every call
 * (`resolveMinimumAppVersion`, below) — cache-only, so this never reaches the network on a core
 * start. With `provisionerFor` answering null everywhere and `installations` never getting a real
 * entry until task 2.4's host recipe exists, that resolution has nothing to work from yet on any
 * real machine and stays `null` in practice — but the wiring is real, not a placeholder.
 */

import { readFile as nodeReadFile } from 'node:fs/promises'
import { managedSharedRoot } from '../../config/index.js'
import type { DataFolderEnv } from '../../config/index.js'
import type {
  CoreEvents,
  EnvironmentOperation,
  EnvironmentSnapshot,
  ExecutorKind,
  RuntimeInstallation,
} from '../../contracts/index.js'
import { processStartId } from '../../lock/index.js'
import { createRuntimeDescriptorProvider, descriptorFetchFromFetch } from './descriptor-provider.js'
import type { RuntimeDescriptorProvider } from './descriptor-provider.js'
import { EnvironmentService, type EnvironmentProvisioner } from './service.js'
import { OperationStore, type OwnerIdentity } from './store.js'

/** The one environment a machine user has, per scope. Its id is fixed: there is only ever one. */
export const DEFAULT_ENVIRONMENT_ID = 'default'

/**
 * Which container engine this platform would drive. Null where none of them applies — and, for
 * now, on every platform this change does not target: task 2.2 wires no Windows recipe or Docker
 * executor (WSL is out of scope of this change entirely), so a `wsl-docker` environment here would
 * advertise a container engine nothing in this build can ever set up. `darwin` already answers
 * null for the same reason (there is no container engine for it, ever) — `win32` joins it until a
 * later change actually adds the Windows recipe.
 */
export function executorFor(platform: NodeJS.Platform): ExecutorKind | null {
  if (platform === 'linux') return 'linux-docker'
  return null
}

/**
 * The host recipe for this platform, or null when there is none.
 *
 * Null is not a placeholder for "not written yet" that a later card quietly fills: a caller gets an
 * environment that says it is unsupported and an operation that fails with an actionable blocker,
 * rather than one that appears to be installing something.
 */
export function provisionerFor(_platform: NodeJS.Platform): EnvironmentProvisioner | null {
  return null
}

/**
 * `EnvironmentSnapshot.minimum_app_version`: the descriptor currently in effect for this
 * environment, network-free (spec `runtime-descriptor-catalog`, "Минимальные версии соблюдаются").
 * An installation pinned to a descriptor (`active_descriptor_id`) wins — that is the release
 * actually running, so its own `minimum_app_version` is what the client needs to know — otherwise
 * the latest descriptor this core has ever accepted into its cache; `null` when neither resolves (no
 * installation, and nothing has ever been cached). Never calls `fetch` or `readFile`: both
 * `forInstallation` and `cachedForNewSetup` are cache-only, so this is safe to call on every
 * `recover()` without adding network latency to core startup for a value most machines will never
 * populate an installation for.
 */
export async function resolveMinimumAppVersion(
  descriptors: RuntimeDescriptorProvider,
  installations: readonly RuntimeInstallation[]
): Promise<string | null> {
  const pinned = installations.find((installation) => installation.active_descriptor_id !== null)
  const resolved =
    pinned !== undefined
      ? // `pinned.active_descriptor_id` is narrowed non-null by the `find` predicate above; TS does
        // not carry that through `Array.prototype.find`, hence the assertion rather than a cast of
        // convenience — the invariant is the one-line filter right above it, not an assumption.
        await descriptors.forInstallation(pinned.active_descriptor_id as string)
      : await descriptors.cachedForNewSetup()
  return resolved.kind === 'available' ? resolved.descriptor.minimum_app_version : null
}

export interface WireManagedRuntimesOptions {
  env: DataFolderEnv
  instanceId: string
  platform: NodeJS.Platform
  emit: <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) => void
  newId: () => string
  /** Test seam: a recipe to use instead of the one this platform would get. */
  provisioner?: EnvironmentProvisioner | null
  /**
   * Test seam: whose identity this core stamps on what it writes to the shared store
   * (`OperationStore.ownerIdentity`), instead of this real process's own pid. A test simulating a
   * second, dead core gives it a pid that really existed and really is gone; simulating the same
   * core again (the ordinary case) needs nothing, since the real pid stays the real pid.
   */
  ownerPid?: number
  /** What the runtime descriptor provider fetches with; defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** Where the descriptor provider reports a rejected source or a non-fatal cache write failure. */
  onWarn?: (message: string) => void
}

export interface ManagedRuntimes {
  service: EnvironmentService
  /** What the snapshot answers with, without going to disk. */
  environments: () => EnvironmentSnapshot[]
  operations: () => EnvironmentOperation[]
  /** Reconcile whatever the previous core left behind, then publish the result. */
  recover: () => Promise<void>
  shutdown: (signal: AbortSignal) => Promise<void>
  /** Gets and caches the TensorRT-LLM runtime descriptor (task 2.3): a host recipe consumes this. */
  descriptors: RuntimeDescriptorProvider
}

export function wireManagedRuntimes(options: WireManagedRuntimesOptions): ManagedRuntimes {
  const executor = executorFor(options.platform)
  const provisioner =
    options.provisioner === undefined ? provisionerFor(options.platform) : options.provisioner

  const ownerPid = options.ownerPid ?? process.pid
  // Resolved once and cached: a process's start identity never changes while it runs, and
  // re-probing it on every write would mean an `exec` per commit on macOS and Windows.
  let ownerIdentityCache: Promise<OwnerIdentity> | undefined
  const ownerIdentity = (): Promise<OwnerIdentity> => {
    ownerIdentityCache ??= processStartId(ownerPid).then((startId) => ({
      pid: ownerPid,
      startId: startId ?? null,
    }))
    return ownerIdentityCache
  }

  const managedRoot = managedSharedRoot(options.env)
  const store = new OperationStore({
    root: managedRoot,
    instanceId: options.instanceId,
    newOperationId: options.newId,
    newEffectId: options.newId,
    ownerIdentity,
  })

  const descriptors = createRuntimeDescriptorProvider({
    env: options.env.env,
    fetch: descriptorFetchFromFetch(options.fetch ?? fetch),
    readFile: (path) => nodeReadFile(path, 'utf8'),
    root: managedRoot,
    ...(options.onWarn === undefined ? {} : { onWarn: options.onWarn }),
  })

  // The view a snapshot is built from. A machine with no executor has no environment at all, which
  // is different from having one that cannot be set up.
  const view: EnvironmentSnapshot[] =
    executor === null
      ? []
      : [
          {
            schema_version: 1,
            environment_id: DEFAULT_ENVIRONMENT_ID,
            instance_id: options.instanceId,
            revision: 0,
            executor,
            availability: provisioner === null ? 'unsupported' : 'setup-required',
            gpus: [],
            installations: [],
            active_operation_id: null,
            // Resolved for real in `recover()`, network-free, from `descriptors` below — `null`
            // only until the first `recover()` runs (or forever, on a machine with nothing cached
            // and no pinned installation, which is every machine today: `provisioner` is always
            // null until task 2.4, so `installations` never gets a real entry yet either).
            minimum_app_version: null,
          },
        ]

  const operations = new Map<string, EnvironmentOperation>()

  const service = new EnvironmentService({
    store,
    environmentId: DEFAULT_ENVIRONMENT_ID,
    instanceId: options.instanceId,
    newEffectId: options.newId,
    provisioner,
    readSnapshot: async () => view,
    emit: (name, payload) => {
      // Keep the snapshot and the event stream describing the same thing: a client that reconnects
      // must not see a snapshot older than the events it then receives.
      operations.set(payload.operation_id, payload)
      const environment = view[0]
      if (environment !== undefined) {
        environment.active_operation_id = TERMINAL.includes(payload.phase) ? null : payload.operation_id
      }
      options.emit(name, payload)
    },
  })

  return {
    service,
    environments: () => view,
    operations: () => [...operations.values()],
    recover: async () => {
      // Whatever the previous core was doing is read back before anything is served, so the first
      // snapshot a client sees already includes it.
      for (const record of await store.listRecoverable().catch(() => [])) {
        operations.set(record.machine.operation.operation_id, record.machine.operation)
      }
      await service.recover(options.instanceId)
      const environment = view[0]
      if (environment !== undefined) {
        environment.minimum_app_version = await resolveMinimumAppVersion(
          descriptors,
          environment.installations
        )
      }
    },
    shutdown: (signal) => service.shutdown(signal),
    descriptors,
  }
}

const TERMINAL: readonly EnvironmentOperation['phase'][] = ['ready', 'removed', 'cancelled', 'failed']
