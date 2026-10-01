/**
 * The Windows host recipe behind `EnvironmentService` (change `add-tensorrt-llm-windows`; spec
 * `wsl-runtime-environment`): what a setup and a removal of a managed engine do on Windows, where the
 * engine runs in a WSL distribution Atomic Chat imports and owns — one method per effect the reducer
 * (`state.ts`) can ask for, like the Linux provisioner, over the same descriptor, installations and
 * operation machinery.
 *
 * - **probe** reads Windows (`probeWindowsHost`), Atomic Chat's own environment record, and — when its
 *   distribution is registered — the guest as a Linux host (`guest-host.ts`, design D1), and judges
 *   them (`assessWindowsHost`) against the descriptor and the Windows environment manifest. An
 *   environment that exists keeps the manifest it was imported by (spec "Окружение Windows закрепляет
 *   свой манифест"); a new one is judged by the newest.
 *
 * Nothing here runs `wsl.exe` from an elevated process: the core is the user's own, and a core started
 * elevated is blocked before anything is imported (`elevated-process`).
 */
import { randomUUID } from 'node:crypto'
import { win32 } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import type {
  ContainerRuntimeStepParameters,
  ErrorBody,
  ManagedAvailability,
  ManagedBlocker,
  ManagedHostStep,
  ManagedProgress,
  PlatformImage,
  RequirementPlan,
  RuntimeDescriptor,
  Sha256Digest,
  WindowsEnvironmentManifest,
  WslRootfs,
} from '../../contracts/index.js'
import {
  containersUsingImage,
  inspectImage,
  pullImageWithCurl,
  removeContainer,
  removeImage,
  runOnce,
  stopContainer,
  type DockerExec,
  type ExecutionRecord,
} from '../container/index.js'
import type { WslDistributionTransport } from '../wsl/index.js'
import { canonicalDigest } from './canonical-json.js'
import type { RuntimeDescriptorProvider } from './descriptor-provider.js'
import type { EnvironmentManifestProvider } from './environment-manifest-provider.js'
import { GUEST_DOCKER, GUEST_ROOT, guestLinuxHost, probeGuestExtras, type GuestExtras } from './guest-host.js'
import type { InstallationRecord, InstallationStore } from './installations.js'
import {
  imageMatchesDigest,
  NOTHING_LOADED,
  ownedImageId,
  pickGpu,
  type HostRecipeBinding,
  type HostView,
  type UnloadEngineSessions,
} from './linux-provisioner.js'
import { probeLinux, type LinuxFacts } from './linux-probe.js'
import { descriptorForProbe, pinnedDescriptor } from './provisioner-descriptors.js'
import type { EffectFinding, EffectInventory } from './recovery.js'
import type { EffectIntent } from './state.js'
import type { EnvironmentProvisioner, HostStepVerdict, ProvisionerProbe } from './service.js'
import type { PersistedOperation } from './store.js'
import type { WindowsEnvironmentRecord } from './windows-environment-record.js'
import {
  ATOMIC_CHAT_DISTRIBUTION,
  distributionDirectory,
  distributionDisk,
  type WindowsHost,
} from './windows-host.js'
import { importDistribution, restoreDefaultDistribution, setupGuest } from './windows-guest-setup.js'
import { assessWindowsHost, type WindowsBlocker } from './windows-plan.js'
import { probeWindowsHost, type WindowsHostFacts, type WslDistribution } from './windows-probe.js'

/** The elevated recipe's identity: what a `windows.enable-wsl` step and its receipt are bound to. */
export interface EnableWslBinding {
  recipe_id: string
  recipe_digest: Sha256Digest
  /** The digest of its (empty) parameters. */
  parameters_digest: Sha256Digest
}

/** What the guest recipe is run with: the Linux recipe's identity and its validated parameters. */
export interface GuestRecipeRequest {
  recipe_id: string
  recipe_digest: Sha256Digest
  parameters: ContainerRuntimeStepParameters
  parameters_digest: Sha256Digest
}

/**
 * Runs `linux.install-container-runtime` in the guest as its root (design D1, D3): the same executor
 * the Linux host step runs, over the WSL transport. Built in `src/host/recipes` and injected, like the
 * Linux recipe binding, so this module never imports the host module.
 */
export type GuestRecipeRunner = (
  transport: WslDistributionTransport,
  request: GuestRecipeRequest,
  signal: AbortSignal
) => Promise<{ outcome: 'completed' | 'reboot-required' | 'failed'; log_tail: string }>

