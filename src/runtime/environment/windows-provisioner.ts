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
import { AtomicCoreError } from '../../contracts/index.js'
import type {
  ManagedAvailability,
  ManagedBlocker,
  PlatformImage,
  RequirementPlan,
  RuntimeDescriptor,
  Sha256Digest,
  WindowsEnvironmentManifest,
} from '../../contracts/index.js'
import { inspectImage, type DockerExec } from '../container/index.js'
import type { WslDistributionTransport } from '../wsl/index.js'
import { canonicalDigest } from './canonical-json.js'
import type { RuntimeDescriptorProvider } from './descriptor-provider.js'
import type { EnvironmentManifestProvider } from './environment-manifest-provider.js'
import { GUEST_DOCKER, GUEST_ROOT, guestLinuxHost, probeGuestExtras, type GuestExtras } from './guest-host.js'
import type { InstallationStore } from './installations.js'
import { imageMatchesDigest, type HostRecipeBinding, type HostView } from './linux-provisioner.js'
import { probeLinux, type LinuxFacts } from './linux-probe.js'
import { descriptorForProbe } from './provisioner-descriptors.js'
import type { EffectInventory } from './recovery.js'
import type { EnvironmentProvisioner, HostStepVerdict, ProvisionerProbe } from './service.js'
import type { PersistedOperation } from './store.js'
import type { WindowsEnvironmentRecord } from './windows-environment-record.js'
import {
  ATOMIC_CHAT_DISTRIBUTION,
  distributionDirectory,
  distributionDisk,
  type WindowsHost,
} from './windows-host.js'
import { assessWindowsHost, type WindowsBlocker } from './windows-plan.js'
import { probeWindowsHost, type WindowsHostFacts, type WslDistribution } from './windows-probe.js'

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
  installations: InstallationStore
  environmentId: string
  onAssessment?: (view: HostView) => void
  newId?: () => string
  now?: () => Date
}

const ZERO_DIGEST: Sha256Digest = `sha256:${'0'.repeat(64)}`
/** Checkpoints at which part or all of the engine image is already in the guest's layer store. */
const PULL_PHASES: readonly string[] = ['pulling-image', 'verifying', 'activating']
/** The only platform a Windows guest runs (the manifest's rootfs is x86_64). */
const GUEST_PLATFORM = 'linux/amd64'

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
  void newId
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
    return { plan, host_step: null, image_present: present }
  }

  const notYet = (what: string): never => {
    throw new AtomicCoreError(
      'MANAGED_PREREQUISITE_BLOCKED',
      `Managed runtimes on Windows cannot ${what} in this build yet.`
    )
  }

  const inventory: EffectInventory = {
    inspect: async () => ({ kind: 'absent' }),
    needsRelogin: async () => false,
    needsReboot: async () => false,
    verifyCompletedSteps: async () => [],
    currentPlanDigest: async (record) =>
      (await setupProbe(record).catch(() => null))?.plan.plan_digest ?? null,
  }

  return {
    probe: (record) => setupProbe(record),
    verifyHostStep: async (): Promise<HostStepVerdict> => notYet('verify a privileged step'),
    prepare: async () => notYet('prepare the environment'),
    pull: async () => notYet('pull the engine image'),
    verify: async () => notYet('verify the installation'),
    unloadResident: async () => undefined,
    activate: async () => notYet('activate an installation'),
    remove: async () => notYet('remove an installation'),
    cleanup: async () => undefined,
    inventory,
  }
}