/** The environment record store, as far as the provisioner needs it. */
export interface WindowsEnvironmentRecords {
  read(): Promise<WindowsEnvironmentRecord | null>
  write(record: WindowsEnvironmentRecord): Promise<void>
  remove(): Promise<void>
}

export interface WindowsProvisionerDeps {
  host: WindowsHost
  descriptors: RuntimeDescriptorProvider
  /** The Windows environment manifest: the rootfs, the minimum versions, the guest recipe. */
  environmentManifests: EnvironmentManifestProvider<'windows'>
  records: WindowsEnvironmentRecords
  /** `linux.install-container-runtime`, run in the guest as its root (design D3). */
  guestRecipe: HostRecipeBinding
  /** `windows.enable-wsl`, the one elevated step (design D2), as `src/host/recipes` builds it. */
  enableWsl: EnableWslBinding
  installations: InstallationStore
  environmentId: string
  /** Downloads the manifest's rootfs to `destination` and checks its sha256; on a mismatch deletes it and throws. */
  downloadRootfs: (rootfs: WslRootfs, destination: string, signal: AbortSignal) => Promise<void>
  /** Deletes one file core downloaded (the rootfs after the import). */
  removeFile: (path: string) => Promise<void>
  runGuestRecipe: GuestRecipeRunner
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** This scope's execution journal (Windows-side, core's own state): the engine's containers to remove. */
  journal: { list(): ExecutionRecord[]; remove(containerId: string): Promise<void> }
  /** Removes this scope's engine caches of one descriptor, in the guest. */
  removeEngineCaches: (descriptorId: string) => Promise<void>
  /** Removes this scope's downloaded models of one engine, in the guest; only for `retain_models: false`. */
  removeModels: (engineId: string) => Promise<void>
  unloadEngineSessions?: UnloadEngineSessions
  onAssessment?: (view: HostView) => void
  newId?: () => string
  now?: () => Date
}

const ZERO_DIGEST: Sha256Digest = `sha256:${'0'.repeat(64)}`
/** Checkpoints at which part or all of the engine image is already in the guest's layer store. */
const PULL_PHASES: readonly string[] = ['pulling-image', 'verifying', 'activating']
/** The only platform a Windows guest runs (the manifest's rootfs is x86_64). */
const GUEST_PLATFORM = 'linux/amd64'
const STOP_TIMEOUT_SECONDS = 10

/** The unsupported verdicts: what hides the provider rather than blocking a plan. */
const METADATA_REASONS: readonly string[] = ['environment-manifest-unavailable']

/** A `WindowsBlocker` on the wire, the same shape a Linux blocker takes (`toManagedBlocker`). */
export function toWindowsManagedBlocker(entry: WindowsBlocker): ManagedBlocker {
  return {
    code: METADATA_REASONS.includes(entry.reason)
      ? 'MANAGED_METADATA_INVALID'
      : 'MANAGED_PREREQUISITE_BLOCKED',
    message: entry.message,
    details: entry.reason,
    reason: entry.reason,
    ...(entry.params === undefined ? {} : { params: entry.params }),
    ...(entry.commands === undefined ? {} : { commands: entry.commands }),
  }
}

/** What a Windows probe found, all of it: the plan and the steps after it read this, never the machine twice. */
export interface WindowsLook {
  facts: WindowsHostFacts
  record: WindowsEnvironmentRecord | null
  /** Ours, registered under the recorded name. */
  owned: WslDistribution | null
  foreign: boolean
  distribution: { name: string; path: string }
  guest: { facts: LinuxFacts; extras: GuestExtras } | null
}

export function createWindowsProvisioner(deps: WindowsProvisionerDeps): EnvironmentProvisioner {
  const newId = deps.newId ?? randomUUID
  const now = deps.now ?? (() => new Date())
  const wsl = deps.host.probeDeps.wsl

  /** The guest's docker CLI, as root, by its absolute path, over the transport (design D3). */
  const guestDocker =
    (transport: WslDistributionTransport): DockerExec =>
    (args, call) =>
      transport.exec([GUEST_DOCKER, ...args], {
        user: GUEST_ROOT,
        ...(call?.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs }),
      })

  /** Read Windows, the record, and the guest when ours is there and can start. Changes nothing. */
  const look = async (): Promise<WindowsLook> => {
    const [facts, record] = await Promise.all([probeWindowsHost(deps.host.probeDeps), deps.records.read()])
    const name = record?.distribution.name ?? ATOMIC_CHAT_DISTRIBUTION
    const path = record?.distribution.path ?? distributionDirectory(deps.host.localAppData, name)
    const registered = facts.distributions.find((entry) => entry.name === name) ?? null
    const owned = record === null ? null : registered
    const foreign = record === null && registered !== null
    let guest: WindowsLook['guest'] = null
    if (owned !== null && owned.version === 2 && facts.wsl.ready === true) {
      const transport = wsl.distribution(owned.name)
      const host = guestLinuxHost(transport)
      const [linux, extras] = await Promise.all([
        probeLinux(host.probeDeps, host.options()),
        probeGuestExtras(transport),
      ])
      guest = { facts: linux, extras }
    }
    return { facts, record, owned, foreign, distribution: { name, path }, guest }
  }

  /**
   * The manifest a probe judges by. An existing environment keeps the one it was imported by, from
   * the cache — or, when the cache lost it, conf's only if it still serves that very id. Before an
   * import: the consented one once work began, otherwise the newest.
   */
  const manifestFor = async (
    record: PersistedOperation,
    environment: WindowsEnvironmentRecord | null
  ): Promise<WindowsEnvironmentManifest | null> => {
    const pinnedId = environment?.manifest_id ?? record.machine.consented?.environment_manifest_id ?? null
    if (environment !== null || record.machine.consented != null) {
      if (pinnedId === null) return null
      const pinned = await deps.environmentManifests.pinned(pinnedId)
      if (pinned.kind === 'available') return pinned.manifest
      const again = await deps.environmentManifests.latest()
      return again.kind === 'available' && again.manifest.manifest_id === pinnedId ? again.manifest : null
    }
    const latest = await deps.environmentManifests.latest()
    return latest.kind === 'available' ? latest.manifest : null
  }

  const imagePresent = async (
    transport: WslDistributionTransport,
    image: PlatformImage
  ): Promise<boolean> => {
    const inspected = await inspectImage(guestDocker(transport), image).catch(() => null)
    return inspected !== null && inspected.found && imageMatchesDigest(inspected.value, image)
  }

  const blockedPlan = (
    record: PersistedOperation,
    availability: ManagedAvailability,
    blockers: ManagedBlocker[]
  ): RequirementPlan => ({
    plan_digest: canonicalDigest({ blocked: blockers.map((entry) => entry.reason ?? entry.code) }),
    environment_id: deps.environmentId,
    target: record.machine.operation.target,
    availability,
    recipe_id: 'none',
    recipe_digest: ZERO_DIGEST,
    descriptor_id: null,
    environment_manifest_id: null,
    image_digest: null,
    adopts_existing_engine: false,
    system_changes: [],
    download_bytes: null,
    required_disk_bytes: null,
    docker_root_dir: null,
    free_disk_bytes: null,
    requires_elevation: false,
    may_require_relogin: false,
    may_require_reboot: false,
    blockers,
    warnings: [],
  })

  const setupProbe = async (record: PersistedOperation): Promise<ProvisionerProbe> => {
    const resolved = await descriptorForProbe(deps.descriptors, record)
    if ('blocker' in resolved) {
      const plan = blockedPlan(record, 'unsupported', [resolved.blocker])
      deps.onAssessment?.({ availability: 'unsupported', gpus: [], blockers: plan.blockers, selinux: null })
      return { plan, host_step: null }
    }
    const descriptor: RuntimeDescriptor = resolved.descriptor
    const target = record.machine.operation.target
    const seen = await look()
    const manifest = await manifestFor(record, seen.record)
    const image = descriptor.image[GUEST_PLATFORM]
    const transport = seen.owned === null ? null : wsl.distribution(seen.owned.name)
    const existing = target.kind === 'runtime' ? await deps.installations.read(target.installation_id) : null
    const present =
      target.kind === 'runtime' && transport !== null && seen.guest?.facts.docker.daemon_reachable === true
        ? await imagePresent(transport, image)
        : false
    const readyInstallation =
      existing !== null &&
      existing.installation.status === 'ready' &&
      existing.installation.active_descriptor_id === descriptor.descriptor_id
    const pullStarted = PULL_PHASES.includes(record.machine.checkpoint ?? 'checking')
    const stillNeeded =
      target.kind !== 'runtime' || present || pullStarted || readyInstallation
        ? null
        : descriptor.required_disk_bytes
    const volumeFree = await deps.host.freeDiskBytes(seen.distribution.path).catch(() => null)

    const assessment = assessWindowsHost({
      facts: seen.facts,
      manifest,
      owned: seen.owned,
      foreign: seen.foreign,
      distribution: seen.distribution,
      volumeFreeBytes: volumeFree,
      guest: seen.guest,
      guestRecipeId: manifest?.guest_recipe_id ?? deps.guestRecipe.recipe_id,
      minimumDriverVersion: descriptor.minimum_driver_version,
      minimumComputeCapability: descriptor.minimum_compute_capability,
      requiredDiskBytes: stillNeeded,
    })
    const blockers = assessment.blockers.map(toWindowsManagedBlocker)
    if (target.kind === 'runtime' && target.engine_id !== descriptor.engine_id) {
      blockers.push({
        code: 'MANAGED_METADATA_INVALID',
        message: `The descriptor ${descriptor.descriptor_id} is for ${descriptor.engine_id}, not ${target.engine_id}.`,
        reason: 'engine-mismatch',
      })
    }
    if (existing !== null && existing.installation.active_descriptor_id !== descriptor.descriptor_id) {
      blockers.push({
        code: 'MANAGED_OPERATION_CONFLICT',
        message: `This engine is already installed from ${String(existing.installation.active_descriptor_id)}; remove it before setting up ${descriptor.descriptor_id}.`,
        reason: 'installed-with-other-descriptor',
      })
    }

    const availability: ManagedAvailability =
      assessment.availability === 'unsupported'
        ? 'unsupported'
        : blockers.length > 0
          ? 'prerequisite-blocked'
          : readyInstallation && assessment.adopts_existing_engine
            ? 'supported'
            : 'setup-required'
    const systemChanges = blockers.length > 0 ? [] : assessment.system_changes
    const requiresElevation = blockers.length === 0 && assessment.enable_wsl
    const manifestId = manifest?.manifest_id ?? null
    const plan: RequirementPlan = {
      plan_digest: canonicalDigest({
        platform: 'windows',
        target,
        recipe_id: deps.guestRecipe.recipe_id,
        recipe_digest: deps.guestRecipe.recipe_digest,
        adopts_existing_engine: assessment.adopts_existing_engine,
        system_changes: systemChanges,
        requires_elevation: requiresElevation,
        may_require_reboot: requiresElevation,
        enable_wsl: requiresElevation ? deps.enableWsl.recipe_digest : null,
        descriptor: { descriptor_id: descriptor.descriptor_id, image_digest: image.digest },
        environment_manifest_id: manifestId,
        host: {
          gpu_ids: seen.facts.gpus.map((gpu) => gpu.gpu_id).sort(),
          disk_sufficient: assessment.disk_sufficient,
          distribution: seen.distribution.name,
        },
        blockers: blockers.map((entry) => entry.reason ?? entry.code),
      }),
      environment_id: deps.environmentId,
      target,
      availability,
      recipe_id: deps.guestRecipe.recipe_id,
      recipe_digest: deps.guestRecipe.recipe_digest,
      descriptor_id: descriptor.descriptor_id,
      environment_manifest_id: manifestId,
      image_digest: target.kind === 'runtime' ? image.digest : null,
      adopts_existing_engine: assessment.adopts_existing_engine,
      system_changes: systemChanges,
      download_bytes: descriptor.download_bytes,
      required_disk_bytes: descriptor.required_disk_bytes,
      // The distribution's own directory and the space its disk can still take (ruling core 2.1).
      docker_root_dir: assessment.free_disk_bytes === null ? null : seen.distribution.path,
      free_disk_bytes: assessment.free_disk_bytes,
      requires_elevation: requiresElevation,
      may_require_relogin: false,
      may_require_reboot: requiresElevation,
      blockers,
      warnings: [],
    }
    deps.onAssessment?.({
      availability,
      gpus: seen.facts.gpus,
      blockers,
      selinux: seen.guest?.facts.docker.daemon_reachable === true ? seen.guest.facts.docker.selinux : null,
      distribution:
        seen.owned === null
          ? null
          : {
              name: seen.owned.name,
              path: seen.distribution.path,
              size_bytes: await deps.host
                .fileSize(distributionDisk(seen.distribution.path))
                .catch(() => null),
            },
      memory_bytes: seen.guest?.extras.memory_bytes ?? null,
    })
    // The one elevated step, with nothing in it a client could choose (design D2).
    const hostStep: ManagedHostStep | null = requiresElevation
      ? {
          step_id: `host-step-${newId()}`,
          action: 'windows.enable-wsl',
          recipe_id: deps.enableWsl.recipe_id,
          recipe_digest: deps.enableWsl.recipe_digest,
          parameters_digest: deps.enableWsl.parameters_digest,
          parameters: {},
          nonce: newId(),
          // Stamped with the real revision when the step is issued (`state.ts`, `afterConsent`).
          expected_operation_revision: 0,
        }
      : null
    return { plan, host_step: hostStep, image_present: present }
  }

  /** WSL answers `--version` and `--status`: the elevated step's work is in effect. */
  const wslReady = async (): Promise<boolean> => {
    const facts = await probeWindowsHost(deps.host.probeDeps)
    return facts.wsl.installed === true && facts.wsl.ready === true
  }

  const blocked = (message: string, reason: string): AtomicCoreError =>
    new AtomicCoreError('MANAGED_PREREQUISITE_BLOCKED', message, reason)

  const sleep =
    deps.sleep ??
    ((ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms)
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        })
      }))

  /** The manifest the import uses: exactly the consented one, from the cache. */
  const consentedManifest = async (record: PersistedOperation): Promise<WindowsEnvironmentManifest> => {
    const id =
      record.machine.consented?.environment_manifest_id ??
      record.requirement_plan?.environment_manifest_id ??
      null
    if (id === null) {
      throw new AtomicCoreError(
        'MANAGED_METADATA_INVALID',
        'This operation has no approved Windows environment manifest.'
      )
    }
    const pinned = await deps.environmentManifests.pinned(id)
    if (pinned.kind !== 'available')
      throw new AtomicCoreError('MANAGED_METADATA_INVALID', pinned.error.message, id)
    return pinned.manifest
  }

  /**
   * Import Atomic Chat's own distribution (D9): the rootfs downloaded and checked against the manifest's
   * sha256 before it is used, the record written before `wsl --import` — so a core that dies mid-import
   * still knows the name is ours — the download deleted afterwards, the user's default put back.
   */
  const importOwn = async (
    record: PersistedOperation,
    seen: WindowsLook,
    signal: AbortSignal
  ): Promise<WindowsEnvironmentRecord> => {
    const manifest = await consentedManifest(record)
    const { name, path } = seen.distribution
    const previousDefault = seen.facts.distributions.find((entry) => entry.is_default)?.name ?? null
    const rootfs = win32.join(
      deps.host.localAppData,
      'AtomicChat',
      'wsl',
      'downloads',
      `${manifest.rootfs.sha256}.wsl`
    )
    await deps.downloadRootfs(manifest.rootfs, rootfs, signal)
    const environment: WindowsEnvironmentRecord = {
      schema_version: 1,
      executor: 'wsl-docker',
      distribution: { name, path },
      manifest_id: manifest.manifest_id,
      imported_at: now().toISOString(),
      marker: newId(),
    }
    await deps.records.write(environment)
    try {
      await importDistribution(wsl, { name, path, rootfs }, signal)
    } finally {
      await deps.removeFile(rootfs).catch(() => undefined)
    }
    await restoreDefaultDistribution(wsl, previousDefault, signal)
    return environment
  }

  /** Docker and the toolkit in the guest by the Linux recipe, as guest root, when the guest still needs them. */
  const provisionGuest = async (
    transport: WslDistributionTransport,
    manifest: WindowsEnvironmentManifest | null,
    descriptor: RuntimeDescriptor,
    signal: AbortSignal
  ): Promise<void> => {
    const seen = await look()
    const assessment = assessWindowsHost({
      facts: seen.facts,
      manifest,
      owned: seen.owned,
      foreign: false,
      distribution: seen.distribution,
      volumeFreeBytes: null,
      guest: seen.guest,
      guestRecipeId: deps.guestRecipe.recipe_id,
      minimumDriverVersion: descriptor.minimum_driver_version,
      minimumComputeCapability: descriptor.minimum_compute_capability,
      requiredDiskBytes: null,
    })
    if (assessment.blockers.length > 0) {
      const first = assessment.blockers[0] as WindowsBlocker
      throw blocked(assessment.blockers.map((entry) => entry.message).join(' '), first.reason)
    }
    const plan = assessment.guest_plan
    if (plan === null) return
    const distribution = seen.guest?.facts.distribution
    if (distribution === null || distribution === undefined || distribution.family !== 'apt') {
      throw blocked(
        'The Atomic Chat distribution is not the Ubuntu it was imported as.',
        'distribution-not-in-recipe'
      )
    }
    const parameters = deps.guestRecipe.parameters(plan, {
      user: GUEST_ROOT,
      arch: 'x86_64',
      family: 'apt',
      distro_id: distribution.id,
      version_id: distribution.version_id,
    })
    const ran = await deps.runGuestRecipe(
      transport,
      {
        recipe_id: deps.guestRecipe.recipe_id,
        recipe_digest: deps.guestRecipe.recipe_digest,
        parameters,
        parameters_digest: deps.guestRecipe.parametersDigest(parameters),
      },
      signal
    )
    if (ran.outcome !== 'completed') {
      throw blocked(
        `Installing Docker and the NVIDIA Container Toolkit in the distribution failed: ${ran.log_tail}`,
        'guest-recipe-failed'
      )
    }
  }

  /** The GPU-check image through the guest's Engine API, then `nvidia-smi` in it on the chosen card (design D6). */
  const checkGpu = async (
    transport: WslDistributionTransport,
    descriptor: RuntimeDescriptor,
    seen: WindowsLook,
    signal: AbortSignal,
    own: (resourceIds: string[]) => Promise<void>
  ): Promise<void> => {
    const gpu = pickGpu(seen.facts.gpus, descriptor.minimum_compute_capability)
    if (gpu === null) {
      throw blocked(
        `No GPU with compute capability ${descriptor.minimum_compute_capability} or newer was found.`,
        'compute-capability-too-low'
      )
    }
    const docker = guestDocker(transport)
    const probeImage = descriptor.probe_image[GUEST_PLATFORM]
    // Only a GPU-check image this setup pulls itself is its to remove later (as on Linux).
    const inspected = await inspectImage(docker, probeImage).catch(() => null)
    if (inspected !== null && !inspected.found) await own([ownedImageId(probeImage)])
    await pullImageWithCurl(probeImage, {
      run: (argv, call) => transport.exec(argv, { user: GUEST_ROOT, ...call }),
      signal,
      verify: docker,
    })
    const result = await runOnce(docker, {
      image: probeImage,
      gpuUuid: gpu.gpu_id,
      command: ['nvidia-smi', '--query-gpu=uuid', '--format=csv,noheader'],
    })
    if (result.code !== 0 || !result.stdout.includes(gpu.gpu_id)) {
      throw new AtomicCoreError(
        'MANAGED_PREREQUISITE_BLOCKED',
        `The GPU ${gpu.name} is not visible inside a container in the Atomic Chat distribution: the NVIDIA Container Toolkit did not pass it through. The engine image was not downloaded.`,
        [
          `gpu=${gpu.gpu_id}`,
          `exit=${String(result.code)}`,
          `stdout=${result.stdout.trim().slice(-1000)}`,
          `stderr=${result.stderr.trim().slice(-1000)}`,
        ].join('\n')
      )
    }
  }

  /** Atomic Chat's own distribution, as its record names it; no record is no environment. */
  const ownTransport = async (): Promise<WslDistributionTransport> => {
    const environment = await deps.records.read()
    if (environment === null) {
      throw blocked('The Atomic Chat distribution is not set up on this computer.', 'no-distribution')
    }
    return wsl.distribution(environment.distribution.name)
  }

  const unload = deps.unloadEngineSessions ?? NOTHING_LOADED

  const notYet = (what: string): never => {
    throw new AtomicCoreError(
      'MANAGED_PREREQUISITE_BLOCKED',
      `Managed runtimes on Windows cannot ${what} in this build yet.`
    )
  }

  const inventory: EffectInventory = {
    async inspect(effect: EffectIntent, record: PersistedOperation): Promise<EffectFinding> {
      if (record.request.kind === 'remove') return { kind: 'absent' }
      try {
        if (effect.kind === 'pull-image' || effect.kind === 'verify') {
          const descriptor = await pinnedDescriptor(deps.descriptors, record)
          return (await imagePresent(await ownTransport(), descriptor.image[GUEST_PLATFORM]))
            ? { kind: 'completed', owned_resource_ids: [] }
            : { kind: 'absent' }
        }
        if (effect.kind === 'activate') {
          const target = record.machine.operation.target
          const existing =
            target.kind === 'runtime' ? await deps.installations.read(target.installation_id) : null
          const planned =
            record.machine.consented?.descriptor_id ?? record.requirement_plan?.descriptor_id ?? null
          return existing !== null &&
            existing.installation.active_descriptor_id === planned &&
            existing.installation.status === 'ready'
            ? { kind: 'completed', owned_resource_ids: [] }
            : { kind: 'absent' }
        }
      } catch {
        // Nothing this core can check: the effect runs again, and fails there with its own reason.
      }
      return { kind: 'absent' }
    },
    needsRelogin: async () => false,
    // Asked at every core start (`recovery.ts`): an operation waiting on a restart keeps waiting until
    // WSL can start; then the probe that follows continues it under the consent it already has.
    needsReboot: async (record) =>
      record.machine.operation.phase === 'reboot-required' && !(await wslReady().catch(() => false)),
    verifyCompletedSteps: async (record) => {
      const steps = record.machine.operation.completed_step_ids
      if (steps.length === 0) return []
      return (await wslReady().catch(() => false)) ? steps : []
    },
    currentPlanDigest: async (record) =>
      (await setupProbe(record).catch(() => null))?.plan.plan_digest ?? null,
  }

  return {
    probe: (record) => setupProbe(record),
    async verifyHostStep(record: PersistedOperation): Promise<HostStepVerdict> {
      // The receipt is an assertion; the machine is the evidence (task 2.6's rule, on Windows too).
      const answer = await setupProbe(record)
      const { blockers } = answer.plan
      if (blockers.length > 0) {
        return {
          prerequisites_met: false,
          needs_relogin: false,
          error: {
            code: (blockers[0] as ManagedBlocker).code,
            message: `WSL was reported as enabled, but the machine says: ${blockers.map((entry) => entry.message).join(' ')}`,
            details: blockers.map((entry) => entry.reason ?? entry.code).join(','),
          },
        }
      }
      if (answer.host_step !== null) {
        const missing: ErrorBody = {
          code: 'MANAGED_PREREQUISITE_BLOCKED',
          message: 'WSL was reported as enabled, but it does not start yet; Windows may need a restart.',
          details: 'enable-wsl',
        }
        return { prerequisites_met: false, needs_relogin: false, error: missing }
      }
      return { prerequisites_met: true, needs_relogin: false, error: null }
    },
    async prepare(
      record: PersistedOperation,
      signal: AbortSignal,
      own: (resourceIds: string[]) => Promise<void>
    ): Promise<void> {
      const descriptor = await pinnedDescriptor(deps.descriptors, record)
      const seen = await look()
      if (seen.foreign) {
        throw blocked(
          `A WSL distribution named "${seen.distribution.name}" exists that Atomic Chat did not create; it is not used or changed.`,
          'foreign-distribution'
        )
      }
      if (seen.facts.wsl.installed !== true || seen.facts.wsl.ready !== true) {
        throw blocked('WSL is not ready on this computer yet.', 'wsl-not-ready')
      }
      const environment =
        seen.owned === null
          ? await importOwn(record, seen, signal)
          : (seen.record as WindowsEnvironmentRecord)
      const transport = wsl.distribution(environment.distribution.name)
      await setupGuest({ wsl, sleep }, transport, environment.marker, signal)
      const manifest = await deps.environmentManifests.pinned(environment.manifest_id)
      await provisionGuest(
        transport,
        manifest.kind === 'available' ? manifest.manifest : null,
        descriptor,
        signal
      )
      await checkGpu(transport, descriptor, seen, signal, own)
    },
    async pull(
      record: PersistedOperation,
      onProgress: (progress: ManagedProgress) => void,
      signal: AbortSignal
    ): Promise<void> {
      const descriptor = await pinnedDescriptor(deps.descriptors, record)
      const image = descriptor.image[GUEST_PLATFORM]
      const transport = await ownTransport()
      const label = 'Downloading the engine image'
      onProgress({ label, completed: 0, total: descriptor.download_bytes, unit: 'bytes' })
      // Inside the guest, through its own socket: the Engine API never leaves the distribution (D4).
      await pullImageWithCurl(image, {
        run: (argv, call) => transport.exec(argv, { user: GUEST_ROOT, ...call }),
        signal,
        knownTotalBytes: descriptor.download_bytes,
        verify: guestDocker(transport),
        onProgress: (progress) =>
          onProgress({ label, completed: progress.current, total: progress.total, unit: 'bytes' }),
      })
    },

    async verify(record: PersistedOperation): Promise<void> {
      const target = record.machine.operation.target
      if (target.kind === 'environment') {
        const seen = await look()
        const docker = seen.guest?.facts.docker
        if (docker === undefined || !docker.daemon_reachable || !docker.gpu_runtime) {
          throw blocked(
            'Docker in the Atomic Chat distribution does not answer with a GPU runtime.',
            'docker-unreachable'
          )
        }
        return
      }
      const descriptor = await pinnedDescriptor(deps.descriptors, record)
      const image = descriptor.image[GUEST_PLATFORM]
      const transport = await ownTransport()
      if (!(await imagePresent(transport, image))) {
        throw new AtomicCoreError(
          'MANAGED_IDENTITY_MISMATCH',
          'The engine image in the Atomic Chat distribution does not carry the digest the descriptor pins.',
          `${image.repository}@${image.digest}`
        )
      }
    },

    unloadResident: async () => undefined,

    async activate(record: PersistedOperation): Promise<void> {
      const target = record.machine.operation.target
      if (target.kind !== 'runtime') return
      const descriptor = await pinnedDescriptor(deps.descriptors, record)
      const probeImage = descriptor.probe_image[GUEST_PLATFORM]
      const previous = await deps.installations.read(target.installation_id)
      const ownsProbe =
        record.owned_resource_ids.includes(ownedImageId(probeImage)) ||
        previous?.probe_image?.digest === probeImage.digest
      const installation: InstallationRecord = {
        schema_version: 1,
        installation: {
          installation_id: target.installation_id,
          engine_id: target.engine_id,
          environment_id: record.machine.operation.environment_id,
          active_descriptor_id: descriptor.descriptor_id,
          candidate_descriptor_id: null,
          availability: 'supported',
          status: 'ready',
        },
        image: descriptor.image[GUEST_PLATFORM],
        ...(ownsProbe ? { probe_image: probeImage } : {}),
        platform: GUEST_PLATFORM,
        installed_at: now().toISOString(),
      }
      await deps.installations.write(installation)
    },

    async remove(record: PersistedOperation): Promise<void> {
      const target = record.machine.operation.target
      if (target.kind !== 'runtime') return notYet('remove the environment')
      const existing = await deps.installations.read(target.installation_id)
      // As on Linux: a loaded model first, its container confirmed stopped; loads held off till the end.
      const hold = await unload(target.engine_id)
      try {
        const environment = await deps.records.read()
        if (environment !== null) {
          const docker = guestDocker(wsl.distribution(environment.distribution.name))
          for (const container of deps.journal
            .list()
            .filter((entry) => entry.engine_id === target.engine_id)) {
            const stopped = await stopContainer(docker, container.container_id, STOP_TIMEOUT_SECONDS)
            if (!stopped.confirmed) {
              throw new AtomicCoreError(
                'MANAGED_STOP_UNCONFIRMED',
                'A container of this engine could not be confirmed stopped, so nothing was removed.',
                `${container.container_id}: ${stopped.reason}`
              )
            }
            await removeContainer(docker, container.container_id)
            await deps.journal.remove(container.container_id)
          }
          if (existing !== null) {
            if (existing.installation.status !== 'removing') {
              await deps.installations.write({
                ...existing,
                installation: { ...existing.installation, status: 'removing' },
              })
            }
            if ((await containersUsingImage(docker, existing.image)).length === 0)
              await removeImage(docker, existing.image)
            const probe = existing.probe_image
            if (probe !== undefined) {
              const others = (await deps.installations.list()).filter(
                (entry) =>
                  entry.installation.installation_id !== target.installation_id &&
                  entry.probe_image?.digest === probe.digest
              )
              if (others.length === 0 && (await containersUsingImage(docker, probe)).length === 0) {
                await removeImage(docker, probe)
              }
            }
          }
        }
        const descriptorId = existing?.installation.active_descriptor_id ?? null
        if (descriptorId !== null) await deps.removeEngineCaches(descriptorId)
        if (record.request.retain_models === false) await deps.removeModels(target.engine_id)
        await deps.installations.remove(target.installation_id)
      } finally {
        hold.release?.()
      }
    },
    cleanup: async () => undefined,
    inventory,
  }
}
